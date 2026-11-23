# SecureFPS Complete Technical Documentation

## 1. System overview

SecureFPS uses Flask for authentication, player/admin APIs, MongoDB persistence, and gameplay telemetry; Three.js and Unity provide game clients; a Node.js Socket.IO server arbitrates multiplayer. The v2 anti-cheat bundle is a calibrated supervised classifier plus Isolation Forest anomaly scoring.

## 2. Authentication and roles

- Passwords are verified with stored bcrypt hashes in `backend/services/auth.py`.
- MFA is a TOTP code from the stored account secret. Pending MFA state is held only in Flask session.
- Recovery codes are consumed with `backend/services/auth_security.py:verify_backup_recovery_code()`.
- Sessions are stored in `sessions`; logout revokes the active record.
- Roles are `player`, `normal_admin`, `super_admin`, and optionally `demo_admin`.
- Local development may create configured admin accounts. Privileged operations require the project CSRF controls and reauthentication.
- Login does not automatically replace an active session anymore; takeover requires an explicit `takeover` or `replace` request.

## 3. Actual Random Forest implementation

The runtime v2 bundle is loaded in `backend/models/ml_model.py` from `backend/models/model_v2.joblib`. Legacy fallbacks load `random_forest.pkl`, `isolation_forest.pkl`, and `scaler.pkl`.

For v2, `predict_v2()`:

1. Builds a row with `metadata_v2["feature_order"]`.
2. Calls `supervised_pipeline.predict_proba()`.
3. Selects probability for class `1`.
4. Maps the calibrated probability to `normal` or `cheater` using `operating_threshold`.

The project does not assume label meaning independently. Training code in `backend/models/train_v2.py` uses `label`; model metadata identifies cheat labels as `1` and normal labels as `0`. Model results are therefore:

| Label | Meaning |
|---|---|
| 0 | Normal sample in the training data |
| 1 | Cheat/suspicious sample in the training data |

The TOTP/recovery login and anti-cheat systems are independent.

## 4. Random Forest probability

`predict_v2()` uses `predict_proba()` and class `1`. For an illustrative result:

- Normal probability: 0.20
- Suspicious/label-1 probability: 0.80
- RF score: `0.80`

This is model confidence for the label-1 class, not a calibrated probability that a real player is cheating. Class calibration and operating-threshold selection are performed during training.

## 5. Actual feature extraction

Feature extraction is implemented by `extract_features_v2()` in `backend/services/features_v2.py`. It requires at least 10 shots and 20 seconds unless enforcement is disabled.

| Feature | Unit |
|---|---|
| accuracy | 0–1 |
| headshot_ratio | 0–1 |
| reaction_time_median | seconds |
| reaction_time_min | seconds |
| fire_rate | shots/second |
| fire_interval_cv | coefficient of variation |
| burst_length_mean | shots |
| movement_speed_mean / max / std | metres/second |
| aim_speed_mean / std / max | degrees/second |
| flick_rate | flicks/minute |
| aim_error_at_fire_mean / std | degrees |
| snap_to_hit_ratio | 0–1 |
| wall_aim_ratio | 0–1 |
| kdr | kills/deaths ratio |
| time_to_kill_median | seconds |
| shots_per_kill | shots/kill |

Raw events are read from `game_telemetry`. The feature extractor consumes `weapon_fire`, `enemy_hit`, `hit_detail`, `target_acquired`, `aim_sample`, `aim_behavior`, `movement_sample`, `player_kill`, and `player_death` event types.

## 6. Isolation Forest implementation

The v2 Isolation Forest pipeline is stored in the model bundle and trained on normal training rows only in `backend/models/train_v2.py`. The pipeline contains imputation, scaling, and `IsolationForest(n_estimators=100, contamination=0.01, random_state=42)`.

`decision_function()` returns a signed value: lower values are more anomalous. SecureFPS transforms it as:

`IF Score = clip((p99 - raw_decision) / (p99 - p1), 0, 1)`

The percentile bounds `p1` and `p99` are stored in `model_metadata.json`. The v2 metadata currently contains `p1 = 4.9873299934333204e-18` and `p99 = 0.1586607874871954`.

Isolation Forest is anomaly detection, not a conventional probability of cheating. It does not prove cheating.

## 7. Final actual risk formula

The v2 runtime and legacy `calculate_risk_score()` use:

`Final Risk = 100 × (0.60 × RF Suspicious Probability + 0.40 × IF Anomaly Score)`

The weights are stored in `RISK_SCORE_WEIGHTS` in `backend/models/ml_model.py`. A missing v2 model output does not become a zero-risk fact; model status and low-confidence fields are returned separately.

Illustrative example:

| Component | Value |
|---|---|
| RF suspicious probability | 0.80 |
| IF anomaly score | 0.30 |
| Final risk | `100 × (0.60×0.80 + 0.40×0.30) = 60.0` |

This is a model-derived risk score, not a confirmed-cheating probability.

## 8. Risk categories

The `backend/services/risk_scoring.py` service supplies shared clamping and categories. Dashboard thresholds and backend enforcement must be read from this service and route conditionals; they are not assumed from README text.

Missing or low-confidence model output must remain unavailable or under review rather than being silently interpreted as a proven violation.

## 9. Model lifecycle

Actual lifecycle:

1. Raw telemetry is stored in MongoDB.
2. `extract_features_v2()` creates model inputs.
3. `predict_v2()` loads `model_v2.joblib`.
4. Random Forest and Isolation Forest outputs are calculated.
5. Weighted risk is calculated.
6. Analysis is stored and exposed through backend APIs.
7. Player/admin dashboards render persisted or live analysis.

Training code is `backend/models/train_v2.py`. It uses grouped player splits, holds out triggerbot unseen data, compares logistic, random forest, and histogram-gradient classifiers, calibrates the winner, sets operating threshold at normal-training 99th percentile, and trains Isolation Forest on normal rows.

## 10. Training and evaluation

The training script writes `model_v2.joblib`, `model_metadata.json`, `evaluation_report.json`, and `evaluation_summary.md`. Evaluation fields include precision, recall, F1, ROC-AUC, PR-AUC, confusion matrix, normal false-positive rate, and per-cheat recall.

No backend startup seeding may invent model metrics. Model catalog rows retain metadata and set metrics unavailable unless backed by an evaluation artifact.

## 11. Gameplay statistics

Career and match combat values are resolved through `backend/services/combat_statistics.py`.

- Shots: unique server-confirmed shot events.
- Hits: unique server-confirmed hit events.
- Accuracy: `successful hits / total shots × 100`.
- K/D: `total kills / total deaths`; use zero-death handling consistently with the route/UI implementation.
- If historical shots or hits are missing, the API labels coverage unavailable or partial instead of substituting 0.

The multiplayer client must not count predicted hits. Server-confirmed events use shot IDs and backend idempotency.

## 12. Player dashboard

`frontend/player.html` and `frontend/js/player.js` render account profile, match history, combat statistics, rewards, inventory, purchases, security alerts, and login activity. Data comes from `/api/player/*` routes in `backend/routes/player_routes.py` and MongoDB collections. Missing data is rendered as unavailable or empty, not as fake records.

Match details use resolved match summary and telemetry before aggregation. Career values are not calculated from partial or duplicate telemetry.

## 13. Normal-admin dashboard

`frontend/admin.html` and `frontend/js/admin/admin_players.js` plus `frontend/js/admin/*` render player management and investigation views. `/api/admin/*` is enforced by `require_normal_admin`, `require_admin`, permissions, CSRF checks, and reauthentication for sensitive operations.

Normal admins may perform permissions granted to their role. Permanent bans and deletions follow approval or super-admin restrictions where implemented.

## 14. Super-admin dashboard

Super-admin operations are implemented in `backend/routes/admin_routes.py` and authorized by `require_super_admin`. They include administrator management, permissions, model catalog, system configuration, backups, and audit/log data.

Saved permissions are tested by backend authorization helpers; a frontend button alone is not authorization.

Model values are unavailable unless sourced from a real evaluation report or loaded model artifact. Backup listings include only recoverable archives with matching checksums and valid structure.

## 15. MongoDB

Important collections:

| Collection | Purpose |
|---|---|
| users | accounts, roles, MFA secret, account status |
| sessions | active authenticated sessions |
| login_history | login success/failure records |
| game_sessions | match session and event count |
| game_telemetry | raw confirmed gameplay events |
| game_events | processed analysis events |
| security_events | security and anti-cheat events |
| matches | legacy match records |
| reward_transactions | exactly-once reward credit ledgers |
| honour_history | honour changes |
| ban_appeals | appeals |
| player_notifications | notifications |
| admin_audit_log | administrative audit entries |
| system_backups | backup metadata |
| model_versions | model catalog metadata |

## 16. Bot Combat and limits

Bot Combat and authoritative multiplayer use 15 kills or 480 seconds. Training and Free Roam retain their non-expiring behavior. Multiplayer limits are set and enforced server-side. Local rematches/restarts reset the complete local lifecycle.

## 17. Local pause, wall blocking, restart, and reconnect

Local pause freezes Bot Combat/Training simulation and timers. Weapon raycasts compare nearer scenery against target hitboxes. Restart resets bots, ammo, spawn protection, timer, statistics, and local telemetry. Multiplayer reconnect restores server-authoritative position, health, stats, remaining time, and match state.

## 18. API and frontend flow

Authentication: HTML/JavaScript → `/api/auth/*` → Flask route → MongoDB → session/cookie.

Player data: player page → `/api/player/*` → route/service → collections → JSON → JavaScript.

Admin data/actions: admin page → `/api/admin/*` → authorization/CSRF/re-auth → MongoDB/audit → JSON.

Gameplay: game JS → telemetry and Socket.IO → Node/Flask authority → MongoDB → dashboard.

## 19. Actual code references

Primary references:

- `backend/app.py`: startup, admin seeding, Flask configuration.
- `backend/routes/auth_routes.py`: login, MFA, recovery, logout.
- `backend/routes/player_routes.py`: player APIs.
- `backend/routes/admin_routes.py`: admin/super-admin APIs.
- `backend/routes/game_routes.py`: telemetry and session APIs.
- `backend/models/ml_model.py`: model loading and prediction.
- `backend/models/train_v2.py`: model training and evaluation.
- `backend/services/features_v2.py`: feature extraction.
- `backend/services/risk_scoring.py`: shared risk categories.
- `backend/services/combat_statistics.py`: combat stat resolution.
- `backend/services/database_backup.py`: backup validation.
- `frontend/player.html`, `frontend/js/player.js`: player UI.
- `frontend/admin.html`, `frontend/js/admin/*`: admin UI.
- `frontend/public/games/three-fps/js/*`: gameplay UI and simulation.
- `multiplayer-server/server.js`: authoritative multiplayer.

## 20. Limitations and worked examples

Model predictions are not automatic evidence of cheating. No automatic ban should be based only on RF/IF output. Server-validated physical evidence and human review are required for restrictive actions.

Combat example: 20 successful hits, 80 shots, 12 kills, 3 deaths:

- Accuracy: `20 / 80 × 100 = 25%`
- K/D: `12 / 3 = 4.0`

An old match with missing shots/hits must display unavailable coverage rather than 0.