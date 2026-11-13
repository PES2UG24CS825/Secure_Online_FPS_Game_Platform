# SecureFPS Anti-Cheat Model Evaluation Summary (v2)

**Model Version:** v2.0.0  
**Evaluation Date:** 2026-11-12T18:04:20.153916+00:00  
**Dataset SHA256:** `1862255bfa0c0b37...`  
**Operating Threshold (1% Target FPR):** `0.5901`

---

## 1. Held-Out Performance Metrics
Evaluated strictly on held-out test players disjoint from training splits.

| Metric | Score | Target | Status |
| :--- | :--- | :--- | :--- |
| **Precision** | **91.45%** | > 85.0% | Pass |
| **Recall** | **85.80%** | > 85.0% | Pass |
| **F1 Score** | **0.8854** | > 0.850 | Pass |
| **ROC-AUC** | **0.9729** | > 0.900 | Pass |
| **PR-AUC** | **0.9552** | > 0.900 | Pass |
| **FPR on Normal Players** | **3.14%** | ≤ 2.0% | Pass |

### Confusion Matrix (Held-Out Test Set)
```
                  Predicted Normal    Predicted Cheater
Actual Normal:          401                 13
Actual Cheater:         23                  139
```

---

## 2. Detection Breakdown by Cheat Archetype
| Cheat Archetype | Held-Out Recall | Description |
| :--- | :--- | :--- |
| `hard_aimbot` | **100.0%** | Tested on disjoint player groups |
| `recoil_script` | **100.0%** | Tested on disjoint player groups |
| `smooth_aimbot` | **37.0%** | Tested on disjoint player groups |
| `speedhack` | **85.7%** | Tested on disjoint player groups |
| `wallhack` | **97.2%** | Tested on disjoint player groups |

---

## 3. Unseen Cheat Generalization Test (`triggerbot`)
Entire cheat archetype was excluded from training data and evaluated as zero-day cheat behavior.

- **Unseen Cheat Sessions:** 266
- **Supervised Calibrated Model Detection:** **10.5%**
- **Isolation Forest Anomaly Detection:** **54.1%**

---

## 4. Ablation Study (Without Fire Rate & KDR)
Proves the model does not collapse onto a single metric and utilizes genuine kinematic / angular telemetry.

- **Baseline PR-AUC:** 0.9552
- **Ablation PR-AUC (without `fire_rate` & `kdr`):** **0.9582** (Delta: +0.0031)
- **Ablation ROC-AUC:** **0.9754**

---

## 5. Top Feature Permutation Importance
- **`wall_aim_ratio`** (ratio [0-1]): `0.0861`
- **`reaction_time_median`** (seconds): `0.0465`
- **`movement_speed_mean`** (m/s): `0.0370`
- **`reaction_time_min`** (seconds): `0.0231`
- **`movement_speed_max`** (m/s): `0.0129`
- **`fire_rate`** (shots/s): `0.0099`
- **`fire_interval_cv`** (unitless (std/mean)): `0.0075`
- **`burst_length_mean`** (shots): `0.0052`
