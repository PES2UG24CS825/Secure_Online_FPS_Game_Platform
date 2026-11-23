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
  if (isNaN(date.getTime())) return String(dateInput);
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
      indicator.innerHTML = '<span class="status-dot live"></span>Live connected';
    }
    if (immediate) {
      this.triggerAll();
    }
  }

  triggerAll() {
    this.lastUpdated = Date.now();
    this.updateLastUpdatedDisplay();
    for (const cb of this.subscribers) {
      try {
        cb();
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

export const PollingManager = new AdminPollingManager(45000);

export function connectAdminLiveEvents() {
  if (typeof window === 'undefined' || !window.EventSource) return;
  try {
    let sse = new EventSource('/api/live/events', { withCredentials: true });
    sse.addEventListener('update', (e) => {
      try {
        PollingManager.triggerAll();
        if (e.data) {
          const payload = JSON.parse(e.data);
          if (payload.type === 'security_alert' || payload.alert_type) {
            import('./admin_demo_cheater.js').then(m => m.handleLiveDemoAlert(payload)).catch(() => {});
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
