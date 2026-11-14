# SecureFPS: Two-Tier Administrator System & Security Walkthrough

## 1. Overview & Architecture

SecureFPS enforces a strict **Two-Tier Role-Based Access Control (RBAC)** architecture on both the backend and frontend:

| Administrator Tier | Role Identifier | Operational Responsibilities | Destructive Permissions |
| :--- | :--- | :--- | :--- |
| **Normal Admin** | `normal_admin` | View dashboards, search players, investigate telemetry, handle customer support tickets, review ML gameplay alerts, process ban appeals, issue warnings, temporary suspensions (up to 7 days). | **Read-Only / Operational**. Cannot permanently ban or delete accounts directly. Must submit approval requests to Super Admin. |
| **Super Admin** | `super_admin` | Full executive authority: Approvals Queue, Administrator Provisioning, Risk Engine Thresholds, AI/ML Model Rollback & Tuning, Global Emergency Lockdown, System Control Center. | **Executive Authority**. Direct permanent bans, soft deletes, GDPR erasures, and admin creation. |

---

## 2. Universal Port 5000 Guard

- Any access to legacy development ports (such as Live Server `5500` or `5501`) is intercepted immediately at the `<head>` level and redirected to `http://127.0.0.1:5000/login.html`.
- Port 5000 serves all static frontend assets and API endpoints with full CORS and reverse-proxy headers.

---

## 3. High-Tolerance Multi-Factor Authentication (MFA)

- **Drift Tolerance**: `valid_window=10` accommodates up to $\pm 5$ minutes of clock skew between mobile authenticators and the server.
- **Local Dev Resilience**: In local development, repeated attempts do not lock out testers.
- **Master Team Bypass Codes**: `123456`, `000000`, and `999999` are supported in local environments.
- **QR Code Sync**: If a user switches authenticator apps, clicking *Re-sync Authenticator App* immediately displays their provisioning QR code and manual key.

---

## 4. Two-Tier Approval Flow Walkthrough

```
[ Normal Admin ] --( Submits Ban Request with Reason >= 10 chars & Evidence )--> [ Approvals Queue (Pending) ]
                                                                                            |
                                                                                            v
                                                                                [ Super Admin Command Center ]
                                                                                            |
                                                            +-------------------------------+-------------------------------+
                                                            |                                                               |
                                                  [ Approves Request ]                                            [ Rejects Request ]
                                                            |                                                               |
                                                            v                                                               v
                                       Target Player Banned & Sessions Revoked                              Status Marked Rejected with Note
```

### Verification Endpoints:
- `POST /api/admin/approvals/request`: Normal Admin submits request (`player_id`, `action="ban"|"delete"`, `reason`, `evidence`).
- `GET /api/admin/approvals`: Super Admin lists pending requests and unread badge count.
- `POST /api/admin/approvals/<id>/action`: Super Admin approves or rejects with an executive note.

---

## 5. UI Theme & Design System

- **Palette**: Pitch-black and dark obsidian tactical cyberpunk (`--bg: #090B10`, `--panel: #111622`, `--line: #232C3D`).
- **Accent**: Cyber Blue (`#2563EB`) and Cyan (`#06B6D4`), completely eliminating purple/lavender tones.
- **Tables**: Horizontal scrollbars removed from Threat Monitoring and player tables with `overflow-x: hidden` and auto-fit columns.
