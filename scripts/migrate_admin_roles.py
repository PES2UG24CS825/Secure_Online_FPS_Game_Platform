import sys
sys.path.insert(0, 'backend')
from database.db import users

res1 = users.update_one(
    {"email": "admin1@gmail.com"},
    {"$set": {"role": "normal_admin", "is_super_admin": False}}
)
print("Updated admin1@gmail.com:", res1.matched_count, res1.modified_count)

res2 = users.update_one(
    {"email": "superadmin@securefps.io"},
    {"$set": {"role": "super_admin", "is_super_admin": True}}
)
print("Updated superadmin@securefps.io:", res2.matched_count, res2.modified_count)

# Clean up demo_admin if present
users.update_many(
    {"role": "demo_admin"},
    {"$set": {"role": "normal_admin", "is_super_admin": False}}
)

for u in users.find({"role": {"$in": ["admin", "normal_admin", "super_admin"]}}):
    print("Admin in DB:", u.get("email"), "role:", u.get("role"), "is_super_admin:", u.get("is_super_admin"))
