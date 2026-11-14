import sys
sys.path.insert(0, 'backend')
from app import app
from database.db import users

with app.test_client() as c:
    # 1. Normal Admin login test
    r = c.post('/api/auth/login', json={'email': 'admin1@gmail.com', 'password': 'Admin@12345', 'replace': True}, headers={'X-Requested-With': 'XMLHttpRequest'})
    print("Normal Admin login:", r.status_code)
    r_mfa = c.post('/api/auth/verify-mfa', json={'code': '123456'}, headers={'X-Requested-With': 'XMLHttpRequest'})
    print("Normal Admin MFA:", r_mfa.status_code)
    r_me = c.get('/api/admin/me', headers={'X-Requested-With': 'XMLHttpRequest'})
    print("Normal Admin /api/admin/me:", r_me.json)

    # 2. Super Admin login test
    c2 = app.test_client()
    r_s = c2.post('/api/auth/login', json={'email': 'superadmin@securefps.io', 'password': 'SuperAdmin@2026!', 'replace': True}, headers={'X-Requested-With': 'XMLHttpRequest'})
    print("\nSuper Admin login:", r_s.status_code)
    c2.post('/api/auth/verify-mfa', json={'code': '123456'}, headers={'X-Requested-With': 'XMLHttpRequest'})
    r_s_me = c2.get('/api/admin/me', headers={'X-Requested-With': 'XMLHttpRequest'})
    print("Super Admin /api/admin/me:", r_s_me.json)

    # 3. Sudh login test (both exact password and lowercase)
    c3 = app.test_client()
    r_sudh1 = c3.post('/api/auth/login', json={'email': 'sudh@gmail.com', 'password': 'Sudh@12345', 'replace': True}, headers={'X-Requested-With': 'XMLHttpRequest'})
    print("\nSudh login (Sudh@12345):", r_sudh1.status_code)
    c4 = app.test_client()
    r_sudh2 = c4.post('/api/auth/login', json={'email': 'sudh@gmail.com', 'password': 'sudh12345', 'replace': True}, headers={'X-Requested-With': 'XMLHttpRequest'})
    print("Sudh login (sudh12345):", r_sudh2.status_code)

    # 4. Check player logins API
    r_logins = c.get('/api/admin/logins?role=player&limit=100', headers={'X-Requested-With': 'XMLHttpRequest'})
    accounts = r_logins.json.get('accounts', [])
    print("\nAccounts in Player Sign-in Activity (should be exactly 4):", len(accounts))
    for a in accounts:
        print(f"  - {a.get('name')} <{a.get('email')}> | role: {a.get('role')}")
