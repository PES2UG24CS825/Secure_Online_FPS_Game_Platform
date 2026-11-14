# SecureFPS: Anti-Cheat Features & Dataset Specification

## 1. Core Feature Definitions & Mathematical Formulas

SecureFPS analyzes per-session gameplay telemetry to identify both overt cheats (such as rage aimbots, speed hacks, and snap-to-target locks) and subtle smoothed aim assists. While the full pipeline v2 leverages 21 behavioral features, the 5 foundational active telemetry features are formulated as follows:

### 1.1 Accuracy ($\text{Acc}$)
Measures the ratio of confirmed hits to total fired shots across a gameplay session:
$$\text{Acc} = \frac{N_{\text{hits}}}{N_{\text{shots fired}}}$$
- **Units:** Ratio $[0.0, 1.0]$
- **Normal Range:** $0.20 - 0.55$
- **Cheater Anomaly:** $\ge 0.85$ (Aimbot / Triggerbot) or abnormally high with zero degradation at long ranges.

### 1.2 Fire Rate ($\text{FR}$)
The average frequency of fired weapon rounds per active combat second:
$$\text{FR} = \frac{N_{\text{shots fired}}}{\Delta t_{\text{combat}}}$$
- **Units:** Shots per second ($\text{s}^{-1}$)
- **Normal Range:** Weapon-capped (e.g. Carbine max $11.1\,\text{s}^{-1}$, SMG max $15.4\,\text{s}^{-1}$, Pistol max $6.25\,\text{s}^{-1}$).
- **Cheater Anomaly:** Exceeds weapon physical cycle limits (rapid-fire modification) or exhibits zero firing interval variance ($\text{CV} \to 0$).

### 1.3 Movement Speed ($\text{Speed}$)
The horizontal kinematic displacement per unit time:
$$v_{\text{horiz}} = \sqrt{\left(\frac{\Delta x}{\Delta t}\right)^2 + \left(\frac{\Delta z}{\Delta t}\right)^2}$$
- **Units:** Meters per second ($\text{m/s}$)
- **Normal Range:** Walk $\sim 4.2\,\text{m/s}$, Sprint $\sim 6.8\,\text{m/s}$, Jump horizontal boost $\le 7.5\,\text{m/s}$.
- **Cheater Anomaly:** Teleportation or speed hacks exceeding the per-tick displacement budget ($v > 9.5\,\text{m/s}$).

### 1.4 Aim Smoothness ($\text{Smooth}$)
Quantifies the angular acceleration jitter and jerkiness of cursor / crosshair orientation:
$$\text{Aim Smoothness} = \frac{1}{1 + \sigma(\omega_{\text{angular}})}$$
where $\omega_{\text{angular}} = \frac{\Delta \theta}{\Delta t}$ is the angular velocity in $\text{deg/s}$, and $\sigma$ is standard deviation.
- **Units:** Normalized index $[0.0, 1.0]$
- **Normal Range:** $0.40 - 0.78$ (natural human micro-corrections and muscular tremor).
- **Cheater Anomaly:** Inhumanly high ($\ge 0.95$, perfectly linear robotic aimbot interpolation) or instantaneous non-physical step change ($\omega > 1200\,\text{deg/s}$ instantaneous snap).

### 1.5 Kill-to-Death Ratio ($\text{KDR}$)
The ratio of defeated enemy operators to player fatalities:
$$\text{KDR} = \frac{N_{\text{kills}}}{\max(1, N_{\text{deaths}})}$$
- **Units:** Ratio $[0.0, \infty)$
- **Normal Range:** $0.5 - 4.0$
- **Cheater Anomaly:** Unchecked dominance without defensive play ($\ge 12.0$).

---

## 2. Threshold Reconciliation & Unified Scale

To prevent confusion between raw probabilities, display bands, and disciplinary action, SecureFPS operates on a **Single Reconciled 0–100 Risk Scale**:

$$\text{Risk Score} = 100 \times \left(0.60 \times P_{\text{cheater}}^{\text{RandomForest}} + 0.40 \times S_{\text{anomaly}}^{\text{IsolationForest}}\right)$$

| Score Range | Severity Band | System Action | Admin Review Queue |
| :--- | :--- | :--- | :--- |
| **0 – 39** | **Low Risk (Normal)** | Verified clean. Full rewards & matchmaking access. | Not queued. |
| **40 – 64** | **Moderate (Guarded)** | Telemetry flagged for passive sliding-window tracking. | Logged in telemetry audit. |
| **65 – 79** | **Elevated (Warning)** | Admin alert dispatched via SSE stream with evidence. | Queued as "Elevated Suspicion". |
| **80 – 89** | **High Risk (Flagged)** | Match restrictions applied; queued for moderator review. | Priority Queue with model version & feature impact. |
| **$\ge 90$** | **Critical (Suspended)** | Automated temporary suspension pending admin confirmation. | Urgent Queue with ban appeal option enabled. |

- **Alert Threshold:** $\ge 65$ (Triggers real-time SSE notification to admin dashboard).
- **Automated Suspension Threshold (`BAN_RISK_THRESHOLD`):** $\ge 90$ (Temporarily suspends account rather than permanent instant hard deletion, guaranteeing due process).

---

## 3. Dataset Provenance & Human Origin Placeholder

<!-- ========================================================================= -->
<!-- [HUMAN PLACEHOLDER - FILL IN YOUR SPECIFIC RECORDING ENVIRONMENT & HARDWARE] -->
<!-- ========================================================================= -->
> **[DATASET ORIGIN & RECORDING METHODOLOGY PLACEHOLDER - FOR HUMAN AUTHOR]**
> - **Source Lab / Platform:** [e.g., SecureFPS Competitive Testing Arena & Synthetic Injections]
> - **Human Participants:** [e.g., 24 volunteer FPS players ranging from casual gamers to collegiate esports competitors across 1,600 verified sessions]
> - **Cheat Injection Methods:** [e.g., Memory-injected linear snapbot, Bezier-smoothed aim assist, memory speed-hack override, and triggerbot simulated via client relay hook]
> - **Recording Frequency:** 10Hz aiming telemetry samples and per-event weapon firing / target acquisition hooks.
<!-- ========================================================================= -->

---

## 4. Known Limitations & Future Work

1. **Client-Supplied Raw Aim Angles:** While movement kinematics and weapon hit registrations are authoritatively simulated on the game server, fine-grained crosshair yaw/pitch angles originate from the client. Future iterations will integrate server-side client view frustum validation.
2. **Extreme Edge-Cases (Flick Shots):** Professional esports players performing sudden 180° flick shots can occasionally trigger elevated aim speed. The dual ensemble (`Random Forest` + `Isolation Forest`) mitigates false positives by requiring sustained multi-feature anomalies before reaching the suspension threshold.
3. **Recurrent Temporal Deep Learning:** Current models analyze windowed summary statistics. Future work includes evaluating Temporal Convolutional Networks (TCN) or LSTMs directly on continuous 30Hz telemetry sequences.
