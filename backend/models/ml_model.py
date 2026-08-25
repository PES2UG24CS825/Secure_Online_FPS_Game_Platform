from pathlib import Path
import joblib
import numpy as np

BASE = Path(__file__).resolve().parents[2]
RF_PATH = BASE / "ml_models" / "random_forest_model.pkl"
IF_PATH = BASE / "ml_models" / "isolation_forest_model.pkl"

rf_model = joblib.load(RF_PATH) if RF_PATH.exists() else None
iso_model = joblib.load(IF_PATH) if IF_PATH.exists() else None

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
        rf_pred = int(rf_model.predict(vector)[0])
        result["random_forest"] = "cheater" if rf_pred == 1 else "normal"
        if hasattr(rf_model, "predict_proba"):
            probs = rf_model.predict_proba(vector)[0]
            classes = list(rf_model.classes_)
            if 1 in classes:
                result["risk_score"] = float(probs[classes.index(1)])

    if iso_model is not None:
        iso_pred = int(iso_model.predict(vector)[0])
        result["isolation_forest"] = "anomaly" if iso_pred == -1 else "normal"

    return result
