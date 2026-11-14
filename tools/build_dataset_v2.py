"""
SecureFPS: Dataset Builder v2 (tools/build_dataset_v2.py)
Extracts Feature Set v2 from raw match sessions (from MongoDB or data/sessions_cache.json),
validates ranges, removes duplicates, checks class balance and feature separability,
and outputs data/dataset_v2.csv.
"""

import argparse
import json
import math
import sys
from pathlib import Path
from typing import List, Dict, Any, Tuple

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(BACKEND_DIR))

from backend.services.features_v2 import extract_features_v2, FEATURE_NAMES_V2, FEATURE_UNITS_V2
from backend.database.db import db

DATASET_CSV_PATH = PROJECT_ROOT / "data" / "dataset_v2.csv"
SESSIONS_CACHE_PATH = PROJECT_ROOT / "data" / "sessions_cache.json"

METADATA_COLS = ["session_id", "player_group", "source", "cheat_type", "strength", "label"]


def load_raw_sessions(use_db: bool = True, cache_path: Path = SESSIONS_CACHE_PATH) -> List[Dict[str, Any]]:
    """Load raw sessions from MongoDB training_sessions collection, falling back to cache JSON."""
    raw_sessions = []
    if use_db:
        try:
            cursor = db["training_sessions"].find({})
            raw_sessions = list(cursor)
            print(f"[DatasetBuilder] Loaded {len(raw_sessions)} sessions from MongoDB training_sessions.")
        except Exception as e:
            print(f"[DatasetBuilder] Note: Could not read from MongoDB ({e}), checking cache file...")

    if not raw_sessions and cache_path.exists():
        with open(cache_path, "r", encoding="utf-8") as f:
            raw_sessions = json.load(f)
        print(f"[DatasetBuilder] Loaded {len(raw_sessions)} sessions from {cache_path}.")

    return raw_sessions


def build_dataset_dataframe(raw_sessions: List[Dict[str, Any]]) -> pd.DataFrame:
    """Extract features v2 for each session and assemble a validated DataFrame."""
    rows = []
    skipped_insufficient = 0

    print(f"[DatasetBuilder] Extracting v2 features for {len(raw_sessions)} sessions...")
    for idx, sess in enumerate(raw_sessions):
        events = sess.get("events", [])
        features, meta = extract_features_v2(events, enforce_min_data=True, allow_fallback=True)

        if not meta["has_sufficient_data"]:
            skipped_insufficient += 1
            continue

        # Check for any unexpected NaNs
        has_nan = any(v is None for v in features.values())
        if has_nan:
            skipped_insufficient += 1
            continue

        row = {
            "session_id": sess.get("session_id", f"sess_{idx:05d}"),
            "player_group": sess.get("player_group", "group_unknown"),
            "source": sess.get("source", "simulated"),
            "cheat_type": sess.get("cheat_type", "none"),
            "strength": float(sess.get("strength", 0.0)),
            "label": int(sess.get("label", 0)),
            **features,
        }
        rows.append(row)

    print(f"[DatasetBuilder] Features extracted. Valid rows: {len(rows)}, Skipped insufficient/NaN: {skipped_insufficient}.")
    df = pd.DataFrame(rows)
    return df


def validate_dataset(df: pd.DataFrame) -> Tuple[bool, List[str]]:
    """Perform rigorous validation of dataset ranges, duplicates, and separability."""
    issues = []

    # 1. Check for duplicates
    dup_count = df.duplicated(subset=["session_id"]).sum()
    if dup_count > 0:
        issues.append(f"Found {dup_count} duplicate session_id rows.")
        df.drop_duplicates(subset=["session_id"], inplace=True)

    # 2. Check no C/N prefix in session_id or player_group
    for col in ["session_id", "player_group"]:
        has_cn = df[col].astype(str).str.match(r"^[CN]\d+$").any()
        if has_cn:
            issues.append(f"Column '{col}' contains revealing C/N IDs! Remove them.")

    # 3. Check for silent NaNs
    nan_counts = df[FEATURE_NAMES_V2].isna().sum()
    if nan_counts.any():
        issues.append(f"Found silent NaNs in features: {nan_counts[nan_counts > 0].to_dict()}")

    # 4. Check ranges
    for r_col in ["accuracy", "headshot_ratio", "snap_to_hit_ratio", "wall_aim_ratio"]:
        if (df[r_col] < 0.0).any() or (df[r_col] > 1.0).any():
            issues.append(f"Feature '{r_col}' out of [0, 1] range: min={df[r_col].min()}, max={df[r_col].max()}")

    if (df["aim_speed_mean"] < 0).any():
        issues.append("aim_speed_mean contains negative values.")

    # 5. Class Balance
    class_counts = df["label"].value_counts().to_dict()
    print("\n--- CLASS BALANCE REPORT ---")
    total = len(df)
    for lbl, cnt in class_counts.items():
        name = "Cheater" if lbl == 1 else "Normal"
        print(f"  Class {lbl} ({name}): {cnt} sessions ({cnt/total*100:.1f}%)")

    # Cheat type breakdown
    print("\n--- CHEAT TYPE BREAKDOWN ---")
    ct_counts = df["cheat_type"].value_counts().to_dict()
    for ct, cnt in ct_counts.items():
        print(f"  {ct}: {cnt} sessions")

    # 6. Per-feature separability (ROC-AUC)
    print("\n--- PER-FEATURE SEPARABILITY (ROC-AUC vs LABEL) ---")
    perfect_sep_features = []
    for feat in FEATURE_NAMES_V2:
        try:
            auc = roc_auc_score(df["label"], df[feat])
            # If inversely correlated, report symmetric separability
            eff_auc = max(auc, 1.0 - auc)
            print(f"  {feat:<25}: AUC = {auc:.4f} (Separability = {eff_auc:.4f})")
            if eff_auc >= 0.999:
                perfect_sep_features.append((feat, eff_auc))
        except Exception as e:
            print(f"  {feat:<25}: AUC error ({e})")

    if perfect_sep_features:
        issues.append(f"WARNING: The following features separate classes perfectly (AUC >= 0.999): {perfect_sep_features}! Overlap must exist.")

    # 7. Within-class correlations summary
    print("\n--- WITHIN-CLASS CORRELATIONS ---")
    normal_corr = df[df["label"] == 0][FEATURE_NAMES_V2].corr()
    cheater_corr = df[df["label"] == 1][FEATURE_NAMES_V2].corr()
    print(f"  Normal class average pairwise abs correlation: {normal_corr.abs().values[np.triu_indices_from(normal_corr, k=1)].mean():.3f}")
    print(f"  Cheater class average pairwise abs correlation: {cheater_corr.abs().values[np.triu_indices_from(cheater_corr, k=1)].mean():.3f}")

    is_valid = len(issues) == 0
    return is_valid, issues


def main():
    parser = argparse.ArgumentParser(description="Build and validate anti-cheat dataset v2.")
    parser.add_argument("--output", type=str, default="data/dataset_v2.csv", help="Output CSV path")
    args = parser.parse_args()

    out_path = PROJECT_ROOT / args.output
    out_path.parent.mkdir(parents=True, exist_ok=True)

    raw_sessions = load_raw_sessions()
    if not raw_sessions:
        print("[DatasetBuilder] ERROR: No raw sessions found. Run 'python tools/simulate_sessions.py' first.")
        sys.exit(1)

    df = build_dataset_dataframe(raw_sessions)
    if len(df) == 0:
        print("[DatasetBuilder] ERROR: No valid rows produced.")
        sys.exit(1)

    is_valid, issues = validate_dataset(df)
    if not is_valid:
        print("\n[DatasetBuilder] VALIDATION ISSUES FOUND:")
        for iss in issues:
            print(f"  ! {iss}")
        if any("perfectly" in iss for iss in issues):
            print("[DatasetBuilder] CRITICAL WARNING: Perfect separability detected.")

    # Save to CSV
    cols_order = METADATA_COLS + FEATURE_NAMES_V2
    df[cols_order].to_csv(out_path, index=False)
    print(f"\n[DatasetBuilder] Dataset v2 exported successfully to {out_path} ({len(df)} rows, {len(cols_order)} columns).")


if __name__ == "__main__":
    main()
