import sys
sys.path.insert(0, 'backend')
from database.db import users, mfa_lockouts, sessions_db

users.update_many({'role': 'player'}, {'$set': {'revoked': False, 'account_status': 'active'}})
print('All genuine players active and not revoked!')
for u in users.find({'role': 'player'}):
    print(u.get('name'), u.get('account_status'), 'revoked:', u.get('revoked'))
