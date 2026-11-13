# SecureFPS Dataset Card (v2)

## 1. Overview
`data/dataset_v2.csv` is an anti-cheat feature dataset collected and simulated for the SecureFPS game platform (Flask + MongoDB backend, Unity FPS Microgame, and Three.js WebGL Arena). It replaces the legacy synthetic dataset (`cheating_detection_dataset (1).csv`) with a realistic kinematic, temporal, and combat feature set computed by `backend/services/features_v2.py`.

Unlike legacy data where classes were separated by hard thresholding, Dataset v2 features natural human-like noise, overlapping skill envelopes (where pro humans overlap with subtle smooth aimbots), and real kinematic degrees per second.

## 2. Dataset Schema & Features
The dataset contains 27 columns: 6 session metadata identifiers and 21 numerical v2 features.

### Metadata Columns
- `session_id`: Unique identifier for the match session (`sess_norm_xxxxx`, `sess_cheat_xxxxx`). Contains no revealing class prefixes (no C/N IDs).
- `player_group`: Identifier of the player group / physical player (`human_p01`–`human_p10`, `sim_norm_01`–`sim_norm_25`, `sim_cheat_01`–`sim_cheat_25`). Used for GroupKFold to prevent player identity leakage between train and test splits.
- `source`: `"human"` (recorded live play by team members) or `"simulated"` (scripted simulation via `tools/simulate_sessions.py`).
- `cheat_type`: Archetype of gameplay (`none`, `hard_aimbot`, `smooth_aimbot`, `triggerbot`, `wallhack`, `speedhack`, `recoil_script`).
- `strength`: Continuous cheat assistance intensity in `[0.0, 1.0]`. 0.0 for all legitimate players.
- `label`: Binary classification target (`0` = normal / legitimate human, `1` = cheater).

### Feature Set v2 (Documented Units)
1. `accuracy`: Ratio `[0.0, 1.0]`. Total hits / total weapon fires.
2. `headshot_ratio`: Ratio `[0.0, 1.0]`. Headshot hits / total hits.
3. `reaction_time_median`: Seconds (`s`). Median delay between a target entering the crosshair view cone (`target_acquired`) and the first subsequent shot.
4. `reaction_time_min`: Seconds (`s`). Minimum reaction latency recorded in the match.
5. `fire_rate`: Shots per second (`shots/s`). Rate of fire across active combat duration.
6. `fire_interval_cv`: Unitless (`std / mean`). Coefficient of variation of intervals between consecutive shots within bursts.
7. `burst_length_mean`: Shots (`shots`). Average count of consecutive shots fired before a tactical pause (> 0.45s).
8. `movement_speed_mean`: Meters per second (`m/s`). Mean ground speed from 0.5Hz/2.0s kinematic samples.
9. `movement_speed_max`: Meters per second (`m/s`). Peak movement velocity.
10. `movement_speed_std`: Meters per second (`m/s`). Standard deviation of player movement speed.
11. `aim_speed_mean`: Degrees per second (`deg/s`). Mean angular velocity sampled at 10Hz (every 0.1s).
12. `aim_speed_std`: Degrees per second (`deg/s`). Standard deviation of reticle angular velocity.
13. `aim_speed_max`: Degrees per second (`deg/s`). Peak angular velocity recorded.
14. `flick_rate`: Flicks per minute (`flicks/min`). Frequency of flicks (angular velocity > 400 deg/s followed by a confirmed hit within 0.3s).
15. `aim_error_at_fire_mean`: Degrees (`deg`). Mean angular offset between crosshair and nearest enemy head at moment of trigger pull.
16. `aim_error_at_fire_std`: Degrees (`deg`). Standard deviation of aim error at moment of firing.
17. `snap_to_hit_ratio`: Ratio `[0.0, 1.0]`. Proportion of hits directly following high-speed reticle flicks.
18. `wall_aim_ratio`: Ratio `[0.0, 1.0]`. Proportion of shots fired at targets acquired behind geometry (`visible_through_wall == True`).
19. `kdr`: Ratio. Total kills / max(deaths, 1).
20. `time_to_kill_median`: Seconds (`s`). Median time elapsed from first damaging hit on an enemy to confirmation of enemy elimination.
21. `shots_per_kill`: Shots per kill. Total shots fired / max(kills, 1).

## 3. Data Collection & Simulation Methodology

### a) Legitimate Human Data
Real matches played by team members and authentic players are flagged via `"record_session": true` in `/api/game/start` or the Admin / WebGL UI. Completed human matches are automatically stored in the MongoDB `training_sessions` collection tagged with `source="human"`, `label=0`, `cheat_type="none"`, and the physical user's `player_group`.

### b) Synthetic Bot & Cheat Simulation (`tools/simulate_sessions.py`)
To achieve robust statistical coverage (3,200+ matches across 60 distinct player groups), scripted clients emulate human motor constraints and cheat archetypes:
- **Normal Profiles** (`casual`, `average`, `skilled`, `pro`):
  - Natural reaction delay distributions (140ms – 420ms).
  - Aim tracking noise, overshooting, and correction jitter (1.2° – 14.0° error).
  - Variable burst patterns and tactical movement pauses.
- **Cheat Profiles**:
  - `hard_aimbot`: Instantaneous angular snapping (> 850–2400 deg/s), sub-120ms reaction times, and minimal aim error.
  - `smooth_aimbot`: Limited angular velocity (180–450 deg/s) with added humanized micro-jitter; parameter ranges intentionally overlap with pro humans.
  - `triggerbot`: Normal aiming mechanics but instantaneous trigger response (20–80ms) upon crosshair acquisition.
  - `wallhack`: Aiming and firing at occluded enemies with `visible_through_wall == True`.
  - `speedhack`: Kinematic speed multiplier (1.5x – 3.8x baseline velocity).
  - `recoil_script`: Rapid-fire automation with near-zero inter-shot interval variance (`fire_interval_cv` < 0.10).

## 4. Class Balance & Player Coverage
- Total Sessions: 3,200 matches.
- Class Balance: 1,600 Normal (50.0%), 1,600 Cheaters (50.0%).
- Distinct Player Groups: 60 unique player IDs (10 Human, 25 Normal Bots, 25 Cheat Bots).
- No single feature achieves perfect separability (AUC < 0.999), ensuring realistic decision boundaries.

## 5. Known Limitations
1. **Simulated Cheat Diversity**: While 6 cheat archetypes with varying strengths and human noise are implemented, sophisticated memory hacks or kernel bypasses in real matches may exhibit different kinematics.
2. **Human Sample Size**: The base training set contains ~60 verified human sessions across 10 player groups, augmented with realistic bot profiles. As more live matches are recorded through the platform, retraining pipelines should ingest additional human sessions.

## 6. How to Record & Ingest New Data
1. **Play a match**: Start a match with `"record_session": true` (or check "Record Match for Anti-Cheat Training" in dashboard).
2. **Review in Admin Console**: Admins can label unflagged matches or confirm false positives / cheaters directly.
3. **Re-export Dataset**: Run `python tools/build_dataset_v2.py` to re-extract features and update `data/dataset_v2.csv`.
4. **Retrain Pipeline**: Execute `python -m backend.models.train_v2` to produce an updated calibrated model artifact.
