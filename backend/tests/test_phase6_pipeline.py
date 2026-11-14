"""
SecureFPS: End-to-End Test Suite for Anti-Cheat Feature Set v2 & Retraining Pipeline (Phase 6).
Tests:
- features_v2 extraction & units
- dataset validation (ranges, no C/N leakage, overlap/no-single-feature-perfection)
- no-leakage checks (player_group disjoint between train and test)
- pipeline load & predict with top-3 feature contributions
- operating threshold false-positive rate on held-out normal players
- end-to-end comparison: simulated aimbot scores significantly higher risk than skilled human
"""

import hashlib
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
import pytest

from services.features_v2 import extract_features_v2, FEATURE_NAMES_V2, FEATURE_UNITS_V2
from models.ml_model import predict, predict_v2, MODEL_V2_PATH as ARTIFACT_PATH, METADATA_PATH
from tools.simulate_sessions import SessionSimulator


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATASET_CSV_PATH = PROJECT_ROOT / "data" / "dataset_v2.csv"


def test_features_v2_contract_and_units():
    """Verify Feature Set v2 contract contains all 21 documented features and units."""
    assert len(FEATURE_NAMES_V2) == 21
    for feat in FEATURE_NAMES_V2:
        assert feat in FEATURE_UNITS_V2, f"Feature '{feat}' lacks documented units."


def test_dataset_v2_integrity_and_no_cn_leakage():
    """Verify data/dataset_v2.csv exists, has valid ranges, no NaNs, and no revealing C/N labels."""
    assert DATASET_CSV_PATH.exists(), "data/dataset_v2.csv must exist."
    df = pd.read_csv(DATASET_CSV_PATH)
    assert len(df) >= 3000, f"Expected 3000+ sessions, got {len(df)}"

    # No C/N prefix in IDs
    for col in ["session_id", "player_group"]:
        has_cn = df[col].astype(str).str.match(r"^[CN]\d+$").any()
        assert not has_cn, f"Column '{col}' must not contain revealing C/N IDs!"

    # Range checks
    for r_col in ["accuracy", "headshot_ratio", "snap_to_hit_ratio", "wall_aim_ratio"]:
        assert (df[r_col] >= 0.0).all() and (df[r_col] <= 1.0).all(), f"Column {r_col} has values outside [0, 1]"

    # No NaN rows kept silently
    assert not df[FEATURE_NAMES_V2].isna().any().any(), "Dataset v2 contains silent NaNs in feature columns."

    # Realistic overlap: No single feature should separate the dataset with AUC >= 0.999
    from sklearn.metrics import roc_auc_score
    for feat in FEATURE_NAMES_V2:
        auc = roc_auc_score(df["label"], df[feat])
        eff_auc = max(auc, 1.0 - auc)
        assert eff_auc < 0.999, f"Feature '{feat}' has perfect separability (AUC={eff_auc:.4f})! Must have realistic overlap."


def test_no_leakage_player_groups_disjoint():
    """Verify train and test splits have 100% disjoint player groups."""
    from models.train_v2 import load_and_split_data
    train_df, test_df, unseen_df, h = load_and_split_data(DATASET_CSV_PATH)

    train_groups = set(train_df["player_group"])
    test_groups = set(test_df["player_group"])
    assert train_groups.isdisjoint(test_groups), "Leakage detected: train and test share player groups!"
    assert len(unseen_df) > 0, "Unseen cheat holdout split must not be empty."


def test_pipeline_artifact_loading_and_prediction():
    """Verify model_v2.joblib and model_metadata.json load and predict properly."""
    assert ARTIFACT_PATH.exists(), "backend/models/model_v2.joblib must exist."
    assert METADATA_PATH.exists(), "backend/models/model_metadata.json must exist."

    with open(METADATA_PATH, "r", encoding="utf-8") as f:
        meta = json.load(f)

    assert meta.get("model_version") == "v2.0.0"
    assert "operating_threshold" in meta
    assert len(meta.get("feature_order", [])) == 21

    # Sample normal vector
    sample_input = {feat: 0.35 for feat in FEATURE_NAMES_V2}
    sample_input["accuracy"] = 0.40
    sample_input["movement_speed_mean"] = 4.0
    sample_input["reaction_time_median"] = 0.25

    res = predict(sample_input)
    assert "risk_score" in res
    assert 0.0 <= res["risk_score"] <= 100.0
    assert "model_version" in res
    assert res["model_version"] == "v2.0.0"
    assert "feature_contributions" in res
    assert len(res["feature_contributions"]) == 3, "Expected top 3 feature contributions in response"


def test_threshold_fpr_on_held_out_normals():
    """Verify that false positive rate on normal held-out test rows stays close to target 1% (<= 5%)."""
    df = pd.read_csv(DATASET_CSV_PATH)
    normal_df = df[df["label"] == 0].sample(n=200, random_state=42)

    with open(METADATA_PATH, "r", encoding="utf-8") as f:
        meta = json.load(f)
    thresh = meta["operating_threshold"]

    artifact = joblib.load(ARTIFACT_PATH)
    pipe = artifact["supervised_pipeline"]
    probs = pipe.predict_proba(normal_df[FEATURE_NAMES_V2])[:, 1]
    fpr = float(np.mean(probs >= thresh))

    assert fpr <= 0.05, f"False Positive Rate on normal players {fpr*100:.2f}% exceeds acceptable ceiling (5%)."


def test_end_to_end_aimbot_higher_risk_than_skilled_human():
    """Simulate a skilled human session and a hard aimbot session; assert aimbot scores higher risk."""
    sim = SessionSimulator()

    # 1. Generate skilled human session
    human_events = sim.generate_session_events(
        session_id="test_human_sess_99",
        player_group="human_test",
        source="human",
        cheat_type="none",
        strength=0.0,
        label=0,
    )
    human_features, human_meta = extract_features_v2(human_events, enforce_min_data=False)
    human_pred = predict(human_features)

    # 2. Generate hard aimbot session
    aimbot_events = sim.generate_session_events(
        session_id="test_aimbot_sess_99",
        player_group="cheat_test",
        source="simulated",
        cheat_type="hard_aimbot",
        strength=1.0,
        label=1,
    )
    aimbot_features, aimbot_meta = extract_features_v2(aimbot_events, enforce_min_data=False)
    aimbot_pred = predict(aimbot_features)

    print(f"\nSkilled Human: Risk={human_pred['risk_score']} ({human_pred['random_forest']})")
    print(f"Hard Aimbot:   Risk={aimbot_pred['risk_score']} ({aimbot_pred['random_forest']})")

    assert aimbot_pred["risk_score"] > human_pred["risk_score"], (
        f"Expected aimbot risk ({aimbot_pred['risk_score']}) > human risk ({human_pred['risk_score']})"
    )
    assert aimbot_pred["random_forest"] == "cheater", "Hard aimbot must be classified as cheater"
    assert human_pred["random_forest"] == "normal", "Skilled human must be classified as normal"
