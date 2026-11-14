"""
SecureFPS: Training/Serving Skew Verification Test
Verifies:
1. models/feature_ranges.json exists and contains training ranges for all 21 features.
2. An exact row from data/dataset_v2.csv fed through predict() yields identical predictions
   and matches the scikit-learn Pipeline input representation without drift.
"""

import json
from pathlib import Path
import numpy as np
import pandas as pd
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DATASET_PATH = REPO_ROOT / "data" / "dataset_v2.csv"
RANGES_PATH = REPO_ROOT / "backend" / "models" / "feature_ranges.json"
METADATA_PATH = REPO_ROOT / "backend" / "models" / "model_metadata.json"

from backend.models.ml_model import predict, predict_v2, artifact_v2, metadata_v2


def test_feature_ranges_file_exists_and_complete():
    assert RANGES_PATH.exists(), "backend/models/feature_ranges.json must exist"
    with open(RANGES_PATH, "r", encoding="utf-8") as f:
        ranges = json.load(f)
    assert len(ranges) >= 21, "feature_ranges.json must cover all 21 features"
    for feat, (f_min, f_max) in ranges.items():
        assert f_min <= f_max, f"Min must be <= Max for {feat}"


def test_training_row_identical_serving_input():
    assert DATASET_PATH.exists(), "data/dataset_v2.csv must exist"
    df = pd.read_csv(DATASET_PATH)

    # Pick a sample row
    sample_row = df.iloc[0]
    features_dict = {col: float(sample_row[col]) for col in metadata_v2["feature_order"]}

    # Predict via runtime path
    result = predict(features_dict)
    assert "risk_score" in result
    assert "model_version" in result
    assert result["risk_score"] >= 0 and result["risk_score"] <= 100

    # Test that supervised pipeline input produces deterministic output
    pipe = artifact_v2["supervised_pipeline"]
    input_df = pd.DataFrame([features_dict], columns=metadata_v2["feature_order"])
    direct_prob = pipe.predict_proba(input_df)[0][1]

    assert abs(result["random_forest_probability"] - round(float(direct_prob), 4)) < 1e-4, \
        "Serving path must yield identical prediction to direct pipeline call"
