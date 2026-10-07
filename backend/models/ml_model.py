from pathlib import Path
import joblib
import numpy as np
import pandas as pd

MODEL_DIR = Path(__file__).resolve().parent
RF_PATH = MODEL_DIR / "random_forest.pkl"
IF_PATH = MODEL_DIR / "isolation_forest.pkl"
SCALER_PATH = MODEL_DIR / "scaler.pkl"

rf_model = joblib.load(RF_PATH) if RF_PATH.exists() else None
iso_model = joblib.load(IF_PATH) if IF_PATH.exists() else None
scaler = joblib.load(SCALER_PATH) if SCALER_PATH.exists() else None

# Active telemetry contract. Both models receive these five values in this order.
FEATURES = [

    "accuracy",

    "fire_rate",

    "movement_speed",

    "aim_smoothness",

    "kdr",
]

# Original training feature order retained for future model retraining.
LEGACY_FEATURES = [
    "reaction_time",
    "accuracy",
    "headshot_ratio",
    "fire_rate",
    "movement_speed",
    "aim_smoothness",
    "kdr",
]

# Risk = 100 * (0.70 * RF cheater probability + 0.30 * IF anomaly signal).
# The IF component is 1 for anomaly and 0 for normal; weights must sum to 1.
RISK_SCORE_WEIGHTS = {
    "random_forest": 0.70,
    "isolation_forest": 0.30,
}

def _feature_contract_error(model_name, artifact, actual_features):
    expected_count = getattr(artifact, "n_features_in_", None)
    actual_count = len(FEATURES)
    expected_names = getattr(artifact, "feature_names_in_", None)

    if expected_count != actual_count:
        print(
            f"[SecureFPS] {model_name} feature mismatch: "
            f"expected model feature count={expected_count}, "
            f"actual input feature count={actual_count}"
        )
        return "model_feature_mismatch"

    if expected_names is not None and list(expected_names) != actual_features:
        print(
            f"[SecureFPS] {model_name} feature order mismatch: "
            f"expected={list(expected_names)}, actual={actual_features}; "
            f"expected model feature count={expected_count}, "
            f"actual input feature count={actual_count}"
        )
        return "model_feature_mismatch"

    return None


def predict(features: dict):
    missing = [name for name in FEATURES if features.get(name) is None]
    if missing:
        raise ValueError("Missing active features: " + ", ".join(missing))

    vector = np.array([[float(features[name]) for name in FEATURES]], dtype=float)
    if not np.isfinite(vector).all():
        raise ValueError("Active features must contain finite numeric values")

    input_frame = pd.DataFrame(vector, columns=FEATURES)

    result = {
        "random_forest": None,
        "isolation_forest": None,
        "risk_score": None,
        "random_forest_status": None,
        "isolation_forest_status": None,
    }
    rf_cheater_probability = None

    if rf_model is not None:
        mismatch = _feature_contract_error(
            "Random Forest",
            rf_model,
            FEATURES
        )
        if mismatch:
            result["random_forest_status"] = mismatch
        else:
            try:
                rf_pred = int(rf_model.predict(input_frame)[0])
                if rf_pred not in (0, 1):
                    raise ValueError(f"Unexpected Random Forest class: {rf_pred}")
                result["random_forest"] = "cheater" if rf_pred == 1 else "normal"
                if hasattr(rf_model, "predict_proba"):
                    probs = rf_model.predict_proba(input_frame)[0]
                    classes = list(rf_model.classes_)
                    if 1 in classes:
                        rf_cheater_probability = float(probs[classes.index(1)])
                        if (
                            not np.isfinite(rf_cheater_probability)
                            or not 0 <= rf_cheater_probability <= 1
                        ):
                            rf_cheater_probability = None
                            result["random_forest_status"] = "invalid_risk_probability"
                    else:
                        result["random_forest_status"] = "risk_probability_unavailable"
                else:
                    result["random_forest_status"] = "risk_probability_unavailable"
            except Exception as exc:
                print("[SecureFPS] Random Forest prediction failed:", exc)
                result["random_forest_status"] = "prediction_error"
    else:
        result["random_forest_status"] = "model_unavailable"

    if iso_model is not None:
        if scaler is None:
            result["isolation_forest_status"] = "scaler_unavailable"
        else:
            model_mismatch = _feature_contract_error(
                "Isolation Forest",
                iso_model,
                FEATURES
            )
            scaler_mismatch = _feature_contract_error(
                "Isolation Forest scaler",
                scaler,
                FEATURES
            )
            mismatch = model_mismatch or scaler_mismatch
            if mismatch:
                result["isolation_forest_status"] = mismatch
            else:
                try:
                    scaled_values = scaler.transform(input_frame)
                    scaled_frame = pd.DataFrame(
                        scaled_values,
                        columns=FEATURES
                    )
                    iso_pred = int(iso_model.predict(scaled_frame)[0])
                    if iso_pred not in (-1, 1):
                        raise ValueError(f"Unexpected Isolation Forest output: {iso_pred}")
                    result["isolation_forest"] = "anomaly" if iso_pred == -1 else "normal"
                except Exception as exc:
                    print("[SecureFPS] Isolation Forest prediction failed:", exc)
                    result["isolation_forest_status"] = "prediction_error"
    else:
        result["isolation_forest_status"] = "model_unavailable"

    if (
        result["random_forest_status"] is None
        and result["isolation_forest_status"] is None
        and rf_cheater_probability is not None
        and result["isolation_forest"] is not None
    ):
        weights_total = sum(RISK_SCORE_WEIGHTS.values())
        if weights_total != 1.0:
            raise ValueError("RISK_SCORE_WEIGHTS must sum to 1.0")

        isolation_anomaly_signal = float(
            result["isolation_forest"] == "anomaly"
        )
        result["risk_score"] = round(
            100.0 * (
                RISK_SCORE_WEIGHTS["random_forest"] * rf_cheater_probability
                + RISK_SCORE_WEIGHTS["isolation_forest"] * isolation_anomaly_signal
            ),
            2
        )

    return result
