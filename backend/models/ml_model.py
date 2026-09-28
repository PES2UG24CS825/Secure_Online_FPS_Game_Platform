from pathlib import Path
import joblib
import numpy as np

MODEL_DIR = Path(__file__).resolve().parent
RF_PATH = MODEL_DIR / "random_forest.pkl"
IF_PATH = MODEL_DIR / "isolation_forest.pkl"
SCALER_PATH = MODEL_DIR / "scaler.pkl"

rf_model = joblib.load(RF_PATH) if RF_PATH.exists() else None
iso_model = joblib.load(IF_PATH) if IF_PATH.exists() else None
scaler = joblib.load(SCALER_PATH) if SCALER_PATH.exists() else None

FEATURES = [
    "reaction_time",
    "accuracy",
    "headshot_ratio",
    "fire_rate",
    "movement_speed",
    "aim_smoothness",
    "kdr",
]

def predict(features: dict):
    vector = np.array([[float(features[name]) for name in FEATURES]])

    result = {
        "random_forest": None,
        "isolation_forest": None,
        "risk_score": None,
    }

    if rf_model is not None:
        model_features = getattr(rf_model, "n_features_in_", len(FEATURES))
        if model_features == len(FEATURES):
            rf_pred = int(rf_model.predict(vector)[0])
            result["random_forest"] = "cheater" if rf_pred == 1 else "normal"
            if hasattr(rf_model, "predict_proba"):
                probs = rf_model.predict_proba(vector)[0]
                classes = list(rf_model.classes_)
                if 1 in classes:
                    result["risk_score"] = float(probs[classes.index(1)])
        else:
            result["random_forest_status"] = "model_feature_mismatch"

    if iso_model is not None:
        model_features = getattr(iso_model, "n_features_in_", len(FEATURES))
        scaler_features = getattr(scaler, "n_features_in_", None)
        if model_features == len(FEATURES) and scaler_features == len(FEATURES):
            scaled_vector = scaler.transform(vector)
            iso_pred = int(iso_model.predict(scaled_vector)[0])
            result["isolation_forest"] = "anomaly" if iso_pred == -1 else "normal"
        elif scaler is None:
            result["isolation_forest_status"] = "scaler_unavailable"
        else:
            result["isolation_forest_status"] = "model_feature_mismatch"

    return result
