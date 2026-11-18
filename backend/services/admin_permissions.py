from database.db import admin_permissions


OPERATIONAL_PERMISSIONS = {
    "players:read": True, "players:warn": True, "players:suspend": True,
    "players:notes": True, "players:account": True, "appeals:review": True,
    "support:read": True, "support:reply": True, "threats:read": True,
    "analytics:read": True, "audit:read": True, "health:read": True,
    "alerts:review": True, "approvals:request": True, "database:export": False,
}


def normal_admin_permissions():
    role = admin_permissions.find_one({"role": "NORMAL_ADMIN"}, {"permissions": 1}) or {}
    saved = role.get("permissions") or {}
    return {
        key: saved[key] if type(saved.get(key)) is bool else default
        for key, default in OPERATIONAL_PERMISSIONS.items()
    }


def has_operational_permission(admin, permission, *, write=False):
    if not admin:
        return False
    role = admin.get("role")
    if role == "demo_admin" and write:
        return False
    if role == "super_admin" or admin.get("is_super_admin") is True:
        return True
    return normal_admin_permissions().get(permission, False)
