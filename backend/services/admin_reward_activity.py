"""Read the reward ledger and legacy account history as one paginated feed."""
import re
from datetime import date, datetime, time, timedelta, timezone

from database.db import reward_transactions, users

IST = timezone(timedelta(hours=5, minutes=30))
CATEGORIES = {
    "daily_login": r"daily[_ -]?(login|reward|bonus)|daily (login |sign-in )?bonus",
    "match_completed": r"match[_ -]?(completed|reward)|completed .*match",
    "purchase": r"purchas|shop[_ -]?unlock",
    "achievement": r"achiev",
    "adjustment": r"adjust|admin[_ -]?credit",
}


def reward_date_bounds(start, end):
    bounds = {}
    if start:
        bounds["$gte"] = datetime.combine(date.fromisoformat(start), time.min, IST)
    if end:
        bounds["$lt"] = datetime.combine(date.fromisoformat(end) + timedelta(days=1), time.min, IST)
    if len(bounds) == 2 and bounds["$gte"] >= bounds["$lt"]:
        raise ValueError("End date precedes start date")
    return bounds


def _convert(field, target):
    return {"$convert": {"input": field, "to": target, "onError": None, "onNull": None}}


def _text(field):
    return {"$ifNull": [_convert(field, "string"), ""]}


def _category(field, fallback):
    return {"$switch": {
        "branches": [
            {"case": {"$regexMatch": {"input": _text(field), "regex": pattern, "options": "i"}}, "then": label}
            for label, pattern in CATEGORIES.items()
        ],
        "default": fallback,
    }}


def _honour_change():
    # Legacy descriptions sometimes contain the change while the numeric field is zero.
    return {"$let": {
        "vars": {
            "amounts": [_convert(f"${field}", "long") for field in (
                "honour_delta", "honour_awarded", "honour_change", "honour",
            )],
            "description_amount": {"$regexFind": {
                "input": _text("$description"),
                "regex": r"(?:^|[;,.]\s*)\s*([+-]\d+)\s+Honour\b",
                "options": "i",
            }},
        },
        "in": {"$ifNull": [
            {"$arrayElemAt": [{"$filter": {
                "input": "$$amounts", "cond": {"$and": [
                    {"$ne": ["$$this", None]}, {"$ne": ["$$this", 0]},
                ]},
            }}, 0]},
            _convert({"$arrayElemAt": ["$$description_amount.captures", 0]}, "long"),
            {"$cond": [{"$in": [0, "$$amounts"]}, 0, None]},
        ]},
    }}


def _embedded_history(user_ids):
    return [
        {"$match": {"_id": {"$in": user_ids}}},
        {"$project": {"entries": {"$concatArrays": [
            {"$map": {
                "input": {"$cond": [{"$isArray": f"$rewards.{field}"}, f"$rewards.{field}", []]},
                "in": {"$cond": [
                    {"$eq": [{"$type": "$$this"}, "object"]},
                    {"$mergeObjects": [{"type": category}, "$$this"]},
                    None,
                ]},
            }}
            for field, category in (("activity", "other"), ("purchase_history", "purchase"), ("adjustments", "adjustment"))
        ]}}},
        {"$unwind": {"path": "$entries", "includeArrayIndex": "entry_index"}},
        {"$match": {"entries": {"$ne": None}}},
        {"$replaceWith": {"$mergeObjects": ["$entries", {
            "player": {"$toString": "$_id"}, "source": 1, "record_key": {"$toString": "$entry_index"},
        }]}},
    ]


def _transaction_pipeline(user_ids):
    return [
        {"$match": {"$or": [{"user_id": {"$in": user_ids}}, {
            "user_id": None, "player_id": {"$in": user_ids},
        }]}},
        {"$set": {"player": {"$toString": {"$ifNull": ["$user_id", "$player_id"]}},
                  "source": 0, "record_key": {"$toString": "$_id"}}},
        {"$unionWith": {"coll": users.name, "pipeline": _embedded_history(user_ids)}},
        {"$set": {"category": _category("$type", _category("$description", "other")),
                  "created_at": _convert("$created_at", "date"),
                  "coins": _convert("$coins", "long"), "xp": _convert("$xp", "long"),
                  "honour": _honour_change()}},
        # The ledger and profile contain copies of the same claim or match credit.
        # Other entries keep their source identity, even when their text and amounts match.
        {"$set": {"event_key": {"$switch": {"branches": [
            {"case": {"$and": [{"$eq": ["$category", "daily_login"]}, {"$ne": [_text("$claim_id"), ""]}]},
             "then": ["claim", _text("$claim_id")]},
            {"case": {"$and": [{"$eq": ["$category", "match_completed"]}, {"$ne": [_text("$session_id"), ""]}]},
             "then": ["match", _text("$session_id")]},
        ], "default": ["$source", "$record_key"]}}}},
        {"$sort": {"source": 1, "record_key": 1}},
        {"$group": {"_id": {"player": "$player", "event": "$event_key"}, "row": {"$first": "$$ROOT"}}},
        {"$replaceWith": "$row"},
    ]


def _player_totals_stage():
    return {"$group": {
        "_id": "$player",
        "transactions": {"$sum": 1},
        "coins_distributed": {"$sum": {"$cond": [{"$gt": ["$coins", 0]}, "$coins", 0]}},
        "coins_spent": {"$sum": {"$cond": [{"$lt": ["$coins", 0]}, {"$multiply": ["$coins", -1]}, 0]}},
        "xp_awarded": {"$sum": {"$cond": [{"$gt": ["$xp", 0]}, "$xp", 0]}},
        "honour_earned": {"$sum": {"$cond": [{"$gt": ["$honour", 0]}, "$honour", 0]}},
    }}


def load_reward_player_totals(user_ids):
    return {row["_id"]: {key: value for key, value in row.items() if key != "_id"}
            for row in reward_transactions.aggregate(
                [*_transaction_pipeline(user_ids), _player_totals_stage()], allowDiskUse=True,
            )}


def load_reward_activity(user_ids, player_scope, matching_players, search, category, dates, page, limit):
    match = {}
    if player_scope is not None:
        match["player"] = player_scope
    if search:
        match["$or"] = [
            {"player": {"$in": matching_players}},
            {"description": {"$regex": re.escape(search), "$options": "i"}},
        ]
    if category != "all":
        match["category"] = category
    if dates:
        match["created_at"] = dates

    feed = [{"$match": match}, {"$sort": {"created_at": -1, "player": 1, "source": 1, "record_key": 1}}]
    summary = [_player_totals_stage(),
        {"$group": {
            "_id": None, **{key: {"$sum": f"${key}"} for key in ("coins_distributed", "coins_spent", "xp_awarded")},
            "recipients": {"$sum": {"$cond": [{"$or": [
                {"$gt": ["$coins_distributed", 0]}, {"$gt": ["$xp_awarded", 0]}, {"$gt": ["$honour_earned", 0]},
            ]}, 1, 0]}},
        }},
        {"$unset": "_id"},
    ]
    pipeline = _transaction_pipeline(user_ids)

    def fetch_page(number):
        return next(reward_transactions.aggregate([*pipeline, {"$facet": {
            "summary": summary,
            "total": [{"$match": match}, {"$count": "value"}],
            "rows": [*feed, {"$skip": (number - 1) * limit}, {"$limit": limit}],
        }}], allowDiskUse=True))

    result = fetch_page(page)
    total = result["total"][0]["value"] if result["total"] else 0
    pages = max(1, (total + limit - 1) // limit)
    if page > pages:
        page = pages
        result = fetch_page(page)
    totals = dict.fromkeys(("coins_distributed", "coins_spent", "xp_awarded", "recipients"), 0)
    totals.update(result["summary"][0] if result["summary"] else {})
    return result["rows"], totals, total, page, pages

