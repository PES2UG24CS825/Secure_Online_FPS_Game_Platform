import sys
sys.path.insert(0, 'backend')
from database.db import users
from services.auth import hash_password

team_creds = {
    'superadmin@securefps.io': ('Super Administrator', 'SuperAdmin@2026!', 'super_admin'),
    'admin1@gmail.com': ('Security Admin', 'Admin@12345', 'admin'),
    'sudh@gmail.com': ('sudh', 'Sudh@12345', 'player'),
    'varun1234@gmail.com': ('varun', 'Varun@12345', 'player'),
    'sudi12@gamil.com': ('sudi', 'Sudi@12345', 'player'),
    'pk123@gmail.com': ('prajwal', 'Prajwal@12345', 'player')
}

for email, (name, pw, role) in team_creds.items():
    users.update_one(
        {'email': email},
        {'$set': {
            'name': name,
            'password_hash': hash_password(pw),
            'mfa_secret': 'JBSWY3DPEHPK3PXP',
            'mfa_enabled': True,
            'account_status': 'active',
            'role': role
        }},
        upsert=True
    )
    print(f'[+] Synchronized {email} with canonical password and MFA secret.')
