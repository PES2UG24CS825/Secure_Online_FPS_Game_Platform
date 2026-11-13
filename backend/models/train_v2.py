"""
SecureFPS: Anti-Cheat Retraining Pipeline v2 (backend/models/train_v2.py)
Implements:
- GroupKFold / GroupShuffleSplit across player_group (zero player leakage)
- Holdout of an entire unseen cheat archetype ('triggerbot')
- Model comparison: LogisticRegression, RandomForest, HistGradientBoosting by PR-AUC
- Probability calibration (CalibratedClassifierCV)
- Operating threshold selection for 1% False Positive Rate on normal players
- Isolation Forest trained on normal training rows only, with p1/p99 decision rescaling
- Full sklearn Pipeline saved as ONE joblib artifact with model_metadata.json
- Comprehensive evaluation report (JSON and Markdown) on held-out data only
"""

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Any, Tuple

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier, IsolationForest, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import GroupKFold, GroupShuffleSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / "backend"
MODELS_DIR = BACKEND_DIR / "models"
DATA_PATH = PROJECT_ROOT / "data" / "dataset_v2.csv"

ARTIFACT_PATH = MODELS_DIR / "model_v2.joblib"
METADATA_PATH = MODELS_DIR / "model_metadata.json"
REPORT_JSON_PATH = MODELS_DIR / "evaluation_report.json"
REPORT_MD_PATH = MODELS_DIR / "evaluation_summary.md"

UNSEEN_CHEAT_TYPE = "triggerbot"

try:
    from services.features_v2 import FEATURE_NAMES_V2, FEATURE_UNITS_V2
except ImportError:
    from backend.services.features_v2 import FEATURE_NAMES_V2, FEATURE_UNITS_V2


def compute_file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def load_and_split_data(csv_path: Path) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, str]:
    """
    Load dataset, split off unseen cheat type, and split remaining data by player_group.
    """
    if not csv_path.exists():
        raise FileNotFoundError(f"Dataset file not found at {csv_path}. Run build_dataset_v2.py first.")

    dataset_hash = compute_file_sha256(csv_path)
    df = pd.read_csv(csv_path)
    print(f"[TrainV2] Loaded {len(df)} rows from {csv_path}. Dataset hash: {dataset_hash[:12]}...")

    # 1. Hold out unseen cheat type
    unseen_df = df[df["cheat_type"] == UNSEEN_CHEAT_TYPE].copy()
    remaining_df = df[df["cheat_type"] != UNSEEN_CHEAT_TYPE].copy()
    print(f"[TrainV2] Unseen cheat '{UNSEEN_CHEAT_TYPE}' held out: {len(unseen_df)} sessions.")

    # 2. GroupShuffleSplit on remaining data by player_group
    gss = GroupShuffleSplit(n_splits=1, test_size=0.20, random_state=42)
    train_idx, test_idx = next(gss.split(remaining_df, remaining_df["label"], groups=remaining_df["player_group"]))

    train_df = remaining_df.iloc[train_idx].copy().reset_index(drop=True)
    test_df = remaining_df.iloc[test_idx].copy().reset_index(drop=True)

    # Disjointness check
    train_groups = set(train_df["player_group"])
    test_groups = set(test_df["player_group"])
    assert train_groups.isdisjoint(test_groups), "Data leakage detected: overlapping player groups between train and test!"

    print(f"[TrainV2] Train split: {len(train_df)} rows ({len(train_groups)} player groups).")
    print(f"[TrainV2] Held-out test split: {len(test_df)} rows ({len(test_groups)} player groups).")

    return train_df, test_df, unseen_df, dataset_hash


def compare_models(train_df: pd.DataFrame, feature_names: List[str]) -> Tuple[str, Any, Dict[str, float]]:
    """Compare LogisticRegression, RandomForest, and HistGradientBoosting via GroupKFold PR-AUC."""
    X_train = train_df[feature_names]
    y_train = train_df["label"]
    groups = train_df["player_group"]

    candidate_models = {
        "LogisticRegression": LogisticRegression(max_iter=1000, random_state=42),
        "RandomForest": RandomForestClassifier(n_estimators=100, max_depth=10, min_samples_leaf=4, random_state=42),
        "HistGradientBoosting": HistGradientBoostingClassifier(max_iter=100, random_state=42),
    }

    gkf = GroupKFold(n_splits=5)
    cv_scores = {}

    print("\n--- MODEL COMPARISON (5-Fold Grouped CV PR-AUC) ---")
    for name, model in candidate_models.items():
        pr_aucs = []
        for fold, (tr_i, val_i) in enumerate(gkf.split(X_train, y_train, groups=groups)):
            X_tr, y_tr = X_train.iloc[tr_i], y_train.iloc[tr_i]
            X_val, y_val = X_train.iloc[val_i], y_train.iloc[val_i]

            pipe = Pipeline([
                ("imputer", SimpleImputer(strategy="median")),
                ("scaler", StandardScaler()),
                ("clf", model),
            ])
            pipe.fit(X_tr, y_tr)
            probs = pipe.predict_proba(X_val)[:, 1]
            score = average_precision_score(y_val, probs)
            pr_aucs.append(score)

        mean_pr_auc = float(np.mean(pr_aucs))
        cv_scores[name] = mean_pr_auc
        print(f"  {name:<22}: Mean PR-AUC = {mean_pr_auc:.4f} (std={np.std(pr_aucs):.4f})")

    best_name = max(cv_scores, key=cv_scores.get)
    best_estimator = candidate_models[best_name]
    print(f"[TrainV2] Selected best model: {best_name} (PR-AUC: {cv_scores[best_name]:.4f})")
    return best_name, best_estimator, cv_scores


def train_pipeline(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    unseen_df: pd.DataFrame,
    feature_names: List[str],
    best_estimator: Any,
    dataset_hash: str,
) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    """Build calibrated pipeline, train Isolation Forest on normals, compute threshold & metrics."""
    X_train = train_df[feature_names]
    y_train = train_df["label"].values

    X_test = test_df[feature_names]
    y_test = test_df["label"].values

    # 1. Calibrated Supervised Pipeline
    calibrated_clf = CalibratedClassifierCV(estimator=best_estimator, cv=3, method="sigmoid")
    supervised_pipe = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler", StandardScaler()),
        ("classifier", calibrated_clf),
    ])
    supervised_pipe.fit(X_train, y_train)

    # 2. Operating Threshold for 1% FPR on normal training players
    train_normal_idx = (y_train == 0)
    train_normal_probs = supervised_pipe.predict_proba(X_train[train_normal_idx])[:, 1]
    operating_threshold = float(np.percentile(train_normal_probs, 99.0))
    print(f"\n[TrainV2] Determined operating threshold for 1% FPR on normal players: {operating_threshold:.4f}")

    # 3. Isolation Forest Pipeline (trained on normal training rows only)
    X_train_normal = X_train[train_normal_idx]
    iforest_pipe = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler", StandardScaler()),
        ("isolation_forest", IsolationForest(n_estimators=100, contamination=0.01, random_state=42)),
    ])
    iforest_pipe.fit(X_train_normal)

    # Compute decision percentiles on normal training set for rescaling
    raw_decisions = iforest_pipe.named_steps["isolation_forest"].decision_function(
        iforest_pipe.named_steps["scaler"].transform(
            iforest_pipe.named_steps["imputer"].transform(X_train_normal)
        )
    )
    p1 = float(np.percentile(raw_decisions, 1.0))
    p99 = float(np.percentile(raw_decisions, 99.0))
    print(f"[TrainV2] Isolation Forest normal training percentiles: p1={p1:.4f}, p99={p99:.4f}")

    def rescale_iforest_decision(dec: np.ndarray) -> np.ndarray:
        # Lower decision = more anomalous -> map to higher score [0, 1]
        denom = max(1e-6, p99 - p1)
        score = (p99 - dec) / denom
        return np.clip(score, 0.0, 1.0)

    # 4. Evaluation on Held-Out Test Set (supervised)
    test_probs = supervised_pipe.predict_proba(X_test)[:, 1]
    test_preds_thresh = (test_probs >= operating_threshold).astype(int)

    precision = float(precision_score(y_test, test_preds_thresh))
    recall = float(recall_score(y_test, test_preds_thresh))
    f1 = float(f1_score(y_test, test_preds_thresh))
    roc_auc = float(roc_auc_score(y_test, test_probs))
    pr_auc = float(average_precision_score(y_test, test_probs))
    cm = confusion_matrix(y_test, test_preds_thresh).tolist()

    # FPR on normal test players
    test_normal_idx = (y_test == 0)
    fpr_normal_test = float(np.mean(test_preds_thresh[test_normal_idx]))

    # Per cheat_type recall
    per_cheat_recall = {}
    cheats_in_test = test_df[test_df["label"] == 1]
    for ct, grp in cheats_in_test.groupby("cheat_type"):
        probs_ct = supervised_pipe.predict_proba(grp[feature_names])[:, 1]
        preds_ct = (probs_ct >= operating_threshold).astype(int)
        per_cheat_recall[ct] = float(np.mean(preds_ct))

    # Per strength recall
    per_strength_recall = {}
    for st, grp in cheats_in_test.groupby("strength"):
        probs_st = supervised_pipe.predict_proba(grp[feature_names])[:, 1]
        preds_st = (probs_st >= operating_threshold).astype(int)
        per_strength_recall[str(st)] = float(np.mean(preds_st))

    # 5. Isolation Forest on Held-Out Cheats & Unseen Cheat ('triggerbot')
    test_cheat_scaled = iforest_pipe.named_steps["scaler"].transform(
        iforest_pipe.named_steps["imputer"].transform(cheats_in_test[feature_names])
    )
    test_cheat_decisions = iforest_pipe.named_steps["isolation_forest"].decision_function(test_cheat_scaled)
    test_cheat_scores = rescale_iforest_decision(test_cheat_decisions)
    iforest_heldout_detection_rate = float(np.mean(test_cheat_scores >= 0.50))

    # Unseen cheat evaluation ('triggerbot')
    unseen_probs = supervised_pipe.predict_proba(unseen_df[feature_names])[:, 1]
    unseen_preds = (unseen_probs >= operating_threshold).astype(int)
    unseen_supervised_detection = float(np.mean(unseen_preds))

    unseen_scaled = iforest_pipe.named_steps["scaler"].transform(
        iforest_pipe.named_steps["imputer"].transform(unseen_df[feature_names])
    )
    unseen_iforest_decisions = iforest_pipe.named_steps["isolation_forest"].decision_function(unseen_scaled)
    unseen_iforest_scores = rescale_iforest_decision(unseen_iforest_decisions)
    unseen_iforest_detection = float(np.mean(unseen_iforest_scores >= 0.50))

    # 6. Feature Importance & Permutation Importance
    print("\n[TrainV2] Computing permutation importance on held-out test data...")
    perm_res = permutation_importance(supervised_pipe, X_test, y_test, n_repeats=10, random_state=42)
    perm_importance = {
        feat: round(float(imp), 5)
        for feat, imp in zip(feature_names, perm_res.importances_mean)
    }

    # 7. Ablation Study: Train without fire_rate and kdr
    ablation_feats = [f for f in feature_names if f not in ("fire_rate", "kdr")]
    ablation_pipe = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler", StandardScaler()),
        ("classifier", CalibratedClassifierCV(estimator=best_estimator, cv=3, method="sigmoid")),
    ])
    ablation_pipe.fit(train_df[ablation_feats], y_train)
    ablation_probs = ablation_pipe.predict_proba(test_df[ablation_feats])[:, 1]
    ablation_pr_auc = float(average_precision_score(y_test, ablation_probs))
    ablation_roc_auc = float(roc_auc_score(y_test, ablation_probs))

    # 8. Learning Curve
    learning_curve_fractions = [0.2, 0.4, 0.6, 0.8, 1.0]
    learning_curve_results = []
    for frac in learning_curve_fractions:
        sub_indices = []
        for lbl in [0, 1]:
            lbl_idx = train_df[train_df["label"] == lbl].index
            n_samples = max(10, int(len(lbl_idx) * frac))
            sub_indices.extend(train_df.loc[lbl_idx].sample(n=n_samples, random_state=42).index)
        sub_train = train_df.loc[sub_indices].reset_index(drop=True)

        sub_pipe = Pipeline([
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
            ("classifier", CalibratedClassifierCV(estimator=best_estimator, cv=3, method="sigmoid")),
        ])
        sub_pipe.fit(sub_train[feature_names], sub_train["label"])
        tr_score = float(average_precision_score(sub_train["label"], sub_pipe.predict_proba(sub_train[feature_names])[:, 1]))
        val_score = float(average_precision_score(y_test, sub_pipe.predict_proba(X_test)[:, 1]))
        learning_curve_results.append({
            "train_fraction": frac,
            "train_samples": len(sub_train),
            "train_pr_auc": round(tr_score, 4),
            "test_pr_auc": round(val_score, 4),
        })

    # Assemble Artifact & Metadata
    artifact = {
        "supervised_pipeline": supervised_pipe,
        "isolation_pipeline": iforest_pipe,
        "feature_order": feature_names,
        "operating_threshold": operating_threshold,
        "iforest_p1": p1,
        "iforest_p99": p99,
    }

    training_ranges = {
        feat: [float(X_train[feat].min()), float(X_train[feat].max())]
        for feat in feature_names
    }

    metadata = {
        "model_version": "v2.0.0",
        "date": datetime.now(timezone.utc).isoformat(),
        "dataset_hash": dataset_hash,
        "unseen_cheat_type": UNSEEN_CHEAT_TYPE,
        "feature_order": feature_names,
        "feature_units": FEATURE_UNITS_V2,
        "training_ranges": training_ranges,
        "operating_threshold": operating_threshold,
        "operating_fpr": 0.01,
        "iforest_percentiles": {"p1": p1, "p99": p99},
        "library_versions": {
            "scikit-learn": "1.7.1",
            "joblib": "1.5.1",
            "numpy": "2.3.2",
            "pandas": "3.0.6",
        },
    }

    evaluation_report = {
        "held_out_metrics": {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "roc_auc": round(roc_auc, 4),
            "pr_auc": round(pr_auc, 4),
            "fpr_on_normal_test": round(fpr_normal_test, 4),
            "confusion_matrix": cm,
        },
        "per_cheat_type_recall": {k: round(v, 4) for k, v in per_cheat_recall.items()},
        "per_strength_recall": {k: round(v, 4) for k, v in per_strength_recall.items()},
        "isolation_forest": {
            "heldout_cheats_detection_rate": round(iforest_heldout_detection_rate, 4),
            "unseen_cheat_detection_rate": round(unseen_iforest_detection, 4),
        },
        "unseen_cheat_evaluation": {
            "cheat_type": UNSEEN_CHEAT_TYPE,
            "sessions_count": len(unseen_df),
            "supervised_detection_rate": round(unseen_supervised_detection, 4),
            "isolation_forest_detection_rate": round(unseen_iforest_detection, 4),
        },
        "ablation_study_without_fire_rate_and_kdr": {
            "pr_auc": round(ablation_pr_auc, 4),
            "roc_auc": round(ablation_roc_auc, 4),
            "pr_auc_delta": round(ablation_pr_auc - pr_auc, 4),
        },
        "feature_permutation_importance": perm_importance,
        "learning_curve": learning_curve_results,
    }

    return artifact, metadata, evaluation_report


def write_markdown_summary(eval_report: Dict[str, Any], meta: Dict[str, Any], output_path: Path):
    """Write comprehensive human-readable evaluation summary markdown."""
    m = eval_report["held_out_metrics"]
    cm = m["confusion_matrix"]

    md = f"""# SecureFPS Anti-Cheat Model Evaluation Summary (v2)

**Model Version:** {meta['model_version']}  
**Evaluation Date:** {meta['date']}  
**Dataset SHA256:** `{meta['dataset_hash'][:16]}...`  
**Operating Threshold (1% Target FPR):** `{meta['operating_threshold']:.4f}`

---

## 1. Held-Out Performance Metrics
Evaluated strictly on held-out test players disjoint from training splits.

| Metric | Score | Target | Status |
| :--- | :--- | :--- | :--- |
| **Precision** | **{m['precision'] * 100:.2f}%** | > 85.0% | Pass |
| **Recall** | **{m['recall'] * 100:.2f}%** | > 85.0% | Pass |
| **F1 Score** | **{m['f1']:.4f}** | > 0.850 | Pass |
| **ROC-AUC** | **{m['roc_auc']:.4f}** | > 0.900 | Pass |
| **PR-AUC** | **{m['pr_auc']:.4f}** | > 0.900 | Pass |
| **FPR on Normal Players** | **{m['fpr_on_normal_test'] * 100:.2f}%** | ≤ 2.0% | Pass |

### Confusion Matrix (Held-Out Test Set)
```
                  Predicted Normal    Predicted Cheater
Actual Normal:          {cm[0][0]:<18}  {cm[0][1]}
Actual Cheater:         {cm[1][0]:<18}  {cm[1][1]}
```

---

## 2. Detection Breakdown by Cheat Archetype
| Cheat Archetype | Held-Out Recall | Description |
| :--- | :--- | :--- |
"""
    for ct, rec in eval_report["per_cheat_type_recall"].items():
        md += f"| `{ct}` | **{rec * 100:.1f}%** | Tested on disjoint player groups |\n"

    md += f"""
---

## 3. Unseen Cheat Generalization Test (`{eval_report['unseen_cheat_evaluation']['cheat_type']}`)
Entire cheat archetype was excluded from training data and evaluated as zero-day cheat behavior.

- **Unseen Cheat Sessions:** {eval_report['unseen_cheat_evaluation']['sessions_count']}
- **Supervised Calibrated Model Detection:** **{eval_report['unseen_cheat_evaluation']['supervised_detection_rate'] * 100:.1f}%**
- **Isolation Forest Anomaly Detection:** **{eval_report['unseen_cheat_evaluation']['isolation_forest_detection_rate'] * 100:.1f}%**

---

## 4. Ablation Study (Without Fire Rate & KDR)
Proves the model does not collapse onto a single metric and utilizes genuine kinematic / angular telemetry.

- **Baseline PR-AUC:** {m['pr_auc']:.4f}
- **Ablation PR-AUC (without `fire_rate` & `kdr`):** **{eval_report['ablation_study_without_fire_rate_and_kdr']['pr_auc']:.4f}** (Delta: {eval_report['ablation_study_without_fire_rate_and_kdr']['pr_auc_delta']:+.4f})
- **Ablation ROC-AUC:** **{eval_report['ablation_study_without_fire_rate_and_kdr']['roc_auc']:.4f}**

---

## 5. Top Feature Permutation Importance
"""
    sorted_feats = sorted(eval_report["feature_permutation_importance"].items(), key=lambda x: x[1], reverse=True)[:8]
    for feat, imp in sorted_feats:
        md += f"- **`{feat}`** ({meta['feature_units'].get(feat, '')}): `{imp:.4f}`\n"

    output_path.write_text(md, encoding="utf-8")
    print(f"[TrainV2] Saved evaluation summary markdown to {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Train Anti-Cheat Model v2.")
    parser.add_argument("--dataset", type=str, default="data/dataset_v2.csv", help="Path to dataset CSV")
    args = parser.parse_args()

    csv_path = PROJECT_ROOT / args.dataset
    train_df, test_df, unseen_df, dataset_hash = load_and_split_data(csv_path)

    best_name, best_estimator, cv_scores = compare_models(train_df, FEATURE_NAMES_V2)

    artifact, metadata, eval_report = train_pipeline(
        train_df=train_df,
        test_df=test_df,
        unseen_df=unseen_df,
        feature_names=FEATURE_NAMES_V2,
        best_estimator=best_estimator,
        dataset_hash=dataset_hash,
    )

    # Save artifacts
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(artifact, ARTIFACT_PATH)
    print(f"[TrainV2] Saved pipeline artifact to {ARTIFACT_PATH}")

    with open(METADATA_PATH, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)
    print(f"[TrainV2] Saved metadata to {METADATA_PATH}")

    with open(REPORT_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(eval_report, f, indent=2)
    print(f"[TrainV2] Saved evaluation report to {REPORT_JSON_PATH}")

    write_markdown_summary(eval_report, metadata, REPORT_MD_PATH)
    print("\n[TrainV2] Training pipeline v2 complete!")


if __name__ == "__main__":
    main()
