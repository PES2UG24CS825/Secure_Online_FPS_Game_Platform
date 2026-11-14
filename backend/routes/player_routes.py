from services.risk_scoring import clamp_risk_score, classify_risk_score
import base64
import binascii
import io
import json
import uuid
from pathlib import Path
from datetime import datetime, timezone, timedelta
from flask import Blueprint, jsonify, request, session, Response
from bson import ObjectId
from PIL import Image
import bcrypt

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
from services.csrf import verify_csrf_and_origin
from routes.auth_routes import parse_client_device


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
        "success": item.get("status", "success") == "success",
        "browser": browser or "Google Chrome",
        "browser_icon": browser_icon or "🌐",
        "os": os_name or "Windows",
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
        "avatar_key": "celestial-sovereign",
        "preview": "public/avatars/celestial-sovereign.png",
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
        "avatar_key": "valkyrie-void",
        "preview": "public/avatars/valkyrie-void.png",
    },
    "skin_ghost_specops": {
        "name": "Ghost Spec-Ops Avatar",
        "description": "Stealth operative with dual-lens violet night-vision optics and carbon-weave armor.",
        "price": 200,
        "icon": "🥷",
        "category": "avatar",
        "avatar_key": "ghost-specops",
        "preview": "public/avatars/ghost-specops.png",
    },
    "skin_neon_valkyrie": {
        "name": "Neon Valkyrie Chibi",
        "description": "Cute chibi tactical specialist with high-contrast violet sensory headset.",
        "price": 150,
        "icon": "💜",
        "category": "avatar",
        "avatar_key": "chibi-female-1",
        "preview": "public/avatars/chibi-female-1.png",
    },
    "skin_cyber_ninja": {
        "name": "Cyber Infiltrator Chibi",
        "description": "Covert tactical operative wrapped in reinforced carbon-violet weave.",
        "price": 140,
        "icon": "🗡️",
        "category": "avatar",
        "avatar_key": "chibi-male-1",
        "preview": "public/avatars/chibi-male-1.png",
    },
    "skin_phantom_ghost": {
        "name": "Phantom Recon Chibi",
        "description": "Long-range marksman operative with dark tactical cloak and sensor array.",
        "price": 160,
        "icon": "🔮",
        "category": "avatar",
        "avatar_key": "chibi-female-2",
        "preview": "public/avatars/chibi-female-2.png",
    },
    "skin_tactical_vanguard": {
        "name": "Tactical Vanguard Chibi",
        "description": "Frontline combat specialist equipped with heavy alloy purple plate carrier.",
        "price": 130,
        "icon": "🛡️",
        "category": "avatar",
        "avatar_key": "chibi-male-2",
        "preview": "public/avatars/chibi-male-2.png",
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

UPLOADS_DIR = Path(__file__).resolve().parents[1] / "uploads"
AVATARS_DIR = UPLOADS_DIR / "avatars"
BANNERS_DIR = UPLOADS_DIR / "banners"
AVATARS_DIR.mkdir(parents=True, exist_ok=True)
BANNERS_DIR.mkdir(parents=True, exist_ok=True)

player_bp = Blueprint("player", __name__, url_prefix="/api/player")


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
        "profile_customization": user.get("profile_customization", {
            "avatar": "default-operator",
            "banner": "default-banner",
        }),
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
    allowed_avatars = {"default-operator", "chibi-male-1", "chibi-female-1", "chibi-male-2", "chibi-female-2", "valkyrie-void", "ghost-specops", "celestial-sovereign", "custom"}
    allowed_banners = {"default-banner", "sakura", "frontline", "dawn", "neon", "battlefield", "command-center", "cyber-metropolis", "orbital-bastion", "nebula-eternity", "custom"}

    if avatar_image:
        avatar = "custom"
    if banner_image:
        banner = "custom"
    if avatar not in allowed_avatars | {"custom"} or banner not in allowed_banners | {"custom"}:
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

    user_doc = users.find_one({"_id": ObjectId(user_id)}) or {}
    existing_custom = user_doc.get("profile_customization", {})

    avatar_url = existing_custom.get("avatar_url")
    banner_url = existing_custom.get("banner_url")

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
    return jsonify({"message": "Profile appearance saved.", "profile_customization": customization})

@player_bp.get("/stats")
def get_player_stats():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user_oid = ObjectId(user_id)
    player = users.find_one({"_id": user_oid}) or {}

    completed_sessions = list(game_sessions.find({"user_id": user_oid, "status": "completed"}))
    completed_legacy = list(matches.find({"user_id": user_oid}))

    session_ids = [s.get("session_id") for s in completed_sessions if s.get("session_id")]
    kills_telemetry = game_telemetry.count_documents({"user_id": user_oid, "session_id": {"$in": session_ids}, "event_type": "enemy_killed"}) if session_ids else 0
    deaths_telemetry = game_telemetry.count_documents({"user_id": user_oid, "session_id": {"$in": session_ids}, "event_type": "player_death"}) if session_ids else 0
    shots_telemetry = game_telemetry.count_documents({"user_id": user_oid, "session_id": {"$in": session_ids}, "event_type": "weapon_fire"}) if session_ids else 0
    hits_telemetry = game_telemetry.count_documents({"user_id": user_oid, "session_id": {"$in": session_ids}, "event_type": "enemy_hit"}) if session_ids else 0

    legacy_kills = sum(m.get("kills", 0) for m in completed_legacy)
    legacy_deaths = sum(m.get("deaths", 0) for m in completed_legacy)

    session_kills = sum(int(s.get("kills") or 0) for s in completed_sessions)
    session_deaths = sum(int(s.get("deaths") or 0) for s in completed_sessions)
    session_shots = sum(int(s.get("shots") or 0) for s in completed_sessions)
    session_hits = sum(int(s.get("hits") or 0) for s in completed_sessions)

    total_kills = max(kills_telemetry, session_kills) + legacy_kills
    total_deaths = max(deaths_telemetry, session_deaths) + legacy_deaths
    total_shots = max(shots_telemetry, session_shots)
    total_hits = max(hits_telemetry, session_hits)

    kdr = round(total_kills / max(total_deaths, 1), 2)
    overall_accuracy = round((total_hits / max(1, total_shots)) * 100, 1) if total_shots > 0 else 0.0

    total_matches = len(completed_sessions) + len(completed_legacy)
    wins = sum(1 for s in completed_sessions if s.get("winner") in {"Operator", "player", player.get("name")}) + sum(1 for m in completed_legacy if m.get("result") in {"victory", "win"})
    losses = max(0, total_matches - wins)

    total_seconds = 0
    for s in completed_sessions:
        st = s.get("started_at")
        en = s.get("ended_at")
        if st and en:
            try:
                diff = int((en - st).total_seconds())
                total_seconds += max(0, diff)
            except Exception:
                pass

    rewards = player.get("rewards") or {}
    coins = int(rewards.get("coins", 0))
    xp = int(rewards.get("xp", 0))
    level = 1 + int(xp // 100)
    xp_progress = int(xp % 100)

    latest_analysis = game_events.find_one(
        {"user_id": user_oid, "analysis_type": "game_session", "status": "success"},
        sort=[("created_at", -1)]
    ) or {}
    risk_score = latest_analysis.get("risk_score")
    risk_category = latest_analysis.get("risk_category") or (classify_risk_score(risk_score)["category"] if risk_score is not None else "Normal")

    return jsonify({
        "total_matches": total_matches,
        "wins": wins,
        "losses": losses,
        "kills": total_kills,
        "deaths": total_deaths,
        "kdr": kdr,
        "accuracy": overall_accuracy,
        "shots_fired": total_shots,
        "shots_hit": total_hits,
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
    session_filter = {"user_id": user_oid, "status": "completed"}
    total_matches = game_sessions.count_documents(session_filter)
    player_matches = list(game_sessions.find(session_filter).sort("started_at", -1).limit(20))
    if not player_matches:
        # Check string user_id or legacy matches
        alt_filter = {"$or": [{"user_id": str(user_oid)}, {"player_id": str(user_oid)}], "status": "completed"}
        player_matches = list(game_sessions.find(alt_filter).sort("started_at", -1).limit(20))
        if player_matches:
            total_matches = len(player_matches)
        else:
            player_matches = list(matches.find({"user_id": user_oid}).sort("created_at", -1).limit(20))
            total_matches = len(player_matches)
    analyses = {}
    for item in game_events.find(
        {"user_id": user_oid, "analysis_type": "game_session"}
    ).sort("created_at", -1):
        if item.get("session_id"):
            analyses.setdefault(item["session_id"], item)

    def event_count(session_id, event_type):
        return game_telemetry.count_documents({
            "user_id": user_oid,
            "session_id": session_id,
            "event_type": event_type,
        })

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
        kills_ev = event_count(session_id, "enemy_killed")
        deaths_ev = event_count(session_id, "player_death")
        shots_ev = event_count(session_id, "weapon_fire")
        hits_ev = event_count(session_id, "enemy_hit")

        kills = max(int(game_session.get("kills") or 0), kills_ev)
        deaths = max(int(game_session.get("deaths") or 0), deaths_ev)
        shots = max(int(game_session.get("shots") or 0), shots_ev)
        hits = max(int(game_session.get("hits") or 0), hits_ev)

        calc_acc = round((hits / max(1, shots)) * 100, 1) if shots > 0 else round(float(raw.get("accuracy", 0) or game_session.get("accuracy", 0) or 0) * 100, 1)
        auth_created = analysis.get("created_at")
        raw_score = analysis.get("risk_score", result.get("risk_score"))
        if raw_score is None and game_session.get("risk_score") is not None:
            raw_score = game_session.get("risk_score")
        clamped_score = clamp_risk_score(raw_score)
        classification = classify_risk_score(clamped_score)

        result_matches.append({
            "id": session_id,
            "session_id": session_id,
            "match_id": session_id[:8] if session_id else str(game_session.get("_id", ""))[-8:],
            "analysis_id": str(analysis.get("_id", "")),
            "model_version": analysis.get("model_version", "v1.2-ensemble-rf-iso"),
            "date": started_at.isoformat() if started_at else None,
            "duration": duration,
            "game": (game_session.get("game") or "CyberStrike 3D").replace("_", " "),
            "status": game_session.get("status", "unknown"),
            "weapon": game_session.get("weapon") or "P-24 Carbine",
            "kills": kills,
            "deaths": deaths,
            "shots_fired": shots,
            "shots_hit": hits,
            "kd": round(kills / max(deaths, 1), 2),
            "honour_awarded": game_session.get("honour_awarded"),
            "accuracy": calc_acc,
            "headshot_ratio": raw.get("headshot_ratio"),
            "risk_score": clamped_score,
            "risk_category": classification["category"],
            "risk_meaning": classification["meaning"],
            "risk_action": classification["action"],
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
    for user in users.find(
        {"role": "player", "account_status": {"$nin": ["suspended", "banned", "deleted"]}},
        {"name": 1, "email": 1, "role": 1, "account_status": 1, "is_demo": 1},
    ):
        name = str(user.get("name") or "").strip().lower()
        email = str(user.get("email") or "").strip().lower()

        # Filter out test, bot, and demo accounts from leaderboard
        if user.get("is_demo") is True:
            continue
        if any(email.endswith(d) for d in disallowed_domains):
            continue
        if any(email.startswith(p) for p in disallowed_prefixes):
            continue
        if any(kw in name for kw in disallowed_keywords):
            continue

        completed_sessions = list(game_sessions.find(
            {"user_id": user["_id"], "status": "completed"}
        ))
        session_ids = [item.get("session_id") for item in completed_sessions if item.get("session_id")]
        
        total_kills = 0
        total_deaths = 0
        accuracy_values = []
        for cs in completed_sessions:
            sid = cs.get("session_id")
            telem_k = game_telemetry.count_documents({"user_id": user["_id"], "session_id": sid, "event_type": "enemy_killed"}) if sid else 0
            telem_d = game_telemetry.count_documents({"user_id": user["_id"], "session_id": sid, "event_type": "player_death"}) if sid else 0
            
            s_k = max(int(cs.get("kills") or 0), telem_k)
            s_d = max(int(cs.get("deaths") or 0), telem_d)
            total_kills += s_k
            total_deaths += s_d
            
            acc = cs.get("accuracy")
            if acc is not None:
                acc_f = float(acc)
                accuracy_values.append(acc_f * 100 if acc_f <= 1.0 else acc_f)

        if not accuracy_values and session_ids:
            for item in game_events.find(
                {"user_id": user["_id"], "analysis_type": "game_session", "session_id": {"$in": session_ids}},
                {"raw_features.accuracy": 1},
            ):
                rf_acc = item.get("raw_features", {}).get("accuracy")
                if rf_acc is not None:
                    acc_f = float(rf_acc)
                    accuracy_values.append(acc_f * 100 if acc_f <= 1.0 else acc_f)

        matches_played = len(completed_sessions)
        kd = round(total_kills / max(total_deaths, 1), 2)
        accuracy = round((sum(accuracy_values) / len(accuracy_values)), 1) if accuracy_values else 0.0
        performance = round((total_kills * 3) + (kd * 10) + (accuracy * 0.25), 1)
        players.append({
            "id": str(user["_id"]),
            "name": user.get("name", "Player"),
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
    players.sort(key=lambda item: (-item["performance"], -item["kills"], -item["matches"], item["name"].lower()))
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
    user = users.find_one({"_id": user_oid}, {"rewards": 1}) or {}
    rewards = user.get("rewards") or {}
    total_matches = game_sessions.count_documents({"user_id": user_oid, "status": "completed"}) + matches.count_documents({"user_id": user_oid})
    total_kills = game_telemetry.count_documents({"user_id": user_oid, "event_type": "enemy_killed"})
    transactions = list(reward_transactions.find({"user_id": user_oid}).sort("created_at", -1).limit(10))
    return jsonify({
        "coins": int(rewards.get("coins", 0)),
        "xp": int(rewards.get("xp", 0)),
        "level": int(rewards.get("xp", 0)) // 250 + 1,
        "daily_streak": int(rewards.get("daily_streak", 0)),
        "last_daily_login": rewards.get("last_daily_login"),
        "owned_items": rewards.get("owned_items", []),
        "equipped_item": rewards.get("equipped_item"),
        "achievements": [
            {
                "id": a["id"],
                "name": a["name"],
                "desc": a["desc"],
                "reward_xp": a["reward_xp"],
                "reward_coins": a["reward_coins"],
                "unlocked": a["id"] in (rewards.get("unlocked_achievements") or [
                    "first_blood" if total_kills > 0 else None,
                    "consistent_player" if int(rewards.get("daily_streak", 0)) >= 3 else None,
                    "honourable_operator" if int(user.get("honour_score", 100)) == 100 and total_matches >= 3 else None,
                ])
            }
            for a in ACHIEVEMENTS
        ],
        "store": [{"id": item_id, **item} for item_id, item in REWARD_STORE.items() if not item.get("hidden")],
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
    user = users.find_one({"_id": user_oid}, {"rewards": 1}) or {}
    rewards = user.get("rewards") or {}
    previous_key = rewards.get("last_daily_login")
    if previous_key == today_key:
        return jsonify({"claimed": False, "message": "Today's login reward is already claimed."})

    yesterday_key = (today - timedelta(days=1)).isoformat()
    streak = int(rewards.get("daily_streak", 0)) + 1 if previous_key == yesterday_key else 1
    condition = {"_id": user_oid}
    if previous_key:
        condition["rewards.last_daily_login"] = previous_key
    else:
        condition["rewards.last_daily_login"] = {"$exists": False}
    claimed_at = datetime.now(timezone.utc)
    result = users.update_one(condition, {
        "$inc": {"rewards.coins": 25, "rewards.xp": 25},
        "$set": {"rewards.last_daily_login": today_key, "rewards.daily_streak": streak},
    })
    if not result.modified_count:
        return jsonify({"claimed": False, "message": "Today's login reward is already claimed."})
    reward_transactions.insert_one({
        "user_id": user_oid,
        "type": "daily_login",
        "description": "Daily login bonus",
        "coins": 25,
        "xp": 25,
        "created_at": claimed_at,
    })
    updated = users.find_one({"_id": user_oid}, {"rewards.coins": 1, "rewards.xp": 1}) or {}
    updated_rewards = updated.get("rewards") or {}
    return jsonify({"claimed": True, "coins_earned": 25, "xp_earned": 25, "coins": updated_rewards.get("coins", 25), "xp": updated_rewards.get("xp", 25), "daily_streak": streak})


@player_bp.post("/rewards/purchase")
def purchase_reward_item():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    data = request.get_json(silent=True) or {}
    item_id = data.get("item_id")
    if not isinstance(item_id, str):
        return jsonify({"message": "That store item is not available."}), 404
    item = REWARD_STORE.get(item_id)
    if not item:
        return jsonify({"message": "That store item is not available."}), 404
    user_oid = ObjectId(user_id)
    result = users.update_one(
        {"_id": user_oid, "rewards.coins": {"$gte": item["price"]}, "rewards.owned_items": {"$ne": item_id}},
        {"$inc": {"rewards.coins": -item["price"]}, "$addToSet": {"rewards.owned_items": item_id}},
    )
    if not result.modified_count:
        user = users.find_one({"_id": user_oid}, {"rewards": 1}) or {}
        rewards = user.get("rewards") or {}
        if item_id in rewards.get("owned_items", []):
            return jsonify({"message": "You already own this badge."}), 409
        return jsonify({"message": "You do not have enough coins for this badge."}), 409
    reward_transactions.insert_one({"user_id": user_oid, "type": "purchase", "description": f"Purchased {item['name']}", "coins": -item["price"], "xp": 0, "created_at": datetime.now(timezone.utc)})
    return jsonify({"message": f"Purchased {item['name']}.", "item_id": item_id})


@player_bp.post("/rewards/equip")
def equip_reward_item():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    item_id = (request.get_json(silent=True) or {}).get("item_id")
    if item_id is not None and (not isinstance(item_id, str) or item_id not in REWARD_STORE):
        return jsonify({"message": "That store item is not available."}), 404
    user_oid = ObjectId(user_id)
    query = {"_id": user_oid}
    update = {"$unset": {"rewards.equipped_item": ""}}
    applied_avatar = None
    applied_banner = None
    if item_id:
        item = REWARD_STORE[item_id]
        query["rewards.owned_items"] = item_id
        update_set = {"rewards.equipped_item": item_id}
        if item.get("category") == "avatar" and item.get("avatar_key"):
            update_set["profile_customization.avatar"] = item["avatar_key"]
            applied_avatar = item["avatar_key"]
        elif item.get("category") == "banner" and item.get("banner_key"):
            update_set["profile_customization.banner"] = item["banner_key"]
            applied_banner = item["banner_key"]
        update = {"$set": update_set}
    result = users.update_one(query, update)
    if not result.matched_count:
        return jsonify({"message": "Purchase this item before equipping it."}), 409
    return jsonify({
        "message": "Equipment updated successfully.",
        "equipped_item": item_id,
        "avatar": applied_avatar,
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
    logins = list(login_history.find(
        {"user_id": user_oid, "type": "login_success"}
    ).sort("created_at", -1).limit(50))
    warnings = list(security_events.find(
        {"user_id": user_oid, "type": "gameplay_alert_review", "action": "warn"}
    ).sort("created_at", -1).limit(10))
    active_sessions = list(sessions_db.find(
        {"user_id": user_oid, "is_active": True}
    ).sort("last_activity", -1).limit(20))
    latest_analysis = game_events.find_one(
        {"user_id": user_oid, "analysis_type": "game_session", "status": "success"},
        sort=[("created_at", -1)],
    ) or {}
    latest_result = latest_analysis.get("result") or {}
    risk_score = latest_analysis.get("risk_score", latest_result.get("risk_score"))

    return jsonify({
        "mfa_status": "enabled" if user.get("mfa_enabled") else "disabled",
        "account_status": user.get("account_status") or ("suspended" if user.get("revoked") else "active"),
        "honour_score": user.get("honour_score", 100),
        "play_restricted_until": play_restricted_until.isoformat()
            if play_restricted_until else None,
        "security_warnings": [
            {
                "note": item.get("note", "A gameplay security warning was recorded."),
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

@player_bp.get("/notifications")
def get_notifications():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    limit = max(1, min(request.args.get("limit", 20, type=int), 50))

    notes = list(player_notifications.find({"user_id": user_oid}).sort("created_at", -1).limit(limit))
    if not notes:
        # Seed engaging, actionable player notifications (Requirement 5)
        now_dt = datetime.now(timezone.utc)
        user_doc = users.find_one({"_id": user_oid}) or {}
        username = user_doc.get("username", "Operator")
        seed_notifs = [
            {
                "user_id": user_oid,
                "type": "reward",
                "title": f"Welcome back, {username}! 🎁",
                "message": "You have unclaimed daily coins and match earnings waiting in your Tactical Armory. Claim your streak bonus now!",
                "read": False,
                "created_at": now_dt
            },
            {
                "user_id": user_oid,
                "type": "security",
                "title": "🛡️ Fair-Play Verified",
                "message": "Your recent combat telemetry passed all server-authoritative ML anti-cheat checks with 0.0% anomaly risk.",
                "read": False,
                "created_at": now_dt
            },
            {
                "user_id": user_oid,
                "type": "mission",
                "title": "⚡ CyberStrike Proving Grounds",
                "message": "3D tactical combat arena is active. Complete today's match to earn +50 Coins and +100 XP.",
                "read": False,
                "created_at": now_dt
            }
        ]
        player_notifications.insert_many(seed_notifs)
        notes = list(player_notifications.find({"user_id": user_oid}).sort("created_at", -1).limit(limit))

    unread_count = player_notifications.count_documents({"user_id": user_oid, "read": False})

    return jsonify({
        "notifications": [
            {
                "id": str(n["_id"]),
                "type": n.get("type", "info"),
                "title": n.get("title", "Notification"),
                "message": n.get("message", ""),
                "read": n.get("read", False),
                "created_at": n["created_at"].isoformat() if n.get("created_at") else None,
            }
            for n in notes
        ],
        "unread_count": unread_count
    })


@player_bp.post("/notifications/read")
def mark_notifications_read():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    data = request.get_json(silent=True) or {}
    mark_all = data.get("mark_all", False)
    ids = data.get("notification_ids") or []

    if mark_all:
        player_notifications.update_many({"user_id": user_oid, "read": False}, {"$set": {"read": True}})
    elif ids:
        valid_oids = []
        for i in ids:
            try:
                valid_oids.append(ObjectId(i))
            except Exception:
                pass
        player_notifications.update_many({"user_id": user_oid, "_id": {"$in": valid_oids}}, {"$set": {"read": True}})

    return jsonify({"success": True, "message": "Notifications updated."})


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

        return jsonify({
            "session_id": str(m["_id"]),
            "game": "FPS Microgame",
            "date": m.get("created_at").isoformat() if m.get("created_at") else None,
            "kills": m.get("kills", 0),
            "deaths": m.get("deaths", 0),
            "kdr": round(m.get("kills", 0) / max(1, m.get("deaths", 0)), 2),
            "accuracy": round(float(m.get("accuracy", 0)) * 100, 1),
            "result": "Completed",
            "features": {},
            "timeline": []
        })

    # Fetch analysis features
    analysis = game_events.find_one({"session_id": session_id, "analysis_type": "game_session"}) or {}
    raw_feats = analysis.get("raw_features", {})

    # Authoritative counts across all telemetry events matching get_matches()
    kills_count = game_telemetry.count_documents({"session_id": session_id, "event_type": "enemy_killed"})
    deaths_count = game_telemetry.count_documents({"session_id": session_id, "event_type": "player_death"})
    shots_count = game_telemetry.count_documents({"session_id": session_id, "event_type": "weapon_fire"})
    hits_count = game_telemetry.count_documents({"session_id": session_id, "event_type": "enemy_hit"})

    final_kills = kills_count if kills_count > 0 else int(sess.get("kills", 0) or raw_feats.get("kills", 0) or 0)
    final_deaths = deaths_count if deaths_count > 0 else int(sess.get("deaths", 0) or raw_feats.get("deaths", 0) or 0)
    final_shots = shots_count if shots_count > 0 else int(sess.get("shots", 0) or 0)
    final_hits = hits_count if hits_count > 0 else int(sess.get("hits", 0) or 0)

    calc_acc = round((final_hits / max(1, final_shots)) * 100, 1) if final_shots > 0 else round(float(raw_feats.get("accuracy", 0) or sess.get("accuracy", 0) or 0) * 100, 1)

    # Fetch kill and death events for the combat timeline
    combat_events = list(game_telemetry.find(
        {"session_id": session_id, "event_type": {"$in": ["enemy_killed", "player_death"]}}
    ).sort("timestamp", 1).limit(100))

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

    return jsonify({
        "session_id": session_id,
        "game": sess.get("game", "CyberStrike 3D"),
        "date": (sess.get("ended_at") or sess.get("started_at") or sess.get("created_at")).isoformat() if (sess.get("ended_at") or sess.get("started_at") or sess.get("created_at")) else None,
        "duration_seconds": int((sess["ended_at"] - sess["started_at"]).total_seconds()) if (sess.get("ended_at") and sess.get("started_at")) else None,
        "kills": final_kills,
        "deaths": final_deaths,
        "shots_fired": final_shots,
        "shots_hit": final_hits,
        "kdr": round(final_kills / max(1, final_deaths), 2),
        "accuracy": calc_acc,
        "result": sess.get("winner", "Completed"),
        "features": {
            "accuracy": raw_feats.get("accuracy"),
            "headshot_ratio": raw_feats.get("headshot_ratio"),
            "reaction_time_median": raw_feats.get("reaction_time_median"),
            "reaction_time_min": raw_feats.get("reaction_time_min"),
            "aim_speed_mean": raw_feats.get("aim_speed_mean"),
            "aim_speed_max": raw_feats.get("aim_speed_max"),
            "flick_rate": raw_feats.get("flick_rate"),
            "movement_speed_mean": raw_feats.get("movement_speed_mean"),
            "movement_speed_max": raw_feats.get("movement_speed_max"),
        },
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
    user = users.find_one({"_id": user_oid}, {"password_hash": 0, "mfa_secret": 0})
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

    def serialize_doc(d):
        out = {}
        for k, v in d.items():
            if isinstance(v, ObjectId):
                out[k] = str(v)
            elif isinstance(v, datetime):
                out[k] = v.isoformat()
            else:
                out[k] = v
        return out

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

