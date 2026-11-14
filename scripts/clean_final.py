import sys
sys.path.insert(0, 'backend')
from database.db import users, mfa_lockouts, sessions_db

GENUINE_EMAILS = [
    'sudh@gmail.com',
    'pk123@gmail.com',
    'sudi12@gamil.com',
    'varun1234@gmail.com',
    'admin1@gmail.com',
    'superadmin@securefps.io'
]

r = users.delete_many({'email': {'$nin': GENUINE_EMAILS}})
print('Purged test accounts count:', r.deleted_count)
mfa_lockouts.delete_many({})
sessions_db.delete_many({})
print('Remaining users in database:')
for u in users.find():
    print(u.get('name'), '|', u.get('email'), '|', u.get('role'), '|', u.get('account_status'))
