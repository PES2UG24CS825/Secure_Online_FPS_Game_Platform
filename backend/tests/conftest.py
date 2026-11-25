import os
from uuid import uuid4


# Route imports initialize database indexes. Select an isolated default before collection.
os.environ.setdefault("MONGO_URI", "mongodb://127.0.0.1:27017/")
os.environ.setdefault("MONGO_DB", f"securefps_rewards_test_{uuid4().hex}")
