"""Persist known player events without exposing request or audit payloads."""

from datetime import datetime, timezone
from hashlib import sha256
import logging

from bson import ObjectId
from pymongo.errors import DuplicateKeyError, PyMongoError

from database.db import player_notifications, users

logger = logging.getLogger(__name__)
OPTIONAL_CATEGORIES = {"matches": "Match results", "rewards": "Rewards and achievements", "announcements": "Platform announcements"}
EVENTS = {
    "suspicious_login": ("security", "Sign-in needs attention", "Repeated sign-in verification failures were recorded.", "security"),
    "password_changed": ("security", "Password changed", "Your SecureFPS password was updated.", "security"),
    "mfa_changed": ("security", "Two-factor authentication updated", "An administrator reset your authenticator settings.", "security"),
    "recovery_codes_rotated": ("security", "Recovery codes replaced", "New single-use recovery codes were issued after verification.", "security"),
    "account_suspended": ("account", "Account suspended", "Your player account has been suspended.", "fairplay"),
    "account_banned": ("account", "Account restricted", "Your player account has been banned.", "fairplay"),
    "player_warning": ("account", "Account warning", "An administrator recorded a warning for your account.", "security"),
    "appeal_approved": ("account", "Appeal approved", "Your appeal was approved and your account access was restored.", "fairplay"),
    "appeal_rejected": ("account", "Appeal reviewed", "Your appeal was reviewed and the restriction remains in place.", "fairplay"),
    "support_reply": ("account", "Support replied", "Open your support ticket history to read the reply.", "support"),
    "review_completed": ("account", "Match review completed", "A moderator reviewed your match. Open Fair Play to see the decision.", "fairplay"),
    "match_result": ("matches", "Multiplayer result available", "Your verified match result is available in match history.", "matches"),
    "match_reward": ("rewards", "Match rewards credited", "Your verified match rewards have been added to your account.", "rewards"),
    "daily_reward": ("rewards", "Daily reward claimed", "Your daily reward is recorded in your rewards history.", "rewards"),
    "achievement_earned": ("rewards", "Achievement earned", "An earned achievement is now available in your rewards profile.", "rewards"),
    "lockdown_enabled": ("announcements", "Platform admissions paused", "New multiplayer admissions have been paused.", "games"),
    "lockdown_disabled": ("announcements", "Platform admissions resumed", "New multiplayer admissions have been restored.", "games"),
}
LEGACY_TYPES = {"warning": "player_warning", "admin_warning": "player_warning"}
CATEGORIES = ("security", "account", "matches", "rewards", "announcements")


def notify_player(user_id, event, event_id):
    category, title, message, destination = EVENTS[event]
    if not ObjectId.is_valid(user_id):
        return
    user_id = ObjectId(user_id)
    event_key = sha256(f"{event}:{event_id}".encode()).hexdigest()
    try:
        if category in OPTIONAL_CATEGORIES:
            user = users.find_one({"_id": user_id}, {"notification_preferences": 1}) or {}
            if (user.get("notification_preferences") or {}).get(category) is False:
                return
        player_notifications.update_one({"user_id": user_id, "event_key": event_key}, {"$setOnInsert": {
            "type": event, "category": category, "title": title, "message": message,
            "destination": destination, "read": False, "created_at": datetime.now(timezone.utc),
        }}, upsert=True)
    except DuplicateKeyError:
        pass
    except PyMongoError:
        logger.exception("Player notification could not be stored (%s)", event)


def category_filter(category):
    legacy = [event for event, entry in EVENTS.items() if entry[0] == category]
    legacy.extend(alias for alias, event in LEGACY_TYPES.items() if event in legacy)
    filters = [{"category": category}, {"category": {"$exists": False}, "type": {"$in": legacy}}]
    if category == "account":
        filters.append({"category": {"$exists": False}, "type": {"$nin": [*EVENTS, *LEGACY_TYPES]}})
    return {"$or": filters}


def serialize_notification(note):
    event = note.get("type", "info")
    if not isinstance(event, str):
        event = "info"
    category, title, message, destination = EVENTS.get(
        LEGACY_TYPES.get(event, event), ("account", "Account notification", "", None)
    )
    created = note.get("created_at")
    return {
        "id": str(note["_id"]), "type": event, "category": category,
        "title": title, "message": message, "destination": destination,
        "read": bool(note.get("read", note.get("is_read", False))),
        "created_at": (created.replace(tzinfo=created.tzinfo or timezone.utc).isoformat() if isinstance(created, datetime) else None),
    }
