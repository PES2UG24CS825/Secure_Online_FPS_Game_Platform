from pathlib import Path

from database.db import db


catalog = db["cosmetic_catalog"]
ASSET_DIR = Path(__file__).resolve().parents[2] / "frontend" / "public" / "cosmetics"
COLLECTION = {
    100: "Training Yard", 200: "Neon Patrol", 250: "Desert Watch",
    300: "Rainline", 400: "Arctic Relay", 500: "Harbor Guard",
    600: "Canopy Recon", 700: "Night Signal", 800: "Orbital Bay",
    900: "Command Core", 1000: "Eclipse Station",
}


def reward_catalog(legacy):
    items = {key: dict(value) for key, value in legacy.items()}
    for price, theme in COLLECTION.items():
        for category, kind, label in (
            ("avatar", "avatar", "Operator"), ("banner", "background", "Background")
        ):
            key = f"{kind}-{price}"
            extension = "png" if category == "avatar" else "jpg"
            items[key] = {
                "name": f"{theme} {label}", "price": price, "category": category,
                "preview": f"/public/cosmetics/{key}.{extension}", "pair": str(price),
                "description": theme, "enabled": True,
            }

    for record in catalog.find({}, {"_id": 0}):
        key = record.pop("item_id")
        items[key] = {**items.get(key, {}), **record}
    for item in items.values():
        preview = item.get("preview", "")
        item["artwork_ready"] = (
            (ASSET_DIR / Path(preview).name).is_file()
            if preview.startswith("/public/cosmetics/") else True
        )
        item["enabled"] = item.get("enabled", not item.get("hidden"))
        item["available"] = item["artwork_ready"] and item["enabled"]
    return items
