"""
Train Isolation Forest ONLY on normal player data.
Independent version (no dependency on Random Forest).
"""

import pandas as pd
import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.preprocessing import StandardScaler
import joblib, os

# ── Paths ─────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(BASE_DIR, "..", "preprocessing", "data preprocessing/processed_dataset.csv")
MODEL_DIR = BASE_DIR

os.makedirs(MODEL_DIR, exist_ok=True)

# ── Features ──────────────────────────────────────────
FEATURES = [
    "Reaction_Time",
    "Accuracy",
    "Headshot_Ratio",
    "Fire_Rate",
    "Movement_Speed",
    "Aim_Smoothness",
    "KDR"
]

# ── Load dataset ──────────────────────────────────────
df = pd.read_csv(DATA_PATH)

X = df[FEATURES].values
y = df["Label"].values

print("=" * 55)
print(" Isolation Forest Training (Independent)")
print("=" * 55)

print(f"\nDataset loaded: {len(df)} rows")
print(f"Normal  (0): {(y == 0).sum()}")
print(f"Cheater (1): {(y == 1).sum()}")

# ── Scaling (IMPORTANT) ───────────────────────────────
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

# Save scaler
scaler_path = os.path.join(MODEL_DIR, "scaler.pkl")
joblib.dump(scaler, scaler_path)

print(f"\nScaler saved → {scaler_path}")

# ── Train ONLY on normal data ─────────────────────────
X_normal = X_scaled[y == 0]
print(f"\nTraining Isolation Forest on {len(X_normal)} normal players...")

iso = IsolationForest(
    n_estimators=300,
    max_samples="auto",
    contamination=0.05,
    random_state=42,
    n_jobs=-1
)

iso.fit(X_normal)

# ── Evaluate on full dataset ──────────────────────────
iso_raw = iso.predict(X_scaled)        # -1 = anomaly
iso_labels = (iso_raw == -1).astype(int)

print("\n=== Isolation Forest Results ===")
print(classification_report(y, iso_labels, target_names=["Normal", "Cheater"]))

print("=== Confusion Matrix ===")
cm = confusion_matrix(y, iso_labels)
print(f"True Normal  : {cm[0][0]}")
print(f"False Alarm  : {cm[0][1]}")
print(f"Missed Cheat : {cm[1][0]}")
print(f"True Cheater : {cm[1][1]}")

# ── Anomaly score analysis ────────────────────────────
scores = iso.decision_function(X_scaled)

print("\n=== Anomaly Score Analysis ===")
print(f"Score range → min: {scores.min():.4f}, max: {scores.max():.4f}")
print(f"Cheater avg score: {scores[y==1].mean():.4f}")
print(f"Normal  avg score: {scores[y==0].mean():.4f}")

# ── Save model ────────────────────────────────────────
model_path = os.path.join(MODEL_DIR, "isolation_forest.pkl")
joblib.dump(iso, model_path)

print(f"\nIsolation Forest saved → {model_path}")