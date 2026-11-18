from datetime import datetime, timezone

from database.db import game_sessions, reward_transactions, users


def apply_match_credit(match):
    """Apply the server-recorded credit at most once, even after an interrupted retry."""
    credit = match.get("reward_credit")
    if not credit or credit.get("status") == "credited":
        return
    user_id = match["user_id"]
    session_id = match["session_id"]
    entry = {**credit["transaction"], "session_id": session_id}
    try:
        update = users.update_one(
            {"_id": user_id, "rewards.activity.session_id": {"$ne": session_id}},
            {
                "$inc": {"rewards.coins": entry["coins"], "rewards.xp": entry["xp"]},
                "$push": {"rewards.activity": entry},
            },
        )
        if not update.matched_count and not users.find_one(
            {"_id": user_id, "rewards.activity.session_id": session_id}, {"_id": 1}
        ):
            raise LookupError("Player account unavailable")
        reward_transactions.update_one(
            {"_id": match["_id"]}, {"$setOnInsert": {**entry, "user_id": user_id}}, upsert=True,
        )
    except Exception:
        game_sessions.update_one(
            {"_id": match["_id"], "reward_credit.status": {"$ne": "credited"}},
            {"$set": {"reward_credit.status": "failed"}},
        )
        raise
    game_sessions.update_one(
        {"_id": match["_id"]},
        {"$set": {"reward_credit.status": "credited", "reward_credit.credited_at": datetime.now(timezone.utc)}},
    )


def record_match_credit(user_id, session_id, transaction):
    credit = {"status": "pending", "transaction": transaction}
    match = game_sessions.find_one_and_update(
        {"user_id": user_id, "session_id": session_id, "reward_credit": {"$exists": False}},
        {"$set": {"reward_credit": credit}},
    )
    if match:
        apply_match_credit({**match, "reward_credit": credit})
