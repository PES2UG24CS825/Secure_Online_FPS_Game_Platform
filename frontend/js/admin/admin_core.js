/**
 * SecureFPS Admin Core Module
 * Shared utilities, sanitization, polling with visibilitychange pause, and dialog helpers.
 */

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTimeAgo(dateInput) {
  if (!dateInput) return '—';
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = pad(date.getDate());
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${day} ${month} ${year}, ${hours}:${minutes}:${seconds}`;
}

const incidentLabels = {
  abnormal_fire_rate: 'Unusually Fast Shooting',
  movement_anomaly: 'Unusual Movement Speed',
  aim_anomaly: 'Suspicious Aiming',
  impossible_hit: 'Impossible Hit Detected',
  session_revoked: 'Login Session Ended',
  mfa_failure: 'Incorrect Verification Code',
  invalid_mfa: 'Incorrect Authenticator Code',
  invalid_password: 'Incorrect Password',
  unknown_account: 'Account Not Recognized',
  login_failed: 'Sign-in Failed',
  unauthorized_access: 'Unauthorized Access Attempt',
  model_rollback: 'Previous AI Model Restored',
  toggle_emergency_lockdown: 'Emergency Lockdown Changed',
  soft_delete_player: 'Player Account Deactivated',
};

export function incidentLabel(code) {
  if (!code) return 'Unknown action';
  return Object.hasOwn(incidentLabels, code)
    ? incidentLabels[code]
    : String(code).replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
}

class AdminPollingManager {
  constructor(intervalMs = 20000) {
    this.intervalMs = intervalMs;
    this.timer = null;
    this.subscribers = new Set();
    this.isPaused = false;
    this.lastUpdated = Date.now();

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.pause();
        } else {
          this.resume(true);
        }
      });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => {
        if (!this.isPaused && (Date.now() - this.lastUpdated > 10000)) {
          this.triggerAll();
        }
      });
    }
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  start() {
    this.stop();
    this.isPaused = false;
    this.timer = setInterval(() => {
      if (!this.isPaused && !document.hidden) {
        this.triggerAll();
      }
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  pause() {
    this.isPaused = true;
    const indicator = document.getElementById('adminLiveStatus');
    if (indicator) {
      indicator.innerHTML = '<span class="status-dot paused"></span>Paused (tab hidden)';
    }
  }

  resume(immediate = false) {
    this.isPaused = false;
    const indicator = document.getElementById('adminLiveStatus');
    if (indicator) {
      indicator.textContent = 'Checking connection';
    }
    if (immediate) {
      this.triggerAll();
    }
  }

  triggerAll(force = false) {
    this.lastUpdated = Date.now();
    for (const cb of this.subscribers) {
      try {
        cb(force);
      } catch (err) {
        console.error('[AdminPolling] Subscriber error:', err);
      }
    }
  }

  updateLastUpdatedDisplay() {
    const el = document.getElementById('lastUpdatedIndicator');
    if (el) {
      el.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }
  }
}

export const PollingManager = new AdminPollingManager(10000);

const _liveAlertDedup = new Map();

export function showLiveSecurityToast(payload) {
  if (typeof document === 'undefined' || !payload) return;
  const sessionId = payload.session_id || payload.demo_session_id || '';
  const alertType = payload.alert_type || payload.type || 'security_alert';
  const playerName = payload.player_display_name || payload.player_name || 'Unknown Player';
  const violation = payload.violation || incidentLabel(alertType);
  const dedupKey = `${sessionId}:${alertType}:${violation}`;
  const now = Date.now();
  const prev = _liveAlertDedup.get(dedupKey) || 0;
  if (now - prev < 4000) return;
  _liveAlertDedup.set(dedupKey, now);
  if (_liveAlertDedup.size > 100) {
    _liveAlertDedup.delete(_liveAlertDedup.keys().next().value);
  }

  let stack = document.getElementById('adminLiveSecurityToastStack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'adminLiveSecurityToastStack';
    stack.setAttribute('aria-live', 'assertive');
    stack.style.cssText = [
      'position:fixed',
      'top:18px',
      'right:18px',
      'z-index:9999',
      'display:flex',
      'flex-direction:column',
      'gap:10px',
      'max-width:390px',
      'width:calc(100vw - 36px)',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(stack);
  }

  while (stack.children.length >= 4) {
    stack.removeChild(stack.firstElementChild);
  }

  const isDemo = payload.is_demo === true || payload.is_demo_account === true || payload.player_name === 'cheater_demo';
  const severity = String(payload.severity || 'high').toUpperCase();
  const isCritical = severity === 'CRITICAL' || severity === 'HIGH';
  const accent = isCritical ? '#ef4444' : '#f59e0b';
  const badgeBg = isCritical ? 'rgba(239, 68, 68, 0.16)' : 'rgba(245, 158, 11, 0.16)';
  const riskPart = Number.isFinite(Number(payload.risk_score))
    ? ` · Risk ${Number(payload.risk_score).toFixed(1)}/100`
    : '';
  const matchPart = sessionId ? ` · Match #${escapeHtml(String(sessionId))}` : '';

  const toast = document.createElement('div');
  toast.role = 'alert';
  toast.style.cssText = [
    'pointer-events:auto',
    'background:rgba(17, 24, 39, 0.96)',
    'color:#f9fafb',
    `border:1px solid ${accent}`,
    `border-left:4px solid ${accent}`,
    'border-radius:12px',
    'padding:12px 14px',
    'box-shadow:0 12px 30px rgba(0, 0, 0, 0.35)',
    'font-family:inherit',
    'font-size:13px',
    'line-height:1.4',
  ].join(';');

  toast.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
      <span style="display:inline-flex;align-items:center;gap:6px;font-weight:700;color:${accent};font-size:12px;letter-spacing:0.03em;">
        <span style="padding:2px 6px;border-radius:999px;background:${badgeBg};">${escapeHtml(severity)}</span>
        <span>${isDemo ? 'DEMO CHEATER ALERT' : 'REAL-TIME SECURITY ALERT'}</span>
      </span>
      <button type="button" aria-label="Dismiss alert" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:16px;line-height:1;padding:0 2px;">&times;</button>
    </div>
    <div style="font-weight:600;color:#ffffff;">${escapeHtml(playerName)}${matchPart}${riskPart}</div>
    <div style="color:#d1d5db;font-size:12px;margin-top:2px;">${escapeHtml(violation)}</div>
  `;

  const closeBtn = toast.querySelector('button');
  const removeToast = () => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  };
  if (closeBtn) closeBtn.addEventListener('click', removeToast);
  stack.appendChild(toast);
  setTimeout(removeToast, 10000);
}

export function connectAdminLiveEvents() {
  if (typeof window === 'undefined' || !window.EventSource) return;
  try {
    let sse = new EventSource('/api/live/events', { withCredentials: true });
    sse.addEventListener('update', (e) => {
      try {
        PollingManager.triggerAll(true);
        if (e.data) {
          const payload = JSON.parse(e.data);
          if (payload.type === 'security_alert' || payload.alert_type) {
            showLiveSecurityToast(payload);
            import('./admin_demo_cheater.js?v=20261125_live_alert').then(m => m.handleLiveDemoAlert(payload)).catch(() => {});
          }
        }
      } catch (err) {}
    });
    sse.onopen = () => {
      const indicator = document.getElementById('adminLiveStatus');
      if (indicator) {
        indicator.innerHTML = '<span class="status-dot live"></span>Live SSE connected';
      }
    };
    sse.onerror = () => {
      const indicator = document.getElementById('adminLiveStatus');
      if (indicator) {
        indicator.innerHTML = '<span class="status-dot offline"></span>Reconnecting SSE...';
      }
    };
    window.addEventListener('pagehide', () => {
      if (sse) {
        sse.close();
        sse = null;
      }
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && !sse) {
        connectAdminLiveEvents();
      }
    });
  } catch (err) {
    console.warn('[AdminCore] SSE connection error:', err);
  }
}

/**
 * Universal Action Prompt Modal
 * Prompts for required reason (min 10 chars), optional end date, and admin password/MFA.
 */
export function promptAdminAction({
  title,
  message,
  actionLabel = 'Confirm Action',
  isDestructive = false,
  requireReason = true,
  requireReauth = false,
  allowEndDate = false,
  onConfirm
}) {
  let modal = document.getElementById('adminActionModal');
  if (!modal) {
    modal = document.createElement('dialog');
    modal.id = 'adminActionModal';
    modal.className = 'admin-action-modal';
    modal.setAttribute('aria-labelledby', 'adminActionTitle');
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <form method="dialog" class="admin-modal-card" novalidate>
      <h3 id="adminActionTitle">${escapeHtml(title)}</h3>
      <p class="muted">${escapeHtml(message)}</p>
      
      ${requireReason ? `
        <div class="modal-form-group">
          <label for="adminModalReason">Reason <span class="required-star">*</span> (minimum 10 characters)</label>
          <textarea id="adminModalReason" class="admin-modal-textarea" rows="3" placeholder="Provide a detailed operational reason for this action..."></textarea>
          <small id="adminModalReasonErr" class="modal-err-msg" hidden>Reason must be at least 10 characters.</small>
        </div>
      ` : ''}

      ${allowEndDate ? `
        <div class="modal-form-group">
          <label for="adminModalEndDate">Suspension End Date (optional)</label>
          <input type="datetime-local" id="adminModalEndDate" class="admin-modal-input">
          <small class="muted">Leave blank for an indefinite suspension.</small>
        </div>
      ` : ''}

      ${requireReauth ? `
        <div class="modal-form-group reauth-box">
          <label for="adminModalPassword">Administrator Re-authentication <span class="required-star">*</span></label>
          <input type="password" id="adminModalPassword" class="admin-modal-input" placeholder="Admin password or 6-digit MFA code" autocomplete="current-password">
          <small id="adminModalAuthErr" class="modal-err-msg" hidden>Admin password or MFA code required.</small>
        </div>
      ` : ''}

      <div class="modal-actions">
        <button type="button" class="ghost-btn" id="adminModalCancelBtn">Cancel</button>
        <button type="submit" class="${isDestructive ? 'danger-btn' : 'play-btn'}" id="adminModalConfirmBtn">${escapeHtml(actionLabel)}</button>
      </div>
    </form>
  `;

  const cancelBtn = modal.querySelector('#adminModalCancelBtn');
  const form = modal.querySelector('form');
  const reasonInput = modal.querySelector('#adminModalReason');
  const endDateInput = modal.querySelector('#adminModalEndDate');
  const passwordInput = modal.querySelector('#adminModalPassword');
  const reasonErr = modal.querySelector('#adminModalReasonErr');
  const authErr = modal.querySelector('#adminModalAuthErr');

  cancelBtn.onclick = () => modal.close();

  form.onsubmit = async (e) => {
    e.preventDefault();
    let valid = true;

    let reason = '';
    if (requireReason) {
      reason = (reasonInput.value || '').trim();
      if (reason.length < 10) {
        reasonErr.hidden = false;
        valid = false;
      } else {
        reasonErr.hidden = true;
      }
    }

    let reauthPw = '';
    if (requireReauth) {
      reauthPw = (passwordInput.value || '').trim();
      if (!reauthPw) {
        authErr.hidden = false;
        valid = false;
      } else {
        authErr.hidden = true;
      }
    }

    if (!valid) return;

    let endDateIso = null;
    if (allowEndDate && endDateInput && endDateInput.value) {
      try {
        endDateIso = new Date(endDateInput.value).toISOString();
      } catch (err) {}
    }

    if (passwordInput) passwordInput.value = "";
    modal.close();
    try {
      await onConfirm({
        reason,
        suspended_until: endDateIso,
        reauth_password: reauthPw,
        mfa_code: /^\d{6}$/.test(reauthPw) ? reauthPw : null
      });
    } catch (err) {
      console.error('[AdminDialog] Confirmation error:', err);
      window.showAppAlert(`Action failed: ${err.message || 'Server error'}`, { tone: "error" });
    }
  };

  if (!modal.open) modal.showModal();
  cancelBtn.focus();
}
