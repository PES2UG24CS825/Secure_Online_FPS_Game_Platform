import os
import sys

# Ensure backend path is on sys.path
sys.path.insert(0, os.path.abspath('.'))
sys.path.insert(0, os.path.abspath('backend'))

from backend.app import app
import pyotp

def test_admin(email, password, totp_secret, label, expect_super):
    print(f"\n--- Testing {label} ({email}) ---")
    client = app.test_client()
    
    # 1. Login with session takeover
    res = client.post("/api/auth/login", json={"email": email, "password": password, "takeover": True})
    data = res.get_json() or {}
    print(f"Login status: {res.status_code}, mfa_required: {data.get('mfa_required')}")
    if res.status_code != 200:
        print(f"FAILED LOGIN: {data}")
        return False

    # 2. MFA
    totp = pyotp.TOTP(totp_secret)
    code = totp.now()
    res = client.post("/api/auth/verify-mfa", json={"code": code})
    data = res.get_json() or {}
    print(f"MFA status: {res.status_code}, message: {data.get('message')}")
    if res.status_code != 200:
        print(f"FAILED MFA: {data}")
        return False
        
    # 3. Overview (forced refresh)
    res = client.get("/api/admin/overview?refresh=1")
    print(f"Admin Overview status: {res.status_code}")
    if res.status_code == 200:
        ov = res.get_json()
        admin_meta = ov.get("admin", {})
        stats = ov.get("stats", {})
        print(f"  Admin: {admin_meta.get('email')} | role: {admin_meta.get('role')} | is_super: {admin_meta.get('is_super_admin')}")
        if admin_meta.get('is_super_admin') != expect_super:
            print(f"  ERROR: Expected is_super_admin={expect_super}, got {admin_meta.get('is_super_admin')}")
            return False
        print(f"  Stats: Total Players={stats.get('total_players')}, Matches Analyzed={stats.get('matches_analyzed')}")
    else:
        print(f"FAILED OVERVIEW: {res.get_json()}")
        return False

    # 4. List Players
    res = client.get("/api/admin/players")
    print(f"List Players status: {res.status_code}")
    if res.status_code == 200:
        pl = res.get_json()
        print(f"  Total players returned: {pl.get('total')}, count: {len(pl.get('players', []))}")
        for p in pl.get('players', []):
            print(f"    - {p.get('name')} ({p.get('email')})")
    else:
        print(f"FAILED LIST PLAYERS: {res.get_json()}")
        return False

    # 5. Test Super Admin restricted action (Soft Delete on a non-existent ID)
    res = client.post(
        "/api/admin/players/000000000000000000000000/delete",
        json={"reason": "Testing permission restriction verification"},
        headers={"X-Requested-With": "XMLHttpRequest"}
    )
    print(f"Soft delete endpoint test status: {res.status_code} ({res.get_json().get('message')})")
    if expect_super:
        if res.status_code != 404:
            print(f"  ERROR: Super admin expected 404 (Player not found), got {res.status_code}")
            return False
        print("  Super admin authorized correctly for administrative delete!")
    else:
        if res.status_code != 403:
            print(f"  ERROR: Normal admin expected 403 Forbidden, got {res.status_code}")
            return False
        print("  Normal admin successfully restricted (403 Forbidden) from soft delete!")

    # 6. Test /api/admin/logins
    res = client.get("/api/admin/logins")
    print(f"Recent logins status: {res.status_code}")
    if res.status_code == 200:
        logins = res.get_json().get("logins", [])
        print(f"  Recent logins returned: {len(logins)} entries")
    else:
        print(f"FAILED RECENT LOGINS: {res.get_json()}")
        return False

    # 7. Test Export CSV endpoint permission
    res = client.get("/api/admin/export/players")
    print(f"Export players status: {res.status_code}")
    if expect_super:
        if res.status_code != 200:
            print(f"  ERROR: Super admin expected 200 for export, got {res.status_code}")
            return False
        print("  Super admin authorized for database exports!")
    else:
        if res.status_code != 403:
            print(f"  ERROR: Normal admin expected 403 for export, got {res.status_code}")
            return False
        print("  Normal admin successfully restricted (403 Forbidden) from database exports!")

    # 8. Logout
    client.post("/api/auth/logout")
    return True

if __name__ == "__main__":
    ok1 = test_admin("superadmin@securefps.io", "SuperAdmin@2026!", "JBSWY3DPEHPK3PXP", "SUPER ADMIN", expect_super=True)
    ok2 = test_admin("admin1@gmail.com", "Admin@12345", "JBSWY3DPEHPK3PXP", "NORMAL ADMIN", expect_super=False)
    if ok1 and ok2:
        print("\n>>> ALL ADMIN VERIFICATIONS & RBAC RESTRICTIONS PASSED 100%! <<<")
    else:
        print("\n>>> VERIFICATION FAILED! <<<")
        sys.exit(1)
