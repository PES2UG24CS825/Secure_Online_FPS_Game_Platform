from pathlib import Path
import json
import math
import joblib
import numpy as np
import pandas as pd

MODEL_DIR = Path(__file__).resolve().parent
MODEL_V2_PATH = MODEL_DIR / "model_v2.joblib"
METADATA_PATH = MODEL_DIR / "model_metadata.json"

RF_PATH = MODEL_DIR / "random_forest.pkl"
IF_PATH = MODEL_DIR / "isolation_forest.pkl"
SCALER_PATH = MODEL_DIR / "scaler.pkl"

# Legacy 5 active features contract
FEATURES = [
    "accuracy",
    "fire_rate",
    "movement_speed",
    "aim_smoothness",
    "kdr",
]

LEGACY_FEATURES = [
    "reaction_time",
    "accuracy",
    "headshot_ratio",
    "fire_rate",
    "movement_speed",
    "aim_smoothness",
    "kdr",
]

try:
    from services.features_v2 import FEATURE_NAMES_V2, FEATURE_UNITS_V2
except ImportError:
    try:
        from backend.services.features_v2 import FEATURE_NAMES_V2, FEATURE_UNITS_V2
    except ImportError:
        FEATURE_NAMES_V2 = [
            "accuracy", "headshot_ratio", "reaction_time_median", "reaction_time_min",
            "fire_rate", "fire_interval_cv", "burst_length_mean", "movement_speed_mean",
            "movement_speed_max", "movement_speed_std", "aim_speed_mean", "aim_speed_std",
            "aim_speed_max", "flick_rate", "aim_error_at_fire_mean", "aim_error_at_fire_std",
            "snap_to_hit_ratio", "wall_aim_ratio", "kdr", "time_to_kill_median", "shots_per_kill"
        ]
        FEATURE_UNITS_V2 = {}

# Load v2 model bundle if present
artifact_v2 = None
metadata_v2 = {}
if MODEL_V2_PATH.exists():
    try:
        artifact_v2 = joblib.load(MODEL_V2_PATH)
        if METADATA_PATH.exists():
            with open(METADATA_PATH, "r", encoding="utf-8") as f:
                metadata_v2 = json.load(f)
        print(f"[SecureFPS ML] Loaded Model v2 bundle ({metadata_v2.get('model_version', 'v2.0.0')})")
    except Exception as exc:
        print(f"[SecureFPS ML] Could not load model_v2.joblib ({exc}), falling back to v1.")
        artifact_v2 = None

# Legacy fallback models
rf_model = joblib.load(RF_PATH) if RF_PATH.exists() else None
iso_model = joblib.load(IF_PATH) if IF_PATH.exists() else None
scaler = joblib.load(SCALER_PATH) if SCALER_PATH.exists() else None

RISK_SCORE_WEIGHTS = {
    "random_forest": 0.60,
    "isolation_forest": 0.40,
}


def normalize_isolation_decision(decision):
    """Map Isolation Forest's signed decision function to an anomaly probability."""
    value = float(np.asarray(decision).reshape(-1)[0])
    if not np.isfinite(value):
        raise ValueError("Isolation Forest decision function is not finite")
    return float(1.0 / (1.0 + np.exp(np.clip(value, -60.0, 60.0))))


def calculate_risk_score(rf_probability, isolation_anomaly_score):
    values = (float(rf_probability), float(isolation_anomaly_score))
    if not all(np.isfinite(value) and 0 <= value <= 1 for value in values):
        raise ValueError("Risk inputs must be finite values between 0 and 1")
    return round(100.0 * (
        RISK_SCORE_WEIGHTS["random_forest"] * values[0]
        + RISK_SCORE_WEIGHTS["isolation_forest"] * values[1]
    ), 2)


def compute_top_feature_contributions(supervised_pipe, df_row: pd.DataFrame, feature_order: list) -> list:
    """Compute top 3 feature contributions based on standardized deviation from training baseline."""
    try:
        imputer = supervised_pipe.named_steps["imputer"]
        scaler = supervised_pipe.named_steps["scaler"]
        X_imp = imputer.transform(df_row)
        X_scaled = scaler.transform(X_imp)[0]

        contributions = []
        for idx, feat in enumerate(feature_order):
            raw_val = df_row[feat].iloc[0]
            val = float(raw_val) if not pd.isna(raw_val) else float(X_imp[0, idx])
            z_score = float(X_scaled[idx])
            contributions.append({
                "feature": feat,
                "impact": round(abs(z_score), 3),
                "value": round(val, 4),
                "unit": FEATURE_UNITS_V2.get(feat, ""),
                "direction": "higher" if z_score > 0 else "lower",
            })
        contributions.sort(key=lambda x: x["impact"], reverse=True)
        return contributions[:3]
    except Exception as exc:
        print("[SecureFPS ML] Feature contributions computation error:", exc)
        return []


def predict_v2(features: dict) -> dict:
    """Evaluate session features using Model Pipeline v2."""
    feature_order = metadata_v2.get("feature_order", FEATURE_NAMES_V2)
    supervised_pipe = artifact_v2["supervised_pipeline"]
    iforest_pipe = artifact_v2["isolation_pipeline"]
    operating_threshold = float(metadata_v2.get("operating_threshold", artifact_v2.get("operating_threshold", 0.50)))
    p1 = float(artifact_v2.get("iforest_p1", -0.1))
    p99 = float(artifact_v2.get("iforest_p99", 0.1))
    model_version = metadata_v2.get("model_version", "v2.0.0")

    # Construct input row
    row_data = {}
    is_low_confidence = False
    missing_count = 0
    for feat in feature_order:
        val = features.get(feat)
        if val is None or not math.isfinite(val):
            row_data[feat] = np.nan
            missing_count += 1
        else:
            row_data[feat] = float(val)

    if missing_count > len(feature_order) // 2:
        is_low_confidence = True

    input_df = pd.DataFrame([row_data], columns=feature_order)

    # 1. Supervised calibrated prediction
    probs = supervised_pipe.predict_proba(input_df)[0]
    classes = list(supervised_pipe.classes_)
    calibrated_prob = float(probs[classes.index(1)]) if 1 in classes else float(probs[-1])
    supervised_decision = "cheater" if calibrated_prob >= operating_threshold else "normal"

    # 2. Isolation Forest anomaly scoring
    raw_dec = iforest_pipe.named_steps["isolation_forest"].decision_function(
        iforest_pipe.named_steps["scaler"].transform(
            iforest_pipe.named_steps["imputer"].transform(input_df)
        )
    )[0]
    denom = max(1e-6, p99 - p1)
    if_score = float(np.clip((p99 - raw_dec) / denom, 0.0, 1.0))
    iso_decision = "anomaly" if if_score >= 0.50 else "normal"

    # 3. Combined Risk Score
    risk_score = round(100.0 * (
        RISK_SCORE_WEIGHTS["random_forest"] * calibrated_prob
        + RISK_SCORE_WEIGHTS["isolation_forest"] * if_score
    ), 2)

    # 4. Top 3 Feature Contributions
    top_3_contributions = compute_top_feature_contributions(supervised_pipe, input_df, feature_order)

    return {
        "model_version": model_version,
        "random_forest": supervised_decision,
        "random_forest_probability": round(calibrated_prob, 4),
        "isolation_forest": iso_decision,
        "isolation_forest_anomaly_score": round(if_score, 4),
        "isolation_forest_decision": round(float(raw_dec), 4),
        "risk_score": risk_score,
        "operating_threshold": round(operating_threshold, 4),
        "feature_contributions": top_3_contributions,
        "low_confidence": is_low_confidence,
        "random_forest_status": None,
        "isolation_forest_status": None,
    }


def predict_v1(features: dict) -> dict:
    """Legacy v1 prediction fallback."""
    missing = [name for name in FEATURES if features.get(name) is None]
    if missing:
        raise ValueError("Missing active features: " + ", ".join(missing))

    vector = np.array([[float(features[name]) for name in FEATURES]], dtype=float)
    input_frame = pd.DataFrame(vector, columns=FEATURES)

    result = {
        "model_version": "v1.0.0-legacy",
        "random_forest": None,
        "isolation_forest": None,
        "risk_score": None,
        "random_forest_status": None,
        "isolation_forest_status": None,
        "random_forest_probability": None,
        "isolation_forest_anomaly_score": None,
        "isolation_forest_decision": None,
        "feature_contributions": [],
        "low_confidence": False,
    }
    rf_prob = None
    if rf_model is not None:
        try:
            rf_pred = int(rf_model.predict(input_frame)[0])
            result["random_forest"] = "cheater" if rf_pred == 1 else "normal"
            if hasattr(rf_model, "predict_proba"):
                probs = rf_model.predict_proba(input_frame)[0]
                rf_prob = float(probs[1]) if len(probs) > 1 else float(probs[0])
                result["random_forest_probability"] = rf_prob
        except Exception:
            result["random_forest_status"] = "prediction_error"

    if iso_model is not None and scaler is not None:
        try:
            scaled = scaler.transform(input_frame)
            iso_pred = int(iso_model.predict(scaled)[0])
            result["isolation_forest"] = "anomaly" if iso_pred == -1 else "normal"
            dec = iso_model.decision_function(scaled)
            result["isolation_forest_anomaly_score"] = normalize_isolation_decision(dec)
        except Exception:
            result["isolation_forest_status"] = "prediction_error"

    if rf_prob is not None and result["isolation_forest_anomaly_score"] is not None:
        result["risk_score"] = calculate_risk_score(rf_prob, result["isolation_forest_anomaly_score"])

    return result


def predict(features: dict) -> dict:
    """Unified entry point for live match anti-cheat analysis."""
    if artifact_v2 is not None:
        return predict_v2(features)
    return predict_v1(features)

APPROVED_MODEL_ARTIFACTS = {
    "v2.0-rf": ("model_v2.joblib", predict_v2),
    "v1.5-rf": ("random_forest.pkl + isolation_forest.pkl + scaler.pkl", predict_v1),
}


def predict_selected(features, version):
    if version is None:
        return predict(features)
    if version not in APPROVED_MODEL_ARTIFACTS:
        raise ValueError("Unapproved model version")
    result = APPROVED_MODEL_ARTIFACTS[version][1](features)
    if result.get("risk_score") is None:
        raise ValueError("Selected model could not produce a score")
    return result


def probe_model(version):
    import math

    result = predict_selected(dict.fromkeys([*FEATURES, *FEATURE_NAMES_V2], 0.0), version)
    score = result.get("risk_score")
    if score is None or not math.isfinite(score):
        raise ValueError("The model did not produce a finite score")
    return result
