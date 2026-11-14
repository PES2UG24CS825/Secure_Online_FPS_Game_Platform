import sys
sys.path.insert(0, 'backend')
from app import app
from database.db import users, sessions_db

# Clear old active sessions for clean test
sessions_db.delete_many({})

with app.test_client() as c:
    # 1. Login as sudh
    r_login = c.post('/api/auth/login', json={'email': 'sudh@gmail.com', 'password': 'Sudh@12345', 'replace': True}, headers={'X-Requested-With': 'XMLHttpRequest'})
    print('Sudh login status:', r_login.status_code)
    r_mfa = c.post('/api/auth/verify-mfa', json={'code': '123456'}, headers={'X-Requested-With': 'XMLHttpRequest'})
    print('Sudh MFA status:', r_mfa.status_code)
    
    # 2. Check leaderboard
    r_lb = c.get('/api/player/leaderboard', headers={'X-Requested-With': 'XMLHttpRequest'})
    lb = r_lb.json
    print('\n--- LEADERBOARD ---')
    for p in lb.get('leaderboard', []):
        print(f"#{p['rank']} {p['name']} | Kills: {p['kills']} | Matches: {p['matches']} | KD: {p['kd']} | Acc: {p['accuracy']}%")
    
    # 3. Login as admin
    c.get('/api/auth/logout')
    r_adm = c.post('/api/auth/login', json={'email': 'admin1@gmail.com', 'password': 'Admin@12345', 'replace': True}, headers={'X-Requested-With': 'XMLHttpRequest'})
    print('Admin login status:', r_adm.status_code)
    r_adm_mfa = c.post('/api/auth/verify-mfa', json={'code': '123456'}, headers={'X-Requested-With': 'XMLHttpRequest'})
    print('Admin MFA status:', r_adm_mfa.status_code)
    
    # 4. Check admin overview
    r_ov = c.get('/api/admin/overview?refresh=1', headers={'X-Requested-With': 'XMLHttpRequest'})
    ov = r_ov.json
    print('\n--- ADMIN OVERVIEW ---')
    print('Total players:', ov.get('total_players'))
    print('Active players:', ov.get('active_players'))
    print('Recorded matches:', ov.get('total_matches'))
    
    # 5. Check admin player list
    r_pl = c.get('/api/admin/players', headers={'X-Requested-With': 'XMLHttpRequest'})
    pl = r_pl.json
    print('\n--- ADMIN PLAYERS TABLE ---')
    print('Total in players table:', pl.get('total'))
    for player in pl.get('players', []):
        print(f"Player: {player['name']} <{player['email']}> | Role: {player['role']} | Status: {player['account_status']}")
        
    # 6. Check player detail for sudh
    sudh_id = str(users.find_one({'email': 'sudh@gmail.com'})['_id'])
    r_det = c.get(f'/api/admin/players/{sudh_id}', headers={'X-Requested-With': 'XMLHttpRequest'})
    det = r_det.json
    print('\n--- SUDH PLAYER DETAIL (ADMIN MODAL) ---')
    print('Total matches:', det.get('stats', {}).get('total_matches'))
    print('Total kills:', det.get('stats', {}).get('kills'))
    print('KDR:', det.get('stats', {}).get('kdr'))
    print('Recent matches sessions:', [(m['session_id'], m['kills'], m['kdr'], m['status']) for m in det.get('recent_matches', [])])
