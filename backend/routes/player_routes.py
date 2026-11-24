from services.risk_scoring import clamp_risk_score, classify_risk_score
import base64
import binascii
import io
import json
import logging
import re
import uuid
from pathlib import Path
from datetime import datetime, timezone, timedelta
from flask import Blueprint, jsonify, request, session, Response
from bson import ObjectId
from PIL import Image
import bcrypt

from services.reward_catalog import reward_catalog
from services.combat_statistics import (
    group_telemetry_by_session,
    resolve_match_combat_stats,
    summarize_combat_stats,
)
from database.db import (
    game_events,
    game_sessions,
    game_telemetry,
    users,
    matches,
    security_events,
    login_history,
    sessions_db,
    support_tickets,
    reward_transactions,
    ban_appeals,
    player_notifications,
    honour_history,
)
from services.player_notifications import CATEGORIES, OPTIONAL_CATEGORIES, category_filter, notify_player, serialize_notification
from services.csrf import verify_csrf_and_origin
from routes.auth_routes import parse_client_device

REWARDS_XP_PER_LEVEL = 250


def format_login_entry(item):
    browser = item.get("browser")
    browser_icon = item.get("browser_icon")
    os_name = item.get("os")
    device = item.get("device")
    if not browser or not os_name:
        parsed = parse_client_device(item.get("user_agent") or item.get("device") or "")
        browser = browser or parsed["browser"]
        browser_icon = browser_icon or parsed["browser_icon"]
        os_name = os_name or parsed["os"]
        device = device or parsed["device"]

    ip_raw = item.get("ip_address", item.get("ip", "Unknown"))
    ip_display = ip_raw
    if ip_raw in {"127.0.0.1", "localhost", "::1"}:
        ip_display = "127.0.0.1 (Localhost)"

    return {
        "timestamp": item["created_at"].isoformat() if item.get("created_at") else None,
        "ip_address": ip_display,
        "raw_ip": ip_raw,
        "authentication_method": item.get("authentication_method", "password+mfa"),
        "success": item.get("status") == "success" or item.get("type") == "login_success",
        "browser": browser or "Unknown",
        "browser_icon": browser_icon or "🌐",
        "os": os_name or "Unknown",
        "device": device or f"{browser} ({os_name})",
    }

ACHIEVEMENTS = [
    {"id": "first_blood", "name": "First Blood", "desc": "Score your first enemy elimination", "reward_xp": 50, "reward_coins": 20},
    {"id": "sharpshooter", "name": "Sharpshooter", "desc": "Achieve 50%+ weapon accuracy in a match", "reward_xp": 100, "reward_coins": 50},
    {"id": "headshot_specialist", "name": "Headshot Specialist", "desc": "Land 5 headshot eliminations in a single match", "reward_xp": 150, "reward_coins": 75},
    {"id": "match_winner", "name": "Match Winner", "desc": "Emerge victorious in a competitive combat match", "reward_xp": 100, "reward_coins": 50},
    {"id": "tactical_survivor", "name": "Tactical Survivor", "desc": "Complete a full match with zero operator deaths", "reward_xp": 200, "reward_coins": 100},
    {"id": "training_specialist", "name": "Training Specialist", "desc": "Score 10+ targets in the Target Practice course", "reward_xp": 75, "reward_coins": 30},
    {"id": "multiplayer_champion", "name": "Multiplayer Champion", "desc": "Win a synchronized 3D multiplayer match", "reward_xp": 250, "reward_coins": 150},
    {"id": "consistent_player", "name": "Consistent Player", "desc": "Maintain a 3-day daily login streak", "reward_xp": 150, "reward_coins": 60},
    {"id": "honourable_operator", "name": "Honourable Operator", "desc": "Maintain a perfect 100 Honour Score across 3+ matches", "reward_xp": 200, "reward_coins": 100},
]

# Keep the stored keys stable for existing profiles and reward ownership.
DEFAULT_PROFILE_AVATAR = "chibi-male-1"
DEFAULT_PROFILE_BANNER = "sakura"
FREE_PROFILE_BANNERS = {"sakura", "frontline", "dawn", "neon"}
PROFILE_AVATARS = {
    "chibi-male-1": {"name": "Chibi Version 1", "reward_item": "skin_cyber_ninja", "free": True},
    "chibi-male-2": {"name": "Chibi Version 2", "reward_item": "skin_tactical_vanguard", "free": True},
    "chibi-female-1": {"name": "Chibi Version 3", "reward_item": "skin_neon_valkyrie", "free": True},
    "chibi-female-2": {"name": "Chibi Version 4", "reward_item": "skin_phantom_ghost", "free": True},
    "valkyrie-void": {"name": "Valkyrie Void", "reward_item": "skin_valkyrie_void"},
    "ghost-specops": {"name": "Ghost Spec-Ops", "reward_item": "skin_ghost_specops"},
    "celestial-sovereign": {"name": "Celestial Sovereign", "reward_item": "skin_celestial_sovereign"},
}


def avatar_option(key):
    return {"key": key, "name": PROFILE_AVATARS[key]["name"], "src": f"/public/avatars/{key}.png"}


def profile_avatar(customization, *, include_legacy=False):
    key = customization.get("avatar")
    if isinstance(key, str) and key in PROFILE_AVATARS:
        return avatar_option(key)
    src = customization.get("avatar_url")
    if isinstance(src, str) and re.fullmatch(r"/(?:api/media/avatars/[a-zA-Z0-9_-]+\.webp|public/cosmetics/avatar-[0-9]+\.png)", src):
        return {"key": key if isinstance(key, str) and key else "custom", "name": "Profile avatar", "src": src}
    legacy = customization.get("avatar_image")
    if include_legacy and isinstance(legacy, str) and re.fullmatch(r"data:image/(?:jpeg|png|webp);base64,[a-zA-Z0-9+/=]+", legacy):
        return {"key": "custom", "name": "Custom avatar", "src": legacy}
    return avatar_option(DEFAULT_PROFILE_AVATAR)


REWARD_STORE = {
    # ==========================================
    # ★ 1,000 COIN MYTHIC MASTERPIECES ★
    # ==========================================
    "skin_celestial_sovereign": {
        "name": "Celestial Sovereign",
        "description": "★ MYTHIC MASTERPIECE ★ Transcendent cyber-deity operator in royal purple & gold filigree armor with an amethyst halo and cosmic stardust aura.",
        "price": 1000,
        "icon": "👑",
        "category": "avatar",
        "masterpiece": True,
    },
    "banner_nebula_eternity": {
        "name": "Nebula Eternity",
        "description": "★ MYTHIC MASTERPIECE ★ Majestic floating cosmic citadel suspended in a swirling deep purple and gold galaxy nebula with violet plasma energy spires.",
        "price": 1000,
        "icon": "🌌",
        "category": "banner",
        "banner_key": "nebula-eternity",
        "preview": "public/backgrounds/nebula-eternity.jpg",
        "masterpiece": True,
    },

    # ==========================================
    # 1. EXCLUSIVE OPERATOR AVATARS (Equippable)
    # ==========================================
    "skin_valkyrie_void": {
        "name": "Valkyrie Void Avatar",
        "description": "High-tech cyberpunk operative with glowing violet visor and sleek ballistic armor.",
        "price": 220,
        "icon": "⚡",
        "category": "avatar",
    },
    "skin_ghost_specops": {
        "name": "Ghost Spec-Ops Avatar",
        "description": "Stealth operative with dual-lens violet night-vision optics and carbon-weave armor.",
        "price": 200,
        "icon": "🥷",
        "category": "avatar",
    },
    "skin_neon_valkyrie": {
        "name": "Neon Valkyrie Chibi",
        "description": "Cute chibi tactical specialist with high-contrast violet sensory headset.",
        "price": 150,
        "icon": "💜",
        "category": "avatar",
    },
    "skin_cyber_ninja": {
        "name": "Cyber Infiltrator Chibi",
        "description": "Covert tactical operative wrapped in reinforced carbon-violet weave.",
        "price": 140,
        "icon": "🗡️",
        "category": "avatar",
    },
    "skin_phantom_ghost": {
        "name": "Phantom Recon Chibi",
        "description": "Long-range marksman operative with dark tactical cloak and sensor array.",
        "price": 160,
        "icon": "🔮",
        "category": "avatar",
    },
    "skin_tactical_vanguard": {
        "name": "Tactical Vanguard Chibi",
        "description": "Frontline combat specialist equipped with heavy alloy purple plate carrier.",
        "price": 130,
        "icon": "🛡️",
        "category": "avatar",
    },

    # ==========================================
    # 2. PANORAMIC SCENE BANNERS (Equippable)
    # ==========================================
    "banner_cyber_metropolis": {
        "name": "Cyber Metropolis Banner",
        "description": "Breathtaking cyberpunk city skyline with purple neon skyscrapers and rain reflections.",
        "price": 180,
        "icon": "🌆",
        "category": "banner",
        "banner_key": "cyber-metropolis",
        "preview": "public/backgrounds/cyber-metropolis.jpg",
    },
    "banner_orbital_bastion": {
        "name": "Orbital Bastion Banner",
        "description": "Space defense fortress overlooking Earth with glowing violet ion energy barriers.",
        "price": 200,
        "icon": "🛰️",
        "category": "banner",
        "banner_key": "orbital-bastion",
        "preview": "public/backgrounds/orbital-bastion.jpg",
    },
    "banner_cosmic_cherry": {
        "name": "Cosmic Blossom Banner",
        "description": "Ethereal violet blossom sanctuary beneath a celestial full moon.",
        "price": 150,
        "icon": "🌸",
        "category": "banner",
        "banner_key": "sakura",
        "preview": "public/backgrounds/cosmic-cherry-blossom.jpg",
    },
    "banner_sakura_neon": {
        "name": "Sakura Neon Cyber Banner",
        "description": "Cyberpunk neon alleyway with electric purple signs and reflective puddles.",
        "price": 140,
        "icon": "💜",
        "category": "banner",
        "banner_key": "neon",
        "preview": "public/backgrounds/sakura-neon.jpg",
    },
    "banner_command_center": {
        "name": "Command Ops Center Banner",
        "description": "High-tech anti-cheat operations room with multi-screen telemetry feeds.",
        "price": 160,
        "icon": "🖥️",
        "category": "banner",
        "banner_key": "command-center",
        "preview": "public/backgrounds/command-center.jpg",
    },
    "banner_battlefield": {
        "name": "Frontline Battlefield Banner",
        "description": "Dynamic frontline battlefield with armored units and tactical HUD elements.",
        "price": 150,
        "icon": "🚁",
        "category": "banner",
        "banner_key": "battlefield",
        "preview": "public/backgrounds/battlefield.jpg",
    },
    "banner_sakura_dawn": {
        "name": "Purple Dawn Skyline Banner",
        "description": "Misty mountain peaks under an electric purple sunrise.",
        "price": 120,
        "icon": "🌄",
        "category": "banner",
        "banner_key": "dawn",
        "preview": "public/backgrounds/sakura-dawn.jpg",
    },
    "banner_sakura_frontline": {
        "name": "Combat Outpost Banner",
        "description": "Reinforced military forward operating base under dusk skies.",
        "price": 100,
        "icon": "⚔️",
        "category": "banner",
        "banner_key": "frontline",
        "preview": "public/backgrounds/sakura-frontline.jpg",
    },

    # Preserved legacy items (hidden from store UI per user request)
    "camo_purple_damascus": {"name": "Purple Damascus Camo", "description": "Folded-steel weapon skin.", "price": 220, "icon": "✨", "category": "weapon", "hidden": True},
    "tactical_comp": {"name": "Recoil Compensator", "description": "High-efficiency muzzle brake.", "price": 150, "icon": "🎯", "category": "perk", "hidden": True},
    "combat_booster": {"name": "+25% XP Combat Protocol", "description": "Bonus XP booster.", "price": 120, "icon": "⚡", "category": "perk", "hidden": True},
    "extended_mag": {"name": "Tactical Extended Mags", "description": "High-capacity magazines.", "price": 180, "icon": "📦", "category": "perk", "hidden": True},
    "guardian_badge": {"name": "Guardian badge", "description": "A shield badge for your player profile.", "price": 100, "icon": "⬡", "category": "badge", "hidden": True},
    "marksman_badge": {"name": "Marksman badge", "description": "A reticle badge for your player profile.", "price": 180, "icon": "◎", "category": "badge", "hidden": True},
    "elite_badge": {"name": "Elite sentinel badge", "description": "A premium SecureFPS profile badge.", "price": 300, "icon": "✦", "category": "badge", "hidden": True},
    "stealth_camo": {"name": "Night-Stalker Operator Camo", "description": "Matte-black stealth tactical uniform.", "price": 250, "icon": "🥷", "category": "perk", "hidden": True},
}

for avatar_key, entry in PROFILE_AVATARS.items():
    if reward_item := entry.get("reward_item"):
        REWARD_STORE[reward_item].update(avatar_key=avatar_key, preview=avatar_option(avatar_key)["src"])


UPLOADS_DIR = Path(__file__).resolve().parents[1] / "uploads"
AVATARS_DIR = UPLOADS_DIR / "avatars"
BANNERS_DIR = UPLOADS_DIR / "banners"
AVATARS_DIR.mkdir(parents=True, exist_ok=True)
BANNERS_DIR.mkdir(parents=True, exist_ok=True)

player_bp = Blueprint("player", __name__, url_prefix="/api/player")
logger = logging.getLogger(__name__)


def process_and_save_webp(base64_data, category="avatars"):
    """
    Decodes base64 image data, resizes to WebP (256x256 for avatars, 1200x300 for banners),
    and saves to backend/uploads/<category>/<uuid>.webp.
    Returns relative URL: /api/media/<category>/<filename>.
    """
    header, encoded = base64_data.split(",", 1)
    raw_bytes = base64.b64decode(encoded)
    img = Image.open(io.BytesIO(raw_bytes))
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
    else:
        img = img.convert("RGB")

    target_size = (256, 256) if category == "avatars" else (1200, 300)
    img = img.resize(target_size, Image.Resampling.LANCZOS)
    filename = f"{uuid.uuid4().hex}.webp"
    save_path = (AVATARS_DIR if category == "avatars" else BANNERS_DIR) / filename
    img.save(save_path, "WEBP", quality=85)
    return f"/api/media/{category}/{filename}"


def current_user():
    return session.get("user_id")


def get_user_role():
    user_id = current_user()
    if not user_id:
        return None
    try:
        user = users.find_one({"_id": ObjectId(user_id)})
    except Exception:
        user = None
    if user:
        return user.get("role") or session.get("user_role") or "player"
    return session.get("user_role") or "player"


@player_bp.before_request
def check_player_access():
    if request.method == "OPTIONS":
        return None

    # CSRF check on state-changing requests
    csrf_err = verify_csrf_and_origin(request)
    if csrf_err:
        return jsonify({"message": csrf_err}), 403

    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    try:
        user = users.find_one({"_id": ObjectId(user_id)})
    except Exception:
        user = None

    if not user:
        return jsonify({"message": "Player account not found."}), 404

    role = user.get("role") or session.get("user_role") or "player"
    if role not in ("player", "demo_player"):
        return jsonify({"message": "Player access required."}), 403

    acc_status = user.get("account_status") or ("suspended" if user.get("revoked") else "active")
    if acc_status == "deleted":
        session.clear()
        return jsonify({"message": "This account has been deleted."}), 403

    # If banned or suspended, allow reading status, profile, appeals, and notifications
    # but block gameplay/store purchases/profile mutations
    if acc_status in {"banned", "suspended"}:
        allowed_paths = {
            "/api/player/profile",
            "/api/player/account-status",
            "/api/player/appeal",
            "/api/player/notifications",
        }
        if request.path not in allowed_paths:
            return jsonify({
                "message": f"Your account is currently {acc_status}. Gameplay and store actions are disabled.",
                "account_status": acc_status,
                "ban_reason": user.get("ban_reason", "Security policy enforcement"),
                "suspended_until": user.get("suspended_until").isoformat() if user.get("suspended_until") else None,
                "can_appeal": True
            }), 403


@player_bp.get("/profile")
def get_profile():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user = users.find_one({"_id": ObjectId(user_id)}, {"password_hash": 0, "mfa_secret": 0})
    if not user:
        return jsonify({"message": "User not found."}), 404

    acc_status = user.get("account_status") or ("suspended" if user.get("revoked") else "active")

    # Fetch pending appeal if any
    pending_appeal = ban_appeals.find_one({"user_id": user["_id"], "status": "pending"})

    created_at_val = user.get("created_at")
    if not created_at_val and "_id" in user and hasattr(user["_id"], "generation_time"):
        created_at_val = user["_id"].generation_time
        try:
            users.update_one({"_id": user["_id"]}, {"$set": {"created_at": created_at_val}})
        except Exception:
            pass

    customization = user.get("profile_customization") or {"avatar": DEFAULT_PROFILE_AVATAR, "banner": DEFAULT_PROFILE_BANNER}
    migrated = False
    if customization.get("avatar") not in PROFILE_AVATARS and customization.get("avatar") not in {"custom"}:
        customization = {**customization, "avatar": DEFAULT_PROFILE_AVATAR, "avatar_url": None, "avatar_image": None}
        users.update_one(
            {"_id": user["_id"]},
            {"$set": {"profile_customization.avatar": DEFAULT_PROFILE_AVATAR,
                      "profile_customization.avatar_url": None,
                      "profile_customization.avatar_image": None}},
        )
    if customization.get("banner") not in FREE_PROFILE_BANNERS:
        customization = {**customization, "banner": DEFAULT_PROFILE_BANNER, "banner_url": None, "banner_image": None}
        users.update_one(
            {"_id": user["_id"]},
            {"$set": {"profile_customization.banner": DEFAULT_PROFILE_BANNER,
                      "profile_customization.banner_url": None,
                      "profile_customization.banner_image": None}},
        )
    selected_avatar = profile_avatar(customization, include_legacy=True)
    owned = set((user.get("rewards") or {}).get("owned_items") or [])
    avatars = [
        avatar_option(key) for key, entry in PROFILE_AVATARS.items()
        if key in (DEFAULT_PROFILE_AVATAR, selected_avatar["key"]) or entry.get("free") or entry.get("reward_item") in owned
    ]
    if selected_avatar["key"] not in PROFILE_AVATARS:
        avatars.append(selected_avatar)

    return jsonify({
        "id": str(user["_id"]),
        "name": user["name"],
        "email": user["email"],
        "mfa_enabled": user.get("mfa_enabled", False),
        "account_status": acc_status,
        "ban_reason": user.get("ban_reason"),
        "suspended_until": user["suspended_until"].isoformat() if user.get("suspended_until") else None,
        "can_appeal": acc_status in {"banned", "suspended"},
        "has_pending_appeal": bool(pending_appeal),
        "honour_score": user.get("honour_score", 100),
        "created_at": created_at_val.isoformat() if created_at_val and hasattr(created_at_val, "isoformat") else (str(created_at_val) if created_at_val else None),
        "profile_customization": {**customization, "avatar": selected_avatar["key"]},
        "avatar": selected_avatar,
        "avatar_options": avatars,
    })


@player_bp.put("/profile/customization")
def update_profile_customization():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    data = request.get_json(silent=True) or {}
    avatar = data.get("avatar")
    banner = data.get("banner")
    avatar_image = data.get("avatar_image") or None
    banner_image = data.get("banner_image") or None
    allowed_avatars = PROFILE_AVATARS.keys() | {"custom"}
    allowed_banners = {"default-banner", "sakura", "frontline", "dawn", "neon", "custom"}

    if avatar_image:
        avatar = "custom"
    if banner_image:
        banner = "custom"

    user_doc = users.find_one({"_id": ObjectId(user_id)}) or {}
    existing_custom = user_doc.get("profile_customization") or {}
    owned_items = set((user_doc.get("rewards") or {}).get("owned_items") or [])
    avatar_entry = PROFILE_AVATARS.get(avatar)
    if avatar_entry and not avatar_entry.get("free") and avatar_entry.get("reward_item") not in owned_items:
        return jsonify({"message": "Choose an avatar that you own."}), 403
    if not isinstance(avatar, str) or not isinstance(banner, str) or (
        avatar not in allowed_avatars and avatar != existing_custom.get("avatar")
    ) or (
        banner not in allowed_banners and banner != existing_custom.get("banner")
    ):
        return jsonify({"message": "Choose an available avatar and banner."}), 400

    def valid_image_data(value):
        if value is None:
            return True
        if not isinstance(value, str) or len(value) > 720_000:
            return False
        try:
            header, encoded = value.split(",", 1)
            if header not in {"data:image/jpeg;base64", "data:image/png;base64", "data:image/webp;base64"}:
                return False
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            return False
        if len(raw) > 512_000:
            return False
        signatures = {
            "data:image/jpeg;base64": raw.startswith(b"\xff\xd8\xff"),
            "data:image/png;base64": raw.startswith(b"\x89PNG\r\n\x1a\n"),
            "data:image/webp;base64": len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP",
        }
        return signatures.get(header, False)

    if not valid_image_data(avatar_image) or not valid_image_data(banner_image):
        return jsonify({"message": "Upload a valid JPG, PNG, or WebP image under 512 KB."}), 400

    avatar_url = existing_custom.get("avatar_url") if avatar == existing_custom.get("avatar") else None
    banner_url = existing_custom.get("banner_url") if banner == existing_custom.get("banner") else None

    # Resize and store as WebP
    if avatar_image:
        try:
            avatar_url = process_and_save_webp(avatar_image, category="avatars")
        except Exception as exc:
            return jsonify({"message": f"Could not process avatar image: {exc}"}), 400

    if banner_image:
        try:
            banner_url = process_and_save_webp(banner_image, category="banners")
        except Exception as exc:
            return jsonify({"message": f"Could not process banner image: {exc}"}), 400

    customization = {
        "avatar": avatar,
        "banner": banner,
        "avatar_url": avatar_url,
        "banner_url": banner_url,
    }
    result = users.update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {"profile_customization": customization}},
    )
    if not result.matched_count:
        return jsonify({"message": "Player account not found."}), 404
    return jsonify({"message": "Profile appearance saved.", "profile_customization": customization, "avatar": profile_avatar(customization)})

@player_bp.get("/stats")
def get_player_stats():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user_oid = ObjectId(user_id)
    player = users.find_one({"_id": user_oid}) or {}

    user_id_candidates = [user_oid, str(user_oid)]
    player_id_filter = {"$or": [
        {"user_id": {"$in": user_id_candidates}},
        {"player_id": {"$in": user_id_candidates}},
    ]}
    completed_sessions = list(game_sessions.find({
        "$and": [player_id_filter, {"status": "completed"}]
    }))
    completed_legacy = list(matches.find(player_id_filter))
    known_session_ids = {
        row.get("session_id") for row in completed_sessions + completed_legacy
        if row.get("session_id")
    }
    completed_legacy = [
        row for row in completed_legacy
        if not row.get("session_id") or row["session_id"] not in {
            item.get("session_id") for item in completed_sessions
        }
    ]
    completion_events = list(game_telemetry.find({
        "$and": [player_id_filter, {"event_type": "game_completed"}]
    }).sort("created_at", -1))
    analyses_by_session = {
        row.get("session_id"): row
        for row in game_events.find({
            "user_id": {"$in": user_id_candidates},
            "analysis_type": "game_session",
        })
        if row.get("session_id")
    }
    for completion_event in completion_events:
        sid = completion_event.get("session_id")
        if not sid or sid in known_session_ids:
            continue
        known_session_ids.add(sid)
        telemetry = completion_event.get("telemetry") or {}
        raw = (analyses_by_session.get(sid) or {}).get("raw_features") or {}
        completed_sessions.append({
            "session_id": sid, "user_id": user_oid, "status": "completed",
            "kills": telemetry.get("kills", raw.get("kills")),
            "deaths": telemetry.get("deaths", raw.get("deaths")),
            "shots_fired": telemetry.get("shots", raw.get("shots")),
            "shots_hit": telemetry.get("hits", raw.get("hits")),
            "accuracy": telemetry.get("accuracy", raw.get("accuracy")),
            "kdr": telemetry.get("kdr", raw.get("kdr")),
            "headshots": telemetry.get("headshots", raw.get("headshots")),
            "winner": telemetry.get("winner", raw.get("winner")),
            "created_at": completion_event.get("created_at"),
            "started_at": completion_event.get("created_at"),
        })
    session_ids = [
        row.get("session_id") for row in completed_sessions + completed_legacy
        if row.get("session_id")
    ]
    telemetry_events = list(game_telemetry.find(
        {
            "$or": [
                {"user_id": {"$in": user_id_candidates}},
                {"player_id": {"$in": user_id_candidates}},
            ],
            "session_id": {"$in": session_ids},
            "event_type": {"$in": ["enemy_killed", "player_death", "weapon_fire", "enemy_hit", "game_completed"]},
        },
        {"session_id": 1, "event_type": 1, "telemetry": 1},
    )) if session_ids else []
    totals, _ = summarize_combat_stats(
        completed_sessions + completed_legacy,
        group_telemetry_by_session(telemetry_events),
    )
    total_kills = totals["kills"]
    total_deaths = totals["deaths"]
    total_shots = totals["shots_fired"]
    total_hits = totals["shots_hit"]
    kdr = totals["kdr"]
    overall_accuracy = totals["accuracy"]

    total_matches = len(completed_sessions) + len(completed_legacy)
    verified = [match for match in completed_sessions if match.get("stats_source") == "multiplayer_server"]
    wins = sum(match.get("result") == "win" for match in verified)
    losses = sum(match.get("result") == "loss" for match in verified)
    draws = sum(match.get("result") == "draw" for match in verified)

    total_seconds = 0
    for s in completed_sessions:
        st = s.get("started_at")
        en = s.get("ended_at")
        if s.get("stats_source") == "multiplayer_server":
            total_seconds += s.get("duration_seconds", 0)
        elif st and en:
            try:
                diff = int((en - st).total_seconds())
                total_seconds += max(0, diff)
            except Exception:
                pass

    rewards = player.get("rewards") or {}
    coins = int(rewards.get("coins", 0))
    xp = int(rewards.get("xp", 0))
    level = 1 + xp // REWARDS_XP_PER_LEVEL
    xp_progress = xp % REWARDS_XP_PER_LEVEL

    latest_analysis = game_events.find_one(
        {"user_id": {"$in": [user_oid, str(user_oid)]}, "analysis_type": "game_session", "status": "success"},
        sort=[("created_at", -1)]
    ) or {}
    risk_score = latest_analysis.get("risk_score")
    risk_category = latest_analysis.get("risk_category") or (classify_risk_score(risk_score)["category"] if risk_score is not None else "Normal")

    return jsonify({
        "total_matches": total_matches,
        "wins": wins,
        "losses": losses,
        "draws": draws,
        "verified_matches": len(verified),
        "win_rate": round(100 * wins / len(verified), 1) if verified else None,
        "assists": sum(match.get("assists", 0) for match in verified) if verified else None,
        "headshots": totals["headshots"],
        "headshots_coverage": totals["headshots_coverage"],
        "headshot_percentage": totals["headshot_percentage"],
        "kills": total_kills,
        "deaths": total_deaths,
        "kdr": kdr,
        "accuracy": overall_accuracy,
        "shots_fired": total_shots,
        "shots_hit": total_hits,
        "shots_fired_coverage": totals["shots_fired_coverage"],
        "shots_hit_coverage": totals["shots_hit_coverage"],
        "total_playtime_seconds": total_seconds,
        "honour_score": player.get("honour_score", 100),
        "coins": coins,
        "xp": xp,
        "level": level,
        "xp_progress": xp_progress,
        "latest_risk_score": risk_score,
        "latest_risk_category": risk_category
    })


@player_bp.post("/sessions/revoke-others")
def revoke_other_sessions():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user_oid = ObjectId(user_id)
    current_record_id = session.get("auth_session_record_id")

    query = {"user_id": user_oid, "is_active": True}
    if current_record_id:
        try:
            query["_id"] = {"$ne": ObjectId(current_record_id)}
        except Exception:
            pass

    res = sessions_db.update_many(query, {"$set": {"is_active": False, "revoked_at": datetime.now(timezone.utc)}})
    return jsonify({
        "success": True,
        "message": f"Successfully revoked {res.modified_count} other active session(s).",
        "revoked_count": res.modified_count
    }), 200


@player_bp.get("/matches")
def get_matches():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    player_account = users.find_one(
        {"_id": user_oid},
        {"hacker_profile": 1, "account_type": 1},
    ) or {}
    player_ids = [user_oid, str(user_oid)]
    player_id_filter = {"$or": [
        {"user_id": {"$in": player_ids}},
        {"player_id": {"$in": player_ids}},
    ]}
    session_filter = {"$and": [player_id_filter, {"status": "completed"}]}
    player_matches = list(game_sessions.find(session_filter).sort("started_at", -1))
    legacy_matches = list(matches.find(player_id_filter).sort("created_at", -1))
    known_ids = {row.get("session_id") for row in player_matches if row.get("session_id")}
    player_matches.extend(
        row for row in legacy_matches
        if not row.get("session_id") or row.get("session_id") not in known_ids
    )
    known_ids.update(row.get("session_id") for row in legacy_matches if row.get("session_id"))
    completion_events = list(game_telemetry.find({
        "$and": [player_id_filter, {"event_type": "game_completed"}]
    }).sort("created_at", -1))
    for event in completion_events:
        sid = event.get("session_id")
        if not sid or sid in known_ids:
            continue
        known_ids.add(sid)
        telemetry = event.get("telemetry") or {}
        player_matches.append({
            "session_id": sid, "user_id": event.get("user_id"), "status": "completed",
            "game": event.get("game", "CyberStrike 3D"),
            "kills": telemetry.get("kills"), "deaths": telemetry.get("deaths"),
            "shots_fired": telemetry.get("shots"), "shots_hit": telemetry.get("hits"),
            "accuracy": telemetry.get("accuracy"), "headshots": telemetry.get("headshots"),
            "kdr": telemetry.get("kdr"), "winner": telemetry.get("winner"),
            "created_at": event.get("created_at"), "started_at": event.get("created_at"),
        })
    analyses = {}
    for item in game_events.find({
        "user_id": {"$in": player_ids}, "analysis_type": "game_session"
    }).sort("created_at", -1):
        sid = item.get("session_id")
        if sid:
            analyses.setdefault(sid, item)
    total_matches = len(player_matches)
    result_matches = []
    for game_session in player_matches:
        session_id = game_session.get("session_id", "")
        analysis = analyses.get(session_id, {})
        result = analysis.get("result") or {}
        raw = analysis.get("raw_features") or {}
        started_at = game_session.get("started_at") or game_session.get("created_at")
        ended_at = game_session.get("ended_at")
        duration = None
        if game_session.get("duration") is not None and int(game_session.get("duration", 0)) > 0:
            duration = int(game_session.get("duration"))
        elif started_at and ended_at:
            if started_at.tzinfo is None and ended_at.tzinfo is not None:
                started_at = started_at.replace(tzinfo=ended_at.tzinfo)
            elif ended_at.tzinfo is None and started_at.tzinfo is not None:
                ended_at = ended_at.replace(tzinfo=started_at.tzinfo)
            duration = max(0, int((ended_at - started_at).total_seconds()))
        telemetry_events = list(game_telemetry.find(
            {
                "$or": [
                    {"user_id": {"$in": player_ids}},
                    {"player_id": {"$in": player_ids}},
                ],
                "session_id": session_id,
                "event_type": {"$in": ["enemy_killed", "player_death", "weapon_fire", "enemy_hit", "game_completed"]},
            },
            {"event_type": 1},
        )) if session_id else []
        combat = resolve_match_combat_stats(game_session, telemetry_events)
        kills = combat["kills"]
        deaths = combat["deaths"]
        auth_created = analysis.get("created_at")
        raw_score = analysis.get("risk_score", result.get("risk_score"))
        if raw_score is None and game_session.get("risk_score") is not None:
            raw_score = game_session.get("risk_score")
        clamped_score = clamp_risk_score(raw_score)
        human_evaluation = analysis.get("human_evaluation") or {}
        if not human_evaluation.get("hard_cheat_evidence"):
            clamped_score = min(clamped_score if clamped_score is not None else 0.0, 39.0)
        classification = classify_risk_score(clamped_score)

        result_matches.append({
            "id": session_id,
            "session_id": session_id,
            "match_id": f"#{session_id}" if str(session_id).isdigit() else (session_id[:8] if session_id else str(game_session.get("_id", ""))[-8:]),
            "analysis_id": str(analysis.get("_id", "")),
            "model_version": analysis.get("model_version", "v1.2-ensemble-rf-iso"),
            "date": started_at.isoformat() if started_at else None,
            "duration": duration,
            "game": (game_session.get("game") or "CyberStrike 3D").replace("_", " "),
            "status": game_session.get("status", "unknown"),
            "weapon": game_session.get("weapon") or "P-24 Carbine",
            "kills": kills,
            "deaths": deaths,
            "shots_fired": combat["shots_fired"],
            "shots_hit": combat["shots_hit"],
            "kd": combat["kdr"],
            "honour_awarded": game_session.get("honour_awarded"),
            "accuracy": combat["accuracy"],
            "headshots": combat["headshots"],
            "headshot_ratio": combat["headshots"] / combat["shots_hit"]
            if combat["headshots"] is not None and combat["shots_hit"] else raw.get("headshot_ratio"),
            "risk_score": clamped_score,
            "risk_category": classification["category"],
            "risk_meaning": classification["meaning"],
            "risk_action": classification["action"],
            "human_evaluation": analysis.get("human_evaluation") or {},
            "reward_credit": game_session.get("reward_credit") or {},
            "random_forest": result.get("random_forest") or analysis.get("random_forest", "normal"),
            "random_forest_probability": result.get("random_forest_probability"),
            "isolation_forest": result.get("isolation_forest") or analysis.get("isolation_forest", "anomaly"),
            "isolation_forest_anomaly_score": result.get("isolation_forest_anomaly_score"),
            "detection_result": analysis.get("enforcement_action") or "none",
            "analysis_status": analysis.get("status") or game_session.get("analysis_status") or "completed",
            "analysis_timestamp": auth_created.isoformat() if auth_created else None,
            "missing_features": analysis.get("missing_features", []),
            "analysis_error": analysis.get("error"),
            "alert_severity": classification["severity"],
            "enforcement_action": analysis.get("enforcement_action") or game_session.get("enforcement_action") or "none",
            "enforcement_state": analysis.get("enforcement_state") or game_session.get("enforcement_state") or "monitoring",
            "hacker_profile": player_account.get("hacker_profile"),
            "demo_test": player_account.get("account_type") == "demo_test",
        })

    return jsonify({
        "matches": result_matches,
        "total_matches": total_matches,
    })


@player_bp.get("/leaderboard")
def get_leaderboard():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    risk_by_user = {
        item["_id"]: item.get("average_risk")
        for item in game_events.aggregate([
            {"$match": {"analysis_type": "game_session", "risk_score": {"$type": "number"}}},
            {"$group": {"_id": "$user_id", "average_risk": {"$avg": "$risk_score"}}},
        ])
    }

    disallowed_keywords = ("test", "demo", "soldier", "hacker", "bot", "dummy", "mock", "temp", "deleted", "operator")
    disallowed_domains = ("@example.com", "@test.com", "@test.lan", "@test.local", "@deleted.securefps.local", "@example.test")
    disallowed_prefixes = ("player_", "player", "mfa_", "lan_tester_", "test_")

    players = []
    user_cursor = users.find(
        {
            "$or": [
                {"role": {"$in": ["player", None, ""]}},
                {"role": {"$exists": False}},
                {"_id": ObjectId(user_id)}
            ],
            "account_status": {"$nin": ["suspended", "banned", "deleted"]}
        },
        {"name": 1, "email": 1, "role": 1, "account_status": 1, "is_demo": 1, "profile_customization.avatar": 1, "profile_customization.avatar_url": 1},
    )

    for user in user_cursor:
        is_cur_user = (str(user["_id"]) == str(user_id))
        name = str(user.get("name") or "").strip().lower()
        email = str(user.get("email") or "").strip().lower()

        # Filter out test, bot, and demo accounts from leaderboard
        if not is_cur_user:
            if user.get("is_demo") is True:
                continue
            if any(email.endswith(d) for d in disallowed_domains):
                continue
            if any(email.startswith(p) for p in disallowed_prefixes):
                continue
            if any(kw in name for kw in disallowed_keywords):
                continue

        user_id_candidates = [user["_id"], str(user["_id"])]
        completed_sessions = list(game_sessions.find({
            "$or": [{"user_id": {"$in": user_id_candidates}}, {"player_id": {"$in": user_id_candidates}}],
            "status": "completed"
        }))
        completed_legacy = list(matches.find({
            "$or": [{"user_id": {"$in": user_id_candidates}}, {"player_id": {"$in": user_id_candidates}}]
        }))
        known_session_ids = {row.get("session_id") for row in completed_sessions if row.get("session_id")}
        completed_legacy = [
            row for row in completed_legacy
            if not row.get("session_id") or row["session_id"] not in known_session_ids
        ]
        for row in completed_legacy:
            if row.get("session_id"):
                known_session_ids.add(row["session_id"])

        analysis_by_session = {
            item.get("session_id"): item
            for item in game_events.find({
                "user_id": {"$in": user_id_candidates}, "analysis_type": "game_session"
            })
            if item.get("session_id")
        }
        for cmpl in game_telemetry.find({
            "$or": [
                {"user_id": {"$in": user_id_candidates}},
                {"player_id": {"$in": user_id_candidates}},
            ], "event_type": "game_completed"
        }).sort("created_at", -1):
            sid = cmpl.get("session_id")
            if not sid or sid in known_session_ids:
                continue
            known_session_ids.add(sid)
            raw_f = (analysis_by_session.get(sid) or {}).get("raw_features") or {}
            cmpl_t = cmpl.get("telemetry") or {}
            completed_sessions.append({
                "session_id": sid,
                "user_id": user["_id"],
                "status": "completed",
                "kills": cmpl_t.get("kills", raw_f.get("kills")),
                "deaths": cmpl_t.get("deaths", raw_f.get("deaths")),
                "shots": cmpl_t.get("shots", raw_f.get("shots")),
                "hits": cmpl_t.get("hits", raw_f.get("hits")),
                "accuracy": cmpl_t.get("accuracy", raw_f.get("accuracy")),
                "kdr": cmpl_t.get("kdr", raw_f.get("kdr")),
                "winner": cmpl_t.get("winner", raw_f.get("winner")),
                "created_at": cmpl.get("created_at"),
                "started_at": cmpl.get("created_at")
            })

        session_ids = [item.get("session_id") for item in completed_sessions if item.get("session_id")]
        
        total_kills = 0
        total_deaths = 0
        accuracy_values = []
        for cs in completed_sessions:
            sid = cs.get("session_id")
            event_owner = {"$or": [{"user_id": {"$in": user_id_candidates}}, {"player_id": {"$in": user_id_candidates}}]}
            telem_k = game_telemetry.count_documents({"$and": [event_owner, {"session_id": sid, "event_type": "enemy_killed"}]}) if sid else 0
            telem_d = game_telemetry.count_documents({"$and": [event_owner, {"session_id": sid, "event_type": "player_death"}]}) if sid else 0
            
            cmpl_telem = game_telemetry.find_one({"$and": [event_owner, {"session_id": sid, "event_type": "game_completed"}]}) if sid else None
            cmpl_k = int(cmpl_telem.get("telemetry", {}).get("kills") or 0) if cmpl_telem else 0
            cmpl_d = int(cmpl_telem.get("telemetry", {}).get("deaths") or 0) if cmpl_telem else 0

            raw_k = 0
            raw_d = 0
            if sid:
                evt = game_events.find_one({"user_id": {"$in": user_id_candidates}, "session_id": sid, "analysis_type": "game_session"}, {"raw_features": 1})
                if evt and evt.get("raw_features"):
                    raw_k = int(evt["raw_features"].get("kills") or 0)
                    raw_d = int(evt["raw_features"].get("deaths") or 0)
                    if evt["raw_features"].get("accuracy") is not None:
                        acc_f = float(evt["raw_features"]["accuracy"])
                        accuracy_values.append(acc_f * 100 if acc_f <= 1.0 else acc_f)

            s_k = max(int(cs.get("kills") or 0), telem_k, cmpl_k, raw_k)
            s_d = max(int(cs.get("deaths") or 0), telem_d, cmpl_d, raw_d)
            total_kills += s_k
            total_deaths += s_d
            
            acc = cs.get("accuracy")
            if acc is not None:
                acc_f = float(acc)
                accuracy_values.append(acc_f * 100 if acc_f <= 1.0 else acc_f)

        for cm in completed_legacy:
            total_kills += int(cm.get("kills") or 0)
            total_deaths += int(cm.get("deaths") or 0)
            if cm.get("accuracy") is not None:
                acc_f = float(cm.get("accuracy"))
                accuracy_values.append(acc_f * 100 if acc_f <= 1.0 else acc_f)

        if not accuracy_values and session_ids:
            for item in game_events.find(
                {"user_id": {"$in": user_id_candidates}, "analysis_type": "game_session", "session_id": {"$in": session_ids}},
                {"raw_features.accuracy": 1},
            ):
                rf_acc = item.get("raw_features", {}).get("accuracy")
                if rf_acc is not None:
                    acc_f = float(rf_acc)
                    accuracy_values.append(acc_f * 100 if acc_f <= 1.0 else acc_f)

        matches_played = len(completed_sessions) + len(completed_legacy)
        kd = round(total_kills / max(total_deaths, 1), 2)
        accuracy = round((sum(accuracy_values) / len(accuracy_values)), 1) if accuracy_values else None
        performance = round((total_kills * 3) + (kd * 10) + ((accuracy or 0) * 0.25), 1)
        players.append({
            "id": str(user["_id"]),
            "name": user.get("name", "Player"),
            "avatar": profile_avatar(user.get("profile_customization") or {}),
            "matches": matches_played,
            "kills": total_kills,
            "deaths": total_deaths,
            "kd": kd,
            "accuracy": accuracy,
            "performance": performance,
            "average_risk": round(float(risk_by_user.get(user["_id"], 0) or 0), 1),
        })

    # Keep genuine players with match history, or include the currently logged in genuine user
    current_id = str(user_id)
    players = [
        item for item in players
        if item["matches"] > 0 or item["id"] == current_id
    ]
    players.sort(key=lambda item: (-item["kills"], -item["kd"], -(item["accuracy"] or 0), item["name"].lower()))
    for rank, player in enumerate(players, start=1):
        player["rank"] = rank

    current_player = next((item for item in players if item["id"] == current_id), None)
    return jsonify({
        "leaderboard": players[:10],
        "current_player": current_player,
        "total_ranked": len(players),
    })


@player_bp.get("/rewards")
def get_rewards():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user_oid = ObjectId(user_id)
    user = users.find_one({"_id": user_oid}, {"rewards": 1, "profile_customization": 1, "honour_score": 1}) or {}
    rewards = user.get("rewards") or {}
    total_matches = game_sessions.count_documents({"user_id": user_oid, "status": "completed"}) + matches.count_documents({"user_id": user_oid})
    total_kills = game_telemetry.count_documents({"user_id": user_oid, "event_type": "enemy_killed"})
    transactions = list(reward_transactions.find({"user_id": user_oid}).sort("created_at", -1).limit(30))
    transactions.extend(rewards.get("purchase_history") or [])
    credited_sessions = {row.get("session_id") for row in transactions if row.get("type") == "match_completed"}
    activity = rewards.get("activity") or []
    transactions.extend(row for row in activity if row.get("session_id") not in credited_sessions)
    credited_sessions.update(row.get("session_id") for row in activity)
    transactions.extend(rewards.get("adjustments") or [])
    transactions.sort(key=lambda row: row["created_at"].isoformat() if row.get("created_at") else "", reverse=True)
    transactions = transactions[:30]
    catalog = reward_catalog(REWARD_STORE)
    appearance = user.get("profile_customization") or {}
    slots = {}
    for key in rewards.get("owned_items") or []:
        item = catalog.get(key, {})
        category = item.get("category")
        if category in {"avatar", "banner"} and (
            key == appearance.get(category)
            or (item.get(f"{category}_key") and item[f"{category}_key"] == appearance.get(category))
        ):
            slots[category] = key
    unlocked = rewards.get("unlocked_achievements") or [
        "first_blood" if total_kills > 0 else None,
        "consistent_player" if int(rewards.get("daily_streak", 0)) >= 3 else None,
        "honourable_operator" if int(user.get("honour_score", 100)) == 100 and total_matches >= 3 else None,
    ]
    for achievement in ACHIEVEMENTS:
        if achievement["id"] in unlocked:
            notify_player(user_oid, "achievement_earned", achievement["id"])
    return jsonify({
        "coins": int(rewards.get("coins", 0)),
        "xp": int(rewards.get("xp", 0)),
        "level": int(rewards.get("xp", 0)) // REWARDS_XP_PER_LEVEL + 1,
        "xp_per_level": REWARDS_XP_PER_LEVEL,
        "daily_streak": int(rewards.get("daily_streak", 0)),
        "last_daily_login": rewards.get("last_daily_login"),
        "owned_items": rewards.get("owned_items", []),
        "equipped_item": rewards.get("equipped_item"),
        "equipped_slots": slots,
        "match_processing": [
            {
                "session_id": row.get("session_id"), "status": row.get("status"),
                "game": row.get("game"), "analysis_status": row.get("analysis_status"),
                "reward_status": "credited" if row.get("session_id") in credited_sessions else (row.get("reward_credit") or {}).get("status"),
                "ended_at": row["ended_at"].isoformat() if row.get("ended_at") else None,
                "kills": row.get("kills"), "deaths": row.get("deaths"), "accuracy": row.get("accuracy"),
            }
            for row in game_sessions.find(
                {"user_id": user_oid, "status": {"$in": ["completed", "active", "processing"]}},
                {"session_id": 1, "status": 1, "game": 1, "reward_credit.status": 1, "analysis_status": 1,
                 "ended_at": 1, "kills": 1, "deaths": 1, "accuracy": 1},
            ).sort("started_at", -1).limit(8)
        ],
        "achievements": [
            {
                "id": a["id"],
                "name": a["name"],
                "desc": a["desc"],
                "reward_xp": a["reward_xp"],
                "reward_coins": a["reward_coins"],
                "unlocked": a["id"] in unlocked
            }
            for a in ACHIEVEMENTS
        ],
        "store": [{"id": item_id, **item} for item_id, item in catalog.items() if item["available"] or item.get("pair") or item_id in (rewards.get("owned_items") or [])],
        "transactions": [{
            "type": item.get("type", "reward"),
            "description": item.get("description", "Reward earned"),
            "coins": item.get("coins", 0),
            "xp": item.get("xp", 0),
            "created_at": item["created_at"].isoformat() if item.get("created_at") else None,
        } for item in transactions],
    })


@player_bp.post("/rewards/claim-daily")
def claim_daily_reward():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user_oid = ObjectId(user_id)
    today = datetime.now(timezone.utc).date()
    today_key = today.isoformat()
    user = users.find_one({"_id": user_oid}, {"rewards": 1})
    if not user:
        return jsonify({"message": "User not found."}), 404
    rewards = user.get("rewards") or {}
    previous_key = rewards.get("last_daily_login")
    claim_id = f"daily:{user_oid}:{today_key}"

    def persist_claim(claim):
        reward_transactions.update_one(
            {"_id": claim_id},
            {"$setOnInsert": {**claim, "_id": claim_id, "user_id": user_oid}},
            upsert=True,
        )
        notify_player(user_oid, "daily_reward", claim_id)

    if previous_key == today_key:
        prior_claim = next(
            (row for row in rewards.get("activity", []) if row.get("claim_id") == claim_id),
            None,
        )
        if prior_claim:
            try:
                persist_claim(prior_claim)
            except Exception:
                logger.exception("Could not recover daily reward ledger entry for %s", user_oid)
                return jsonify({"message": "The claim is credited; its history entry is still pending. Retry safely."}), 503
        return jsonify({"claimed": False, "message": "Today's login reward is already claimed."})

    yesterday_key = (today - timedelta(days=1)).isoformat()
    streak = int(rewards.get("daily_streak", 0)) + 1 if previous_key == yesterday_key else 1
    claimed_at = datetime.now(timezone.utc)
    claim_record = {
        "claim_id": claim_id,
        "type": "daily_login",
        "description": "Daily login bonus",
        "coins": 25,
        "xp": 25,
        "daily_date": today_key,
        "created_at": claimed_at,
        "daily_streak": streak,
    }
    previous_date_filter = (
        {"rewards.last_daily_login": previous_key}
        if previous_key is not None
        else {"$or": [
            {"rewards.last_daily_login": None},
            {"rewards.last_daily_login": {"$exists": False}},
        ]}
    )
    result = users.update_one({"_id": user_oid, **previous_date_filter}, {
        "$inc": {"rewards.coins": 25, "rewards.xp": 25},
        "$set": {"rewards.last_daily_login": today_key, "rewards.daily_streak": streak},
        "$push": {"rewards.activity": claim_record},
    })
    if not result.modified_count:
        current = users.find_one({"_id": user_oid}, {"rewards": 1}) or {}
        current_rewards = current.get("rewards") or {}
        if current_rewards.get("last_daily_login") == today_key:
            prior_claim = next(
                (row for row in current_rewards.get("activity", []) if row.get("claim_id") == claim_id),
                None,
            )
            if prior_claim:
                try:
                    persist_claim(prior_claim)
                except Exception:
                    logger.exception("Could not recover daily reward ledger entry for %s", user_oid)
                    return jsonify({"message": "The claim is credited; its history entry is still pending. Retry safely."}), 503
            return jsonify({"claimed": False, "message": "Today's login reward is already claimed."})
        return jsonify({"message": "The reward claim could not be completed. Retry safely."}), 503

    try:
        persist_claim(claim_record)
    except Exception:
        logger.exception("Could not write daily reward ledger entry for %s", user_oid)
        return jsonify({"message": "The claim is credited; its history entry is still pending. Retry safely."}), 503
    updated = users.find_one({"_id": user_oid}, {"rewards.coins": 1, "rewards.xp": 1}) or {}
    updated_rewards = updated.get("rewards") or {}
    return jsonify({"claimed": True, "coins_earned": 25, "xp_earned": 25, "coins": updated_rewards.get("coins", 25), "xp": updated_rewards.get("xp", 25), "daily_streak": streak})


@player_bp.post("/rewards/purchase")
def purchase_reward_item():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"message": "Choose an item to buy."}), 400
    item_id = data.get("item_id")
    if not isinstance(item_id, str):
        return jsonify({"message": "That store item is not available."}), 404
    item = reward_catalog(REWARD_STORE).get(item_id)
    if not item or not item.get("available"):
        return jsonify({"message": "That store item is not available."}), 404
    if "price" in data and (type(data["price"]) is not int or data["price"] != item["price"]):
        return jsonify({"message": "The price changed. Refresh the shop and confirm again."}), 409
    purchase = {
        "item_id": item_id, "type": "purchase", "description": f"Purchased {item['name']}",
        "coins": -item["price"], "xp": 0, "created_at": datetime.now(timezone.utc),
    }
    user_oid = ObjectId(user_id)
    result = users.update_one(
        {"_id": user_oid, "rewards.coins": {"$gte": item["price"]}, "rewards.owned_items": {"$ne": item_id}},
        {"$inc": {"rewards.coins": -item["price"]}, "$addToSet": {"rewards.owned_items": item_id}, "$push": {"rewards.purchase_history": purchase}},
    )
    if not result.modified_count:
        user = users.find_one({"_id": user_oid}, {"rewards": 1}) or {}
        rewards = user.get("rewards") or {}
        if item_id in rewards.get("owned_items", []):
            return jsonify({"message": "You already own this item."}), 409
        return jsonify({"message": "You do not have enough coins for this item."}), 409
    return jsonify({"message": f"Purchased {item['name']}.", "item_id": item_id})


@player_bp.post("/rewards/equip")
def equip_reward_item():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or "item_id" not in data:
        return jsonify({"message": "Choose an item to equip."}), 400
    item_id = data["item_id"]
    catalog = reward_catalog(REWARD_STORE)
    if item_id is not None and (not isinstance(item_id, str) or item_id not in catalog):
        return jsonify({"message": "That store item is not available."}), 404
    user_oid = ObjectId(user_id)
    query = {"_id": user_oid}
    update = {"$unset": {"rewards.equipped_item": ""}}
    applied_avatar = None
    applied_banner = None
    artwork = None
    if item_id:
        item = catalog[item_id]
        query["rewards.owned_items"] = item_id
        update_set = {}
        category = item.get("category")
        if category in {"avatar", "banner"} and item.get("preview", "").startswith("/public/cosmetics/"):
            if not item["artwork_ready"]:
                return jsonify({"message": "Artwork is unavailable."}), 409
            artwork = item["preview"]
            update_set[f"profile_customization.{category}_url"] = artwork
            update_set[f"profile_customization.{category}"] = item_id
            applied_avatar = item_id if category == "avatar" else None
            applied_banner = item_id if category == "banner" else None
        elif category == "avatar" and item.get("avatar_key"):
            update_set["profile_customization.avatar_url"] = None
            update_set["profile_customization.avatar"] = item["avatar_key"]
            applied_avatar = item["avatar_key"]
        elif item.get("category") == "banner" and item.get("banner_key"):
            if item["banner_key"] == "battlefield":
                return jsonify({"message": "The arena banner is no longer available. Choose a Sakura banner."}), 409
            update_set["profile_customization.banner_url"] = None
            update_set["profile_customization.banner"] = item["banner_key"]
            applied_banner = item["banner_key"]
        else:
            update_set["rewards.equipped_item"] = item_id
        update = {"$set": update_set}
        if category in {"avatar", "banner"}:
            update["$unset"] = {f"profile_customization.{category}_image": ""}
    result = users.update_one(query, update)
    if not result.matched_count:
        return jsonify({"message": "Purchase this item before equipping it."}), 409
    return jsonify({
        "message": "Equipment updated successfully.",
        "equipped_item": item_id,
        "avatar": applied_avatar,
        "avatar_portrait": profile_avatar({"avatar": applied_avatar, "avatar_url": artwork}) if applied_avatar else None,
        "artwork": artwork,
        "banner": applied_banner
    })


@player_bp.route("/support/tickets", methods=["GET", "POST"])
def player_support_tickets():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user_oid = ObjectId(user_id)
    if request.method == "GET":
        tickets = list(support_tickets.find({"user_id": user_oid}).sort("created_at", -1).limit(30))
        return jsonify({"tickets": [{
            "id": str(ticket["_id"]),
            "category": ticket.get("category", "other"),
            "message": ticket.get("message", ""),
            "status": ticket.get("status", "open"),
            "admin_reply": ticket.get("admin_reply"),
            "attachment_name": (ticket.get("attachment") or {}).get("name"),
            "created_at": ticket["created_at"].isoformat() if ticket.get("created_at") else None,
            "replied_at": ticket["replied_at"].isoformat() if ticket.get("replied_at") else None,
        } for ticket in tickets]})

    data = request.get_json(silent=True) or {}
    category = data.get("category", "other")
    message = data.get("message", "")
    allowed_categories = {"account", "match", "security", "rewards", "other"}
    if not isinstance(category, str) or category not in allowed_categories or not isinstance(message, str) or not message.strip() or len(message) > 3000:
        return jsonify({"message": "Choose a topic and enter a message up to 3000 characters."}), 400
    message = message.strip()
    attachment_data = data.get("attachment")
    attachment = None
    if attachment_data is not None:
        if not isinstance(attachment_data, dict):
            return jsonify({"message": "Invalid attachment."}), 400
        mime = attachment_data.get("mime_type")
        data_url = attachment_data.get("data_url")
        name = str(attachment_data.get("name", "proof"))[:120]
        if not isinstance(mime, str) or mime not in {"image/png", "image/jpeg", "image/webp"} or not isinstance(data_url, str) or len(data_url) > 900_000:
            return jsonify({"message": "Attach a PNG, JPG, or WebP image up to 650 KB."}), 400
        try:
            header, encoded = data_url.split(",", 1)
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            return jsonify({"message": "The attachment could not be read."}), 400
        valid_header = header == f"data:{mime};base64"
        signatures = {"image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"), "image/jpeg": raw.startswith(b"\xff\xd8\xff"), "image/webp": len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"}
        if not valid_header or len(raw) > 650_000 or not signatures[mime]:
            return jsonify({"message": "The image must be a valid PNG, JPG, or WebP smaller than 650 KB."}), 400
        attachment = {"name": name, "mime_type": mime, "data_url": data_url}

    user = users.find_one({"_id": user_oid}, {"name": 1, "email": 1}) or {}
    ticket = {"user_id": user_oid, "player_name": user.get("name", "Player"), "player_email": user.get("email", ""), "category": category, "message": message, "attachment": attachment, "status": "open", "created_at": datetime.now(timezone.utc)}
    inserted = support_tickets.insert_one(ticket)
    try:
        from routes.game_routes import publish_live_update
        publish_live_update(user_oid, None, "support_ticket_created", force=True)
    except Exception:
        pass
    return jsonify({"message": "Your message was sent to admin.", "ticket_id": str(inserted.inserted_id)}), 201

@player_bp.get("/detections")
def get_detections():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    detections = list(security_events.find({"user_id": user_oid}).sort("created_at", -1).limit(50))

    return jsonify({
        "detections": [
            {
                "id": str(d["_id"]),
                "type": d.get("type", "unknown"),
                "severity": d.get("severity", "low"),
                "confidence": d.get("confidence", 0),
                "timestamp": d["created_at"].isoformat() if d.get("created_at") else None,
                "description": d.get("description", ""),
                "status": d.get("status", "detected"),
                "risk_score": d.get("risk_score"),
            }
            for d in detections
        ]
    })

@player_bp.get("/security")
def get_security_summary():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    user = users.find_one({"_id": user_oid}) or {}
    # Honour no longer pauses matchmaking; don't expose legacy cooldown timestamps.
    play_restricted_until = None
    recent_login = login_history.find_one(
        {"user_id": user_oid, "type": "login_success"},
        sort=[("created_at", -1)],
    )
    logins = list(login_history.find({"user_id": user_oid}).sort("created_at", -1).limit(50))
    warnings = list(security_events.find(
        {"user_id": user_oid, "$or": [{"type": "gameplay_alert_review", "action": "warn"}, {"type": "moderator_warning"}]}
    ).sort("created_at", -1).limit(10))
    active_sessions = list(sessions_db.find(
        {"user_id": user_oid, "is_active": True}
    ).sort("last_activity", -1).limit(20))
    latest_analysis = game_events.find_one(
        {"user_id": {"$in": [user_oid, str(user_oid)]}, "analysis_type": "game_session", "status": "success"},
        sort=[("created_at", -1)],
    ) or {}
    latest_result = latest_analysis.get("result") or {}
    risk_score = latest_analysis.get("risk_score", latest_result.get("risk_score"))

    email_name, _, email_domain = (user.get("email") or "").partition("@")
    return jsonify({
        "mfa_status": "enabled" if user.get("mfa_enabled") else "disabled",
        "recovery_email": f"{email_name[:1]}•••@{email_domain}" if user.get("email_verified") and email_domain else None,
        "account_status": user.get("account_status") or ("suspended" if user.get("revoked") else "active"),
        "honour_score": user.get("honour_score", 100),
        "play_restricted_until": play_restricted_until.isoformat()
            if play_restricted_until else None,
        "security_warnings": [
            {
                "note": item.get("note") or item.get("description") or "A security warning was recorded.",
                "created_at": item["created_at"].isoformat() if item.get("created_at") else None,
            }
            for item in warnings
        ],
        "risk_score": risk_score,
        "last_login": recent_login["created_at"].isoformat() if recent_login and recent_login.get("created_at") else None,
        "active_sessions": [
            {
                "ip_address": item.get("ip_address", item.get("ip", "Unknown")),
                "device": item.get("device", "Unknown device"),
                "id": str(item["_id"]),
                "is_current": str(item["_id"]) == session.get("auth_session_record_id"),
                "created_at": item["created_at"].isoformat() if item.get("created_at") else None,
                "last_activity": item.get("last_activity", item.get("created_at")).isoformat()
                    if item.get("last_activity", item.get("created_at")) else None,
            }
            for item in active_sessions
        ],
        "login_history": [
            format_login_entry(item)
            for item in logins
        ],
    })

@player_bp.get("/security-events")
def get_security_events():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    events = list(login_history.find({"user_id": user_oid}).sort("created_at", -1).limit(20))

    return jsonify({
        "events": [
            {
                "id": str(e["_id"]),
                "type": e.get("type", "login"),
                "timestamp": e["created_at"].isoformat(),
                "ip": e.get("ip", "Unknown"),
                "description": e.get("description", ""),
                "status": e.get("status", "success"),
            }
            for e in events
        ]
    })

@player_bp.get("/login-history")
def get_login_history():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    history = list(
        login_history.find({"user_id": user_oid}).sort("created_at", -1).limit(50)
    )
    return jsonify({
        "login_history": [
            format_login_entry(item)
            for item in history
        ]
    })

@player_bp.get("/sessions")
def get_active_sessions():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    active_sessions = list(sessions_db.find({"user_id": user_oid, "is_active": True}))

    return jsonify({
        "sessions": [
            {
                "id": str(s["_id"]),
                "ip": s.get("ip", "Unknown"),
                "device": s.get("device", "Unknown"),
                "created_at": s["created_at"].isoformat(),
                "last_activity": s.get("last_activity", s["created_at"]).isoformat(),
            }
            for s in active_sessions
        ]
    })

@player_bp.post("/sessions/<session_id>/revoke")
def revoke_session(session_id):
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    try:
        sid = ObjectId(session_id)
    except Exception:
        return jsonify({"message": "Invalid session id."}), 400

    user_oid = ObjectId(user_id)
    result = sessions_db.update_one(
        {"_id": sid, "user_id": user_oid},
        {"$set": {"is_active": False}}
    )

    if result.matched_count == 0:
        return jsonify({"message": "Session not found."}), 404

    return jsonify({"message": "Session revoked."})

@player_bp.get("/account-status")
def get_account_status():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user = users.find_one({"_id": ObjectId(user_id)})
    if not user:
        return jsonify({"message": "User not found."}), 404

    user_oid = ObjectId(user_id)
    recent_login = login_history.find_one(
        {"user_id": user_oid, "type": "login_success"},
        sort=[("created_at", -1)]
    )

    acc_status = user.get("account_status") or ("suspended" if user.get("revoked") else "active")
    pending_appeal = ban_appeals.find_one({"user_id": user_oid, "status": "pending"})

    created_at_val = user.get("created_at")
    if not created_at_val and "_id" in user and hasattr(user["_id"], "generation_time"):
        created_at_val = user["_id"].generation_time

    return jsonify({
        "mfa_enabled": user.get("mfa_enabled", False),
        "account_status": acc_status,
        "ban_reason": user.get("ban_reason"),
        "suspended_until": user["suspended_until"].isoformat() if user.get("suspended_until") else None,
        "can_appeal": acc_status in {"banned", "suspended"},
        "has_pending_appeal": bool(pending_appeal),
        "risk_score": user.get("risk_score", 0),
        "honour_score": user.get("honour_score", 100),
        "created_at": created_at_val.isoformat() if created_at_val and hasattr(created_at_val, "isoformat") else (str(created_at_val) if created_at_val else None),
        "last_login": recent_login["created_at"].isoformat() if recent_login else None,
        "active_sessions": sessions_db.count_documents({"user_id": user_oid, "is_active": True}),
    })


# =========================================================================
# BAN APPEAL FLOW (Item 4)
# =========================================================================

@player_bp.get("/appeal")
def get_appeal_status():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    latest_appeal = ban_appeals.find_one({"user_id": user_oid}, sort=[("created_at", -1)])

    if not latest_appeal:
        return jsonify({"has_appeal": False, "appeal": None})

    return jsonify({
        "has_appeal": True,
        "appeal": {
            "id": str(latest_appeal["_id"]),
            "status": latest_appeal.get("status", "pending"),
            "ban_reason": latest_appeal.get("ban_reason", ""),
            "appeal_text": latest_appeal.get("appeal_text", ""),
            "admin_note": latest_appeal.get("admin_note"),
            "created_at": latest_appeal["created_at"].isoformat() if latest_appeal.get("created_at") else None,
            "reviewed_at": latest_appeal["reviewed_at"].isoformat() if latest_appeal.get("reviewed_at") else None,
        }
    })


@player_bp.post("/appeal")
def submit_appeal():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    user = users.find_one({"_id": user_oid})
    if not user:
        return jsonify({"message": "User not found."}), 404

    acc_status = user.get("account_status") or ("suspended" if user.get("revoked") else "active")
    if acc_status not in {"banned", "suspended"}:
        return jsonify({"message": "Only suspended or banned accounts may submit an appeal."}), 400

    # Guard against duplicate pending appeals
    existing_pending = ban_appeals.find_one({"user_id": user_oid, "status": "pending"})
    if existing_pending:
        return jsonify({"message": "You already have an appeal under review by our security team."}), 400

    data = request.get_json(silent=True) or {}
    appeal_text = (data.get("appeal_text") or data.get("reason") or "").strip()
    if len(appeal_text) < 15:
        return jsonify({"message": "Please provide a detailed explanation (minimum 15 characters)."}), 400

    now = datetime.now(timezone.utc)
    ban_reason = user.get("ban_reason", "Security policy violation")

    res = ban_appeals.insert_one({
        "user_id": user_oid,
        "ban_reason": ban_reason,
        "appeal_text": appeal_text,
        "status": "pending",
        "created_at": now
    })

    security_events.insert_one({
        "type": "ban_appeal_submitted",
        "user_id": user_oid,
        "severity": "medium",
        "description": f"Ban appeal submitted by player ({user['email']})",
        "created_at": now
    })

    return jsonify({
        "success": True,
        "message": "Your appeal has been submitted successfully. A security administrator will review your case.",
        "appeal_id": str(res.inserted_id)
    }), 201


# =========================================================================
# NOTIFICATION CENTER (Item 14)
# =========================================================================

@player_bp.get("/activity")
def get_player_activity():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user_oid = ObjectId(user_id)
    category = request.args.get("category", "")
    if category not in ("", "matches", "rewards", "appearance", "security"):
        return jsonify({"message": "Invalid activity category."}), 400

    entries = []

    if category in ("", "matches"):
        match_filter = {"$or": [{"user_id": user_oid}, {"user_id": user_id}]}
        for row in game_sessions.find(match_filter).sort("ended_at", -1).limit(30):
            timestamp = row.get("ended_at") or row.get("started_at")
            if not isinstance(timestamp, datetime):
                continue
            entries.append({
                "category": "matches",
                "title": "Match completed",
                "message": f"{row.get('game') or 'FPS match'} · {row.get('kills', 0)} kills",
                "created_at": timestamp.isoformat(),
            })

    if category in ("", "rewards"):
        user = users.find_one({"_id": user_oid}, {"rewards.activity": 1}) or {}
        for row in (user.get("rewards") or {}).get("activity", []):
            timestamp = row.get("timestamp") or row.get("created_at")
            if isinstance(timestamp, datetime):
                entries.append({
                    "category": "rewards",
                    "title": row.get("title") or "Reward activity",
                    "message": row.get("description") or "Reward activity was recorded.",
                    "created_at": timestamp.isoformat(),
                })

    if category in ("", "security"):
        security_filter = {"$or": [{"user_id": user_oid}, {"user_id": user_id}]}
        for row in security_events.find(security_filter).sort("created_at", -1).limit(30):
            timestamp = row.get("created_at")
            if not isinstance(timestamp, datetime):
                continue
            entries.append({
                "category": "security",
                "title": row.get("type") or row.get("event") or "Security activity",
                "message": row.get("description") or "A security event was recorded.",
                "created_at": timestamp.isoformat(),
            })

    entries.sort(key=lambda item: item["created_at"], reverse=True)
    return jsonify({"activity": entries[:50]})

@player_bp.get("/notifications")
def get_notifications():
    user_oid = ObjectId(current_user())
    limit = max(1, min(request.args.get("limit", 20, type=int), 50))
    page = max(1, min(request.args.get("page", 1, type=int), 10000))
    category = request.args.get("category", "")
    status = request.args.get("status", "")
    if category not in ("", *CATEGORIES) or status not in ("", "unread"):
        return jsonify({"message": "Invalid notification filter."}), 400

    visible = {"user_id": user_oid, "dismissed_at": None}
    unread = {"$or": [{"read": False}, {"read": {"$exists": False}, "is_read": {"$ne": True}}]}
    filters = [visible]
    if category:
        filters.append(category_filter(category))
    if status == "unread":
        filters.append(unread)
    query = {"$and": filters}
    notes = list(player_notifications.find(query).sort([("created_at", -1), ("_id", -1)]).skip((page - 1) * limit).limit(limit))
    return jsonify({
        "notifications": [serialize_notification(note) for note in notes],
        "unread_count": player_notifications.count_documents({"$and": [visible, unread]}),
        "total": player_notifications.count_documents(query),
        "page": page,
        "limit": limit,
    })


@player_bp.post("/notifications/read")
def mark_notifications_read():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"message": "A notification action is required."}), 400
    action = data.get("action", "read")
    ids = data.get("notification_ids", [])
    mark_all = data.get("mark_all", False)
    if action not in ("read", "unread", "dismiss") or type(mark_all) is not bool or (
        mark_all and action != "read"
    ) or (not mark_all and (not isinstance(ids, list) or not 1 <= len(ids) <= 50 or any(
        not isinstance(item, str) or not ObjectId.is_valid(item) for item in ids
    ))):
        return jsonify({"message": "Invalid notification action or IDs."}), 400

    query = {"user_id": ObjectId(current_user()), "dismissed_at": None}
    if not mark_all:
        query["_id"] = {"$in": [ObjectId(item) for item in ids]}
    changes = {"dismissed_at": datetime.now(timezone.utc)} if action == "dismiss" else {"read": action == "read"}
    player_notifications.update_many(query, {"$set": changes})
    return jsonify({"success": True})


@player_bp.route("/notifications/preferences", methods=["GET", "PUT"])
def notification_preferences():
    user_oid = ObjectId(current_user())
    if request.method == "PUT":
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or not data or any(
            key not in OPTIONAL_CATEGORIES or type(value) is not bool for key, value in data.items()
        ):
            return jsonify({"message": "Only optional notification categories can be changed."}), 400
        users.update_one({"_id": user_oid}, {"$set": {f"notification_preferences.{key}": value for key, value in data.items()}})
    stored = (users.find_one({"_id": user_oid}, {"notification_preferences": 1}) or {}).get("notification_preferences") or {}
    return jsonify({"preferences": {key: stored.get(key) is not False for key in OPTIONAL_CATEGORIES}, "labels": OPTIONAL_CATEGORIES})


# =========================================================================
# MATCH DETAIL DRILL-DOWN (Item 14)
# =========================================================================

@player_bp.get("/matches/<session_id>")
def get_match_detail(session_id):
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    sess = game_sessions.find_one({"session_id": session_id, "user_id": user_oid})
    if not sess:
        # Check legacy matches
        try:
            m = matches.find_one({"_id": ObjectId(session_id), "user_id": user_oid})
        except Exception:
            m = None
        if not m:
            return jsonify({"message": "Match not found."}), 404
        legacy_session_id = m.get("session_id")
        legacy_events = list(game_telemetry.find(
            {
                "user_id": user_oid,
                "session_id": legacy_session_id,
                "event_type": {"$in": ["enemy_killed", "player_death", "weapon_fire", "enemy_hit"]},
            },
            {"event_type": 1},
        )) if legacy_session_id else []
        combat = resolve_match_combat_stats(m, legacy_events)

        return jsonify({
            "session_id": str(m["_id"]),
            "game": "FPS Microgame",
            "date": m.get("created_at").isoformat() if m.get("created_at") else None,
            "kills": combat["kills"],
            "deaths": combat["deaths"],
            "shots_fired": combat["shots_fired"],
            "shots_hit": combat["shots_hit"],
            "kdr": combat["kdr"],
            "accuracy": combat["accuracy"],
            "result": "Completed",
            "features": {},
            "timeline": []
        })

    # Fetch analysis features
    analysis = game_events.find_one({"session_id": session_id, "analysis_type": "game_session"}) or {}
    raw_feats = analysis.get("raw_features", {})

    # Fetch kill and death events for the combat timeline
    stats_events = list(game_telemetry.find(
        {
            "user_id": user_oid,
            "session_id": session_id,
            "event_type": {"$in": ["enemy_killed", "player_death", "weapon_fire", "enemy_hit"]},
        },
        {"event_type": 1},
    ))
    combat_events = list(game_telemetry.find(
        {
            "user_id": user_oid,
            "session_id": session_id,
            "event_type": {"$in": ["enemy_killed", "player_death", "weapon_fire", "enemy_hit"]},
        },
        {"event_type": 1, "data": 1, "timestamp": 1},
    ).sort("timestamp", 1).limit(100))
    combat = resolve_match_combat_stats(sess, stats_events)
    final_kills = combat["kills"]
    final_deaths = combat["deaths"]

    timeline = []
    for ev in combat_events:
        etype = ev.get("event_type")
        if etype == "enemy_killed":
            timeline.append({
                "type": "kill",
                "time": ev.get("timestamp"),
                "enemy_id": ev.get("data", {}).get("enemy_id", "Opponent"),
                "body_part": ev.get("data", {}).get("body_part", "body")
            })
        elif etype == "player_death":
            timeline.append({
                "type": "death",
                "time": ev.get("timestamp"),
                "killer_id": ev.get("data", {}).get("killer_id", "Enemy")
            })

    shots_fired = combat["shots_fired"] or 0
    shots_hit = combat["shots_hit"] or 0
    headshots = sess.get("headshots")
    if headshots is None:
        hs_count = game_telemetry.count_documents({
            "session_id": session_id,
            "event_type": "headshot"
        })
        if hs_count == 0:
            hs_count = game_telemetry.count_documents({
                "session_id": session_id,
                "event_type": "enemy_hit",
                "telemetry.headshot": True
            })
        if hs_count == 0:
            hs_count = game_telemetry.count_documents({
                "session_id": session_id,
                "event_type": "enemy_hit",
                "data.headshot": True
            })
        if hs_count == 0 and raw_feats.get("headshot_ratio") is not None and shots_hit > 0:
            hs_count = round(float(raw_feats["headshot_ratio"]) * shots_hit)
        headshots = hs_count

    headshot_ratio = raw_feats.get("headshot_ratio")
    if headshot_ratio is None and shots_hit > 0:
        headshot_ratio = round(headshots / max(1, shots_hit), 4)

    body_hits = max(0, shots_hit - headshots)
    missed_shots = max(0, shots_fired - shots_hit)

    return jsonify({
        "session_id": session_id,
        "game": sess.get("game", "CyberStrike 3D"),
        "date": (sess.get("ended_at") or sess.get("started_at") or sess.get("created_at")).isoformat() if (sess.get("ended_at") or sess.get("started_at") or sess.get("created_at")) else None,
        "duration_seconds": int((sess["ended_at"] - sess["started_at"]).total_seconds()) if (sess.get("ended_at") and sess.get("started_at")) else None,
        "kills": final_kills,
        "deaths": final_deaths,
        "shots_fired": shots_fired,
        "shots_hit": shots_hit,
        "headshots": headshots,
        "headshot_ratio": headshot_ratio,
        "body_hits": body_hits,
        "missed_shots": missed_shots,
        "kdr": combat["kdr"],
        "accuracy": combat["accuracy"],
        "result": sess.get("winner", "Completed"),
        "timeline": timeline[:50]
    })


# =========================================================================
# GDPR DATA EXPORT & SELF-DELETION (Item 14)
# =========================================================================

@player_bp.get("/export-data")
def export_player_data():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    user = users.find_one({"_id": user_oid}, {"password_hash": 0, "mfa_secret": 0, "recovery_codes": 0})
    if not user:
        return jsonify({"message": "User not found."}), 404

    # Matches
    user_sessions = list(game_sessions.find({"user_id": user_oid}))
    # Honour
    honour_logs = list(honour_history.find({"$or": [{"user_id": user_oid}, {"player_id": str(user_oid)}]}))
    # Rewards
    rewards_logs = list(reward_transactions.find({"user_id": user_oid}))
    # Logins
    logins = list(login_history.find({"user_id": user_oid}))

    rewards = user.get("rewards") or {}
    rewards_logs.extend(rewards.get("purchase_history") or [])
    rewards_logs.extend(rewards.get("adjustments") or [])

    def serialize_doc(value):
        if isinstance(value, dict):
            return {key: serialize_doc(item) for key, item in value.items()}
        if isinstance(value, list):
            return [serialize_doc(item) for item in value]
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, ObjectId):
            return str(value)
        return value

    export_payload = {
        "export_date": datetime.now(timezone.utc).isoformat(),
        "profile": serialize_doc(user),
        "game_sessions": [serialize_doc(s) for s in user_sessions],
        "honour_history": [serialize_doc(h) for h in honour_logs],
        "reward_transactions": [serialize_doc(r) for r in rewards_logs],
        "login_history": [serialize_doc(l) for l in logins],
    }

    response_json = json.dumps(export_payload, indent=2)
    return Response(
        response_json,
        mimetype="application/json",
        headers={"Content-Disposition": f"attachment; filename=securefps_data_export_{str(user_oid)}.json"}
    )


@player_bp.post("/account/delete")
def self_delete_account():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    user = users.find_one({"_id": user_oid})
    if not user:
        return jsonify({"message": "User not found."}), 404

    data = request.get_json(silent=True) or {}
    password = data.get("password")
    if not password:
        return jsonify({"message": "Please enter your password to confirm account deletion."}), 400

    pw_hash = user.get("password_hash")
    if not pw_hash:
        return jsonify({"message": "Account has no password configured."}), 400

    if isinstance(pw_hash, str):
        pw_hash = pw_hash.encode("utf-8")
    if not bcrypt.checkpw(password.encode("utf-8"), pw_hash):
        return jsonify({"message": "Incorrect password. Account deletion aborted."}), 401

    now = datetime.now(timezone.utc)
    anonymized_email = f"deleted_{str(user_oid)}@deleted.securefps.local"
    anonymized_name = f"Deleted Player {str(user_oid)[-4:]}"

    users.update_one(
        {"_id": user_oid},
        {
            "$set": {
                "account_status": "deleted",
                "revoked": True,
                "name": anonymized_name,
                "email": anonymized_email,
                "password_hash": None,
                "mfa_enabled": False,
                "mfa_secret": None,
                "deleted_at": now,
                "deletion_reason": "Self-deletion requested by player"
            }
        }
    )

    # Invalidate all active sessions
    sessions_db.update_many({"user_id": user_oid}, {"$set": {"is_active": False, "revoked_at": now}})
    session.clear()

    return jsonify({"success": True, "message": "Your account has been deleted and personal data anonymized."})


# =========================================================================
# FAIR PLAY, SETTINGS, ACTIVE SESSIONS & EXPORT ALIASES (Laptop Overhaul)
# =========================================================================

@player_bp.get("/data-export")
def data_export_alias():
    return export_player_data()


@player_bp.post("/delete-account")
def delete_account_alias():
    return self_delete_account()


@player_bp.get("/fairplay")
def get_fairplay_overview():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    user = users.find_one({"_id": user_oid})
    if not user:
        return jsonify({"message": "User not found."}), 404

    honour_score = int(user.get("honour_score", 100))
    if honour_score >= 90:
        honour_tier = "Exemplary"
        honour_color = "emerald"
        honour_description = "Full platform privileges, maximum priority matching, bonus XP multiplier."
    elif honour_score >= 70:
        honour_tier = "Honourable"
        honour_color = "purple"
        honour_description = "Normal matchmaking status. Maintain fair play to reach Exemplary standing."
    elif honour_score >= 50:
        honour_tier = "Warning"
        honour_color = "amber"
        honour_description = "Reduced rewards. Continued infractions may lead to temporary matchmaking restrictions."
    else:
        honour_tier = "Restricted"
        honour_color = "rose"
        honour_description = "Matchmaking privileges currently restricted. Fair play review in progress."

    # Fetch honour logs
    raw_logs = list(honour_history.find(
        {"$or": [{"user_id": user_oid}, {"player_id": str(user_oid)}]}
    ).sort("timestamp", -1).limit(20))

    history = []
    for h in raw_logs:
        delta = h.get("points_delta", 0)
        history.append({
            "id": str(h.get("_id", "")),
            "date": h.get("timestamp").isoformat() if h.get("timestamp") else None,
            "change": delta,
            "change_display": f"+{delta}" if delta > 0 else str(delta),
            "reason": str(h.get("reason", "Gameplay review")).replace("_", " ").title(),
            "resulting_score": h.get("new_score", honour_score)
        })

    # Fetch reviewed / flagged sessions - sanitize to NEVER expose raw ML numbers or thresholds!
    recent_sessions = list(game_sessions.find(
        {"user_id": user_oid, "status": "completed"}
    ).sort("started_at", -1).limit(10))

    reviewed_sessions = []
    for s in recent_sessions:
        sid = s.get("session_id", "")
        analysis = game_events.find_one({"session_id": sid, "analysis_type": "game_session"}) or {}
        enforce_state = analysis.get("enforcement_state") or s.get("enforcement_state") or "monitoring"
        risk_score = analysis.get("risk_score") or s.get("risk_score") or 0.0

        if enforce_state in {"banned", "suspended"} or risk_score >= 70:
            friendly_status = "suspended"
            friendly_reason = "Elevated behavioral variance detected"
        elif enforce_state in {"investigating", "review", "quarantine"} or (risk_score >= 40):
            friendly_status = "under_review"
            friendly_reason = "Flagged for standard security verification"
        elif risk_score > 20:
            friendly_status = "monitoring"
            friendly_reason = "Active baseline monitoring"
        else:
            friendly_status = "cleared"
            friendly_reason = "Standard fair play check passed"

        started_at = s.get("started_at") or s.get("created_at")
        reviewed_sessions.append({
            "session_id": sid[:8] if sid else "—",
            "full_session_id": sid,
            "date": started_at.isoformat() if started_at else None,
            "game": s.get("game", "CyberStrike 3D"),
            "status": friendly_status,
            "reason": friendly_reason
        })

    # Appeal status
    appeal = ban_appeals.find_one({"user_id": user_oid}, sort=[("created_at", -1)])
    appeal_info = None
    if appeal:
        appeal_info = {
            "id": str(appeal["_id"]),
            "status": appeal.get("status", "pending"),
            "submitted_at": appeal.get("created_at").isoformat() if appeal.get("created_at") else None,
            "reason": appeal.get("reason", ""),
            "reviewer_notes": appeal.get("reviewer_notes") or appeal.get("admin_response") or None,
            "updated_at": appeal.get("updated_at").isoformat() if appeal.get("updated_at") else None
        }

    return jsonify({
        "honour_score": honour_score,
        "honour_tier": honour_tier,
        "honour_color": honour_color,
        "honour_description": honour_description,
        "history": history,
        "reviewed_sessions": reviewed_sessions,
        "appeal": appeal_info,
        "detection_explainer": {
            "title": "How Server-Authoritative Fair Play Works",
            "summary": "SecureFPS protects competitive integrity through real-time behavioral telemetry and server-side physics verification. All movement velocities, firing rates, and hit registration are validated on authoritative servers to ensure every participant enjoys a level, cheat-free playing field.",
            "pillars": [
                {"title": "Input Pattern Analysis", "description": "Detects robotic or unnatural mouse micro-snaps without tracking private client software."},
                {"title": "Physics Consistency", "description": "Ensures operator acceleration and weapon recoil adhere strictly to server-governed limits."},
                {"title": "Non-Invasive Verification", "description": "Zero kernel-level drivers or third-party invasiveness—all protection is behavioral and authoritative."}
            ]
        }
    })


DEFAULT_PLAYER_SETTINGS = {
    "mouse_sensitivity": 1.0,
    "volume": 80,
    "graphics_quality": "High",
    "show_fps": True,
    "keybindings": {
        "move_forward": "KeyW",
        "move_backward": "KeyS",
        "move_left": "KeyA",
        "move_right": "KeyD",
        "jump": "Space",
        "crouch": "KeyC",
        "reload": "KeyR",
        "fire": "Mouse0",
        "aim": "Mouse1"
    }
}


@player_bp.get("/settings")
def get_player_settings():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user = users.find_one({"_id": ObjectId(user_id)}) or {}
    saved_settings = user.get("settings") or {}
    merged = {**DEFAULT_PLAYER_SETTINGS, **saved_settings}
    if "keybindings" in saved_settings and isinstance(saved_settings["keybindings"], dict):
        merged["keybindings"] = {**DEFAULT_PLAYER_SETTINGS["keybindings"], **saved_settings["keybindings"]}

    return jsonify({"settings": merged})


@player_bp.post("/settings")
def update_player_settings():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    data = request.get_json(silent=True) or {}
    sensitivity = data.get("mouse_sensitivity")
    volume = data.get("volume")
    graphics_quality = data.get("graphics_quality")
    show_fps = data.get("show_fps")
    keybindings = data.get("keybindings")

    updates = {}
    if sensitivity is not None:
        try:
            sens_val = float(sensitivity)
            if not (0.1 <= sens_val <= 10.0):
                return jsonify({"message": "Mouse sensitivity must be between 0.1 and 10.0."}), 400
            updates["settings.mouse_sensitivity"] = round(sens_val, 2)
        except (ValueError, TypeError):
            return jsonify({"message": "Invalid mouse sensitivity value."}), 400

    if volume is not None:
        try:
            vol_val = int(volume)
            if not (0 <= vol_val <= 100):
                return jsonify({"message": "Volume must be between 0 and 100."}), 400
            updates["settings.volume"] = vol_val
        except (ValueError, TypeError):
            return jsonify({"message": "Invalid volume value."}), 400

    if graphics_quality is not None:
        if graphics_quality not in {"Low", "Medium", "High"}:
            return jsonify({"message": "Graphics quality must be Low, Medium, or High."}), 400
        updates["settings.graphics_quality"] = graphics_quality

    if show_fps is not None:
        updates["settings.show_fps"] = bool(show_fps)

    if keybindings is not None:
        if not isinstance(keybindings, dict):
            return jsonify({"message": "Keybindings must be a key-value object."}), 400
        seen_keys = {}
        for action, key in keybindings.items():
            if not isinstance(key, str) or not key.strip():
                return jsonify({"message": f"Invalid key assigned to {action}."}), 400
            key_clean = key.strip()
            if key_clean in seen_keys:
                return jsonify({
                    "message": f"Key binding conflict: '{key_clean}' is assigned to both '{seen_keys[key_clean]}' and '{action}'. Each action must have a unique key."
                }), 400
            seen_keys[key_clean] = action
        updates["settings.keybindings"] = keybindings

    if not updates:
        return jsonify({"message": "No valid settings provided."}), 400

    users.update_one({"_id": ObjectId(user_id)}, {"$set": updates})
    return jsonify({"success": True, "message": "Player settings saved successfully."})


@player_bp.get("/active-sessions")
def get_player_active_sessions():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    current_session_id = session.get("auth_session_id")
    active_docs = list(sessions_db.find({"user_id": user_oid, "is_active": True}).sort("last_activity", -1).limit(10))

    results = []
    for s in active_docs:
        sid_str = str(s["_id"])
        is_current = (sid_str == str(current_session_id)) or (s.get("session_id") == str(current_session_id))
        dev = s.get("device_info") or s.get("device") or s.get("user_agent") or "Desktop Browser"
        parsed = parse_client_device(dev) if isinstance(dev, str) else {}
        results.append({
            "id": sid_str,
            "ip_address": s.get("ip_address") or s.get("ip") or "127.0.0.1",
            "browser": s.get("browser") or parsed.get("browser", "Chrome"),
            "os": s.get("os") or parsed.get("os", "Windows"),
            "device": s.get("device") or parsed.get("device", "Desktop PC"),
            "last_activity": s.get("last_activity").isoformat() if s.get("last_activity") else (s.get("created_at").isoformat() if s.get("created_at") else None),
            "is_current": is_current
        })

    return jsonify({"sessions": results})


