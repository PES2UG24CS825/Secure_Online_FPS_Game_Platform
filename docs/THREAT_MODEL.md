# SecureFPS: Threat Model & Security Verification Matrix

This document maps adversarial attack vectors against the platform's defensive mitigations and automated verification tests.

---

## 1. Attack Vectors & Mitigations Matrix

| Attack Vector | Threat Category | Mitigation Architecture | Verification Test |
| :--- | :--- | :--- | :--- |
| **Speed Hack / Movement Teleportation** | Kinematic Spoofing | Authoritative server computes displacement budget ($v \times \Delta t \times \text{tolerance}$). Violations trigger `player:rubberband` snapping coordinates back to verified state. | `multiplayer-server/test/netcode_authoritative.test.js` (`test 3`) |
| **Client Damage / Hit Fabrication** | Combat Spoofing | Clients emit only ray origin and direction. Hit detection, target identification, headshot bonuses, and damage calculation are 100% server-authoritative. | `multiplayer-server/test/netcode_authoritative.test.js` (`test 5`) |
| **Wall Occlusion Bypass (Wallhack/Shoot Through Walls)** | Spatial Exploitation | Server performs ray-AABB slab intersection against arena obstacles before confirming hits. | `multiplayer-server/test/netcode_authoritative.test.js` (`test 4`) |
| **Rapid-Fire Modification** | Weapon Exploit | Server tracks per-player weapon firing timestamps and enforces cyclic weapon cooldowns with a 15% network jitter buffer. | `multiplayer-server/test/netcode_authoritative.test.js` (`test 4`) |
| **Packet Flooding / Socket DoS** | Denial of Service | `SocketRateLimiter` enforces per-event token bucket limits. Repeat offenders (>25 drops) are forcibly disconnected. | `multiplayer-server/test/netcode_authoritative.test.js` (`test 2`) |
| **Malformed JSON / Null Injection** | Application Crash | Strict Zod schemas and runtime type guards wrap every incoming socket packet in defensive try/catch blocks. | `multiplayer-server/test/netcode_authoritative.test.js` (`test 1`) |
| **MFA Brute Force Attacks** | Authentication Bypass | MongoDB `mfa_lockouts` collection tracks failed attempts per user and IP. Locks out login for 15 minutes after 5 consecutive failures. | `backend/tests/test_authoritative_backend.py` (`test_mfa_db_lockout...`) |
| **Account Enumeration via Password Reset** | Information Disclosure | `/api/auth/forgot-password` returns an identical generic response whether the email exists or not. Reset tokens are never leaked in JSON. | `backend/tests/test_api.py` & manual curl |
| **Cross-Site Scripting (XSS) in Emails/Admin** | Injection | Every user-supplied string in email templates is passed through `html.escape()`. Admin frontend sanitizes all DOM insertions via `escapeHtml()`. | `frontend/public/games/three-fps/test/ai_hud_verification.test.js` & manual QA |
| **Cross-Site Request Forgery (CSRF)** | Request Forgery | All state-changing admin and player POST/PUT/DELETE endpoints enforce custom `X-Requested-With` or `X-CSRF-Token` headers and origin validation. | `backend/tests/test_admin_player_dashboards.py` |
| **Subtle Aimbots & Smoothed Assists** | Behavioral Cheat | Dual ML pipeline computes 21 behavioral features (aim speed variance, flick rate, reaction time, snap-to-hit ratio). Flagged if risk $\ge 65$. | `backend/tests/test_phase6_pipeline.py` & `scripts/evaluate_models.py` |
| **Sub-30s Match Coin/XP Farming** | Economic Exploitation | `/api/game/end` enforces minimum 30-second match duration and 20 reward matches/day limit. Ignores client-claimed kill counts. | `backend/tests/test_authoritative_backend.py` (`test_reward_integrity...`) |
| **Insecure Production Deployment** | Configuration Drift | Backend refuses to start if `FLASK_SECRET_KEY`, `ADMIN_PASSWORD`, or `ADMIN_MFA_SECRET` are missing or default outside `SECUREFPS_LOCAL_DEV=true`. | `backend/tests/test_authoritative_backend.py` (`test_production_refuses...`) |
