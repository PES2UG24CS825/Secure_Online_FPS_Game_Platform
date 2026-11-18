"""Recoverable logical MongoDB archives for ordinary collections."""
import hashlib
import os
from pathlib import Path
import struct
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

from bson import BSON


def backup_and_verify(database, directory):
    folder = Path(directory).resolve()
    frontend = Path(__file__).resolve().parents[2] / "frontend"
    if folder == frontend or frontend in folder.parents:
        raise ValueError("Backup storage cannot be inside the public frontend directory.")
    folder.mkdir(parents=True, exist_ok=True)
    key = f"bak_{uuid4().hex}"
    pending = folder / f"{key}.partial"
    archive_path = folder / f"{key}.zip"
    restore_name = f"securefps_restore_{uuid4().hex}"
    restore = database.client[restore_name]
    counts = {}
    try:
        with ZipFile(pending, "x", ZIP_DEFLATED) as archive:
            for number, info in enumerate(database.list_collections()):
                if info["type"] != "collection":
                    raise ValueError("Logical archives support ordinary collections only.")
                name = info["name"]
                collection = database[name]
                entry = f"collections/{number}.bson"
                indices = list(collection.list_indexes())
                indexed_options = {k: v for k, v in info.get("options", {}).items()}
                count = 0
                with archive.open(entry, "w", force_zip64=True) as stream:
                    for row in collection.find():
                        stream.write(BSON.encode(row))
                        count += 1
                counts[name] = {"entry": entry, "count": count, "indexes": indices, "options": indexed_options}
            archive.writestr("manifest.bson", BSON.encode({"database": database.name, "collections": counts}))

        with ZipFile(pending) as archive:
            manifest = BSON(archive.read("manifest.bson")).decode()
            for name, info in manifest["collections"].items():
                collection = restore.create_collection(name, **info["options"])
                batch = []
                with archive.open(info["entry"]) as stream:
                    while header := stream.read(4):
                        length = struct.unpack("<i", header)[0]
                        row = BSON(header + stream.read(length - 4)).decode()
                        batch.append(row)
                        if len(batch) == 1000:
                            collection.insert_many(batch)
                            batch.clear()
                    if batch:
                        collection.insert_many(batch)
                for index in info["indexes"]:
                    if index["name"] != "_id_":
                        options = {k: v for k, v in index.items() if k not in {"key", "v", "ns"}}
                        collection.create_index(list(index["key"].items()), **options)
                if collection.count_documents({}) != info["count"]:
                    raise ValueError("Restore document count did not match the archive.")
        with pending.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        os.replace(pending, archive_path)
        return {
            "backup_id": key, "archive": archive_path.name, "status": "verified",
            "database_name": database.name, "scope": "logical_database",
            "size_mb": round(archive_path.stat().st_size / 1048576, 4),
            "collections_count": len(counts),
            "documents_count": sum(info["count"] for info in counts.values()),
            "checksum": f"sha256:{checksum}",
        }
    finally:
        pending.unlink(missing_ok=True)
        database.client.drop_database(restore_name)
