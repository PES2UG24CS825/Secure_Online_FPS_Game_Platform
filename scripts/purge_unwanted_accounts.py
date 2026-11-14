import sys
sys.path.insert(0, 'backend')
from database.db import (
    users, login_history, game_sessions, game_telemetry, game_events,
    security_events, honour_history, sessions_db, admin_approvals, matches
)

GENUINE_EMAILS = {
    "sudh@gmail.com",
    "pk123@gmail.com",
    "sudi12@gamil.com",
    "varun1234@gmail.com",
    "admin1@gmail.com",
    "superadmin@securefps.io"
}

# 1. Find all users to delete
all_users = list(users.find())
to_delete_ids = []
for u in all_users:
    email = (u.get("email") or "").strip().lower()
    if email not in GENUINE_EMAILS:
        to_delete_ids.append(u["_id"])
        print(f"Purging user: {u.get('name')} <{email}> ({u.get('role')})")

if to_delete_ids:
    r_u = users.delete_many({"_id": {"$in": to_delete_ids}})
    print(f"[+] Deleted {r_u.deleted_count} unwanted user accounts.")
    
    # Clean up related records
    r_l = login_history.delete_many({"user_id": {"$in": to_delete_ids}})
    r_s = sessions_db.delete_many({"user_id": {"$in": to_delete_ids}})
    r_h = honour_history.delete_many({"$or": [{"user_id": {"$in": to_delete_ids}}, {"player_id": {"$in": [str(x) for x in to_delete_ids]}}]})
    r_sec = security_events.delete_many({"user_id": {"$in": to_delete_ids}})
    r_app = admin_approvals.delete_many({"player_id": {"$in": [str(x) for x in to_delete_ids]}})
    print(f"[+] Cleaned orphan records: logins={r_l.deleted_count}, sessions={r_s.deleted_count}, honours={r_h.deleted_count}, sec_events={r_sec.deleted_count}")

# 2. Verify remaining users
remaining = list(users.find())
print(f"\nRemaining users count: {len(remaining)}")
for u in remaining:
    print(f" - {u.get('name')} <{u.get('email')}> | role={u.get('role')} | status={u.get('account_status')}")

# 3. Clean numeric Session IDs for the 4 genuine players
genuine_players = {
    "sudh@gmail.com": ("sudh", "1001", 25, 8, 3.12, 0.33, 16.61),
    "varun1234@gmail.com": ("varun", "1002", 22, 4, 5.50, 0.33, 92.5),
    "sudi12@gamil.com": ("sudi", "1003", 19, 3, 6.33, 0.34, 92.5),
    "pk123@gmail.com": ("prajwal", "1004", 11, 5, 2.20, 0.30, 23.29)
}

# Purge any old matches in matches collection
matches.delete_many({})

# Update game_sessions with clean numeric session IDs (1001, 1002, 1003, 1004)
for email, (name, numeric_sid, kills, deaths, kd, acc, risk) in genuine_players.items():
    u = users.find_one({"email": email})
    if not u:
        continue
    uid = u["_id"]
    
    # Check if a session exists for this user
    existing_session = game_sessions.find_one({"user_id": uid})
    old_sid = existing_session.get("session_id") if existing_session else None
    
    sess_doc = {
        "session_id": numeric_sid,
        "user_id": uid,
        "player_id": str(uid),
        "player_name": name,
        "game": "CyberStrike 3D",
        "game_mode": "bot_match",
        "status": "completed",
        "kills": kills,
        "deaths": deaths,
        "kd": kd,
        "accuracy": acc,
        "risk_score": risk,
        "analysis_status": "completed",
        "duration": 218 if name == "sudh" else 180,
    }
    
    if existing_session:
        game_sessions.update_one({"_id": existing_session["_id"]}, {"$set": sess_doc})
    else:
        game_sessions.insert_one(sess_doc)
        
    # Update telemetry and events with new clean numeric session ID
    if old_sid:
        game_telemetry.update_many({"user_id": uid, "session_id": old_sid}, {"$set": {"session_id": numeric_sid}})
        game_events.update_many({"user_id": uid, "session_id": old_sid}, {"$set": {"session_id": numeric_sid}})

print("\n[+] Updated game_sessions with clean numeric IDs: 1001, 1002, 1003, 1004.")
for s in game_sessions.find():
    print(f" - Session #{s.get('session_id')} | Player: {s.get('player_name')} | Kills: {s.get('kills')} | Status: {s.get('status')}")

