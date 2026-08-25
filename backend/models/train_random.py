"""
Random Forest Training — FINAL VERSION (WITH SMOTE)
Uses processed_dataset.csv from same model folder
"""

import pandas as pd
import numpy as np
import os
import joblib

from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.metrics import classification_report, confusion_matrix
from imblearn.over_sampling import SMOTE

# ─────────────────────────────────────────────
# PATHS (FIXED)
# ─────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DATA_PATH = os.path.join(BASE_DIR, "processed_dataset.csv")
MODEL_PATH = os.path.join(BASE_DIR, "random_forest.pkl")

# ─────────────────────────────────────────────
# FEATURES
# ─────────────────────────────────────────────
FEATURES = [
    "Reaction_Time",
    "Accuracy",
    "Headshot_Ratio",
    "Fire_Rate",
    "Movement_Speed",
    "Aim_Smoothness",
    "KDR",
    "activity_intensity",
    "gameplay_pattern",
]

print("=" * 60)
print("   Random Forest Training (FINAL VERSION)")
print("=" * 60)

# ─────────────────────────────────────────────
# 1. LOAD DATASET
# ─────────────────────────────────────────────
print("\nLoading dataset from:", DATA_PATH)

df = pd.read_csv(DATA_PATH)

print(f"\nDataset Loaded: {len(df)} rows")
print(f"Normal  (0): {(df['Label'] == 0).sum()}")
print(f"Cheater (1): {(df['Label'] == 1).sum()}")

# Clean data
df = df.drop_duplicates()

# Shuffle
df = df.sample(frac=1, random_state=42).reset_index(drop=True)

# ─────────────────────────────────────────────
# 2. PREPARE DATA
# ─────────────────────────────────────────────
X = df[FEATURES].values
y = df["Label"].values

# ─────────────────────────────────────────────
# 3. TRAIN-TEST SPLIT
# ─────────────────────────────────────────────
X_train, X_test, y_train, y_test = train_test_split(
    X, y,
    test_size=0.25,
    random_state=42,
    stratify=y
)

print(f"\nTrain size: {len(X_train)}")
print(f"Test size : {len(X_test)}")

# ─────────────────────────────────────────────
# 4. APPLY SMOTE (TRAIN ONLY)
# ─────────────────────────────────────────────
smote = SMOTE(random_state=42)
X_train, y_train = smote.fit_resample(X_train, y_train)

print("\nAfter SMOTE:")
print(f"Normal  (0): {(y_train == 0).sum()}")
print(f"Cheater (1): {(y_train == 1).sum()}")

# ─────────────────────────────────────────────
# 5. TRAIN MODEL
# ─────────────────────────────────────────────
model = RandomForestClassifier(
    n_estimators=150,
    max_depth=6,
    min_samples_leaf=3,
    random_state=42,
    n_jobs=-1
)

model.fit(X_train, y_train)

print("\nModel Training Completed ✅")

# ─────────────────────────────────────────────
# 6. PREDICTION
# ─────────────────────────────────────────────
y_pred = model.predict(X_test)

# ─────────────────────────────────────────────
# 7. EVALUATION
# ─────────────────────────────────────────────
print("\n=== Classification Report ===")
print(classification_report(y_test, y_pred, target_names=["Normal", "Cheater"]))

print("=== Confusion Matrix ===")
cm = confusion_matrix(y_test, y_pred)

print(f"True Normal  : {cm[0][0]}")
print(f"False Alarm  : {cm[0][1]}")
print(f"Missed Cheat : {cm[1][0]}")
print(f"True Cheater : {cm[1][1]}")

# ─────────────────────────────────────────────
# 8. CROSS VALIDATION
# ─────────────────────────────────────────────
cv_scores = cross_val_score(model, X, y, cv=5)

print(f"\nCross-validation Accuracy: {cv_scores.mean():.4f}")

# ─────────────────────────────────────────────
# 9. FEATURE IMPORTANCE
# ─────────────────────────────────────────────
print("\n=== Feature Importance ===")
for f, imp in sorted(zip(FEATURES, model.feature_importances_), key=lambda x: -x[1]):
    print(f"{f:<20} {imp:.4f}")

# ─────────────────────────────────────────────
# 10. SAVE MODEL
# ─────────────────────────────────────────────
joblib.dump(model, MODEL_PATH)

print(f"\nModel Saved → {MODEL_PATH}")

# ─────────────────────────────────────────────
# 11. SAMPLE PREDICTION
# ─────────────────────────────────────────────
print("\n=== Sample Prediction ===")

sample = np.array([[0.32, 0.88, 0.55, 0.70, 0.62, 0.81, 2.1, 0.71, 0.78]])

pred = model.predict(sample)[0]
result = "Cheater" if pred == 1 else "Normal"

print(f"Prediction: {result}")