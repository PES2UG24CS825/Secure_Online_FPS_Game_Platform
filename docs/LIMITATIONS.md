# SecureFPS: Limitations, Asset Credits & Formulas Appendix

---

## 1. Known Architectural Limitations

1. **Dataset Scope & Synthetic Augmentations:**
   The training dataset (`dataset_v2.csv`) comprises 3,200 sessions generated through volunteer recordings and controlled synthetic cheat injection. While highly effective at separating extreme aimbots and triggerbots, real-world cheat developers continuously evolve kernel-level stealth drivers and mouse-event spoofing. Real-world commercial deployment requires continuous active telemetry ingestion and automated re-training loops.
2. **Client-Supplied Viewing Angles:**
   While movements, kinematics, collisions, and hit confirmations are 100% server-authoritative, fine-grained crosshair yaw and pitch angles originate on the client machine. Future versions will incorporate server-side raycast view frustum verification.
3. **In-Memory Server State:**
   The multiplayer server maintains active rooms, tick loops, and player ring buffers in Node.js process memory. Multi-server clustering in production requires Redis Pub/Sub for room discovery and sticky sessions across socket instances.
4. **No Kernel-Level Ring 0 Driver:**
   SecureFPS is intentionally an agentless, browser-friendly behavioral anti-cheat platform. It does not install invasive Ring 0 kernel drivers (e.g., Vanguard, BattlEye), prioritizing cross-platform accessibility and user privacy.

---

## 2. 3D Asset & Audio Credits

- **Three.js WebGL Engine:** Mr.doob and Three.js open-source contributors (MIT License).
- **Tactical Operator Procedural Articulated Rig:** SecureFPS built-in procedural anatomy engine with FAST high-cut helmet, Wilcox NVG shroud, ARC rails, mirrored ballistic goggles, MOLLE plate carrier, and combat gloves.
- **Synthesized Tactical Audio FX:** Built-in Web Audio API synthesizer for dynamic gunshots, mechanical slide clicks, shell casing brass impacts, and bullet whiz-by cues without external audio dependencies.
- **CS-3D Velcro Patch & Ripstop Textures:** In-memory procedural Canvas 2D texture generators (`TextureGenerator.js`).

---

## 3. Formulas Appendix with Worked Examples

### 3.1 Min-Max Feature Normalization
Scales a feature value $x$ to $[0.0, 1.0]$ based on observed baseline bounds $[x_{\min}, x_{\max}]$:
$$x_{\text{norm}} = \frac{x - x_{\min}}{x_{\max} - x_{\min}}$$
*Worked Example:* For player weapon accuracy $x = 0.65$ where $x_{\min} = 0.05$ and $x_{\max} = 0.95$:
$$x_{\text{norm}} = \frac{0.65 - 0.05}{0.95 - 0.05} = \frac{0.60}{0.90} \approx 0.6667$$

---

### 3.2 Gini Impurity (Random Forest Split Criterion)
Measures the likelihood of incorrect classification for a node with class probabilities $p_i$:
$$I_G(p) = 1 - \sum_{i=1}^{J} p_i^2$$
*Worked Example:* For a decision tree node containing 40 normal players and 10 cheaters ($N = 50$):
$$p_{\text{normal}} = \frac{40}{50} = 0.8, \quad p_{\text{cheater}} = \frac{10}{50} = 0.2$$
$$I_G = 1 - \left(0.8^2 + 0.2^2\right) = 1 - (0.64 + 0.04) = 0.32$$

---

### 3.3 SMOTE (Synthetic Minority Over-sampling Technique)
Generates synthetic examples along the line segment joining minority instances $x_i$ and a $k$-nearest neighbor $x_{zi}$:
$$x_{\text{new}} = x_i + \lambda \times (x_{zi} - x_i), \quad \lambda \sim U(0, 1)$$
*Worked Example:* For cheater sample $x_i = [0.85, 0.90]$ and neighbor $x_{zi} = [0.95, 0.94]$ with $\lambda = 0.40$:
$$x_{\text{new}} = [0.85, 0.90] + 0.40 \times [0.10, 0.04] = [0.85 + 0.04, 0.90 + 0.016] = [0.89, 0.916]$$

---

### 3.4 Isolation Forest Anomaly Scoring
Based on average path length $h(x)$ across $m$ isolation trees:
$$s(x, n) = 2^{-\frac{E(h(x))}{c(n)}}$$
where $c(n) = 2 \ln(n - 1) + 0.5772156649 - \frac{2(n - 1)}{n}$ is the average path length of unsuccessful searches in a Binary Search Tree.
- If $E(h(x)) \to 0$, $s \to 1$ (readily isolated anomaly).
- If $E(h(x)) \to n - 1$, $s \to 0$ (deep normal node).
*Calibrated Percentile Normalization:*
$$S_{\text{anomaly}} = \operatorname{clip}\left(\frac{p_{99} - \text{decision}(x)}{p_{99} - p_{1}}, 0.0, 1.0\right)$$

---

### 3.5 Overall Risk Formula & Classification
$$\text{Risk Score} = 100 \times \left(0.60 \times P_{\text{cheater}}^{\text{RandomForest}} + 0.40 \times S_{\text{anomaly}}^{\text{IsolationForest}}\right)$$
*Worked Example:* A match session yields $P_{\text{cheater}} = 0.95$ and $S_{\text{anomaly}} = 0.88$:
$$\text{Risk Score} = 100 \times (0.60 \times 0.95 + 0.40 \times 0.88) = 100 \times (0.57 + 0.352) = 92.2$$
Because $\text{Risk Score} = 92.2 \ge 90.0$, the system automatically issues an administrative temporary suspension.

---

### 3.6 Physical Kinematic Bounds Rules
Movement displacement per tick $\Delta t = 0.0333\,\text{s}$ (30Hz):
$$\Delta d_{\max} = v_{\max} \times \Delta t \times (1 + \text{tolerance})$$
where $v_{\max} = 7.2\,\text{m/s}$ (sprint) and $\text{tolerance} = 0.35$:
$$\Delta d_{\max} = 7.2 \times 0.0333 \times 1.35 \approx 0.324\,\text{m per tick}$$
Any packet reporting $\Delta d > 0.324\,\text{m}$ within a single tick is flagged for rubberbanding.

---

### 3.7 Competitive Honour Score Formula
Players start at $H_0 = 100$. Honour adjusts dynamically based on match completion and voluntary abandonment:
$$H_{t+1} = \operatorname{clamp}\left(0, 100, H_t + \Delta H\right)$$
- Match Completed ($\ge 30\,\text{s}$): $\Delta H = +5$
- Premature Abandonment / Disconnect: $\Delta H = -5$
- Confirmed Cheating Verdict: $\Delta H = -50$
- Access to Ranked Matchmaking requires $H \ge 75$.
