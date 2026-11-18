/**
 * SecureFPS Super Admin Command Center Module
 * Handles privileged administrator management, role permissions, ML tuning & rollback,
 * risk engine simulation, emergency lockdown, system control metrics, and backups.
 */
import { escapeHtml, formatTimeAgo } from './admin_core.js';

export function initSuperAdminModules() {
  setupSuperEventListeners();
  initApprovalsSection();
}

function setupSuperEventListeners() {
  // 1. Provision Normal Admin Modal
  const openCreateBtn = document.getElementById('openCreateAdminModalBtn');
  const createModal = document.getElementById('createAdminModal');
  const cancelCreateBtn = document.getElementById('cancelCreateAdminBtn');
  const createForm = document.getElementById('createAdminForm');

  if (openCreateBtn && createModal) {
    openCreateBtn.addEventListener('click', () => {
      document.getElementById('newAdminName').value = '';
      document.getElementById('newAdminEmail').value = '';
      document.getElementById('newAdminPassword').value = '';
      const fb = document.getElementById('createAdminFeedback');
      if (fb) fb.hidden = true;
      createModal.showModal();
    });
  }

  if (cancelCreateBtn && createModal) {
    cancelCreateBtn.addEventListener('click', () => createModal.close());
  }

  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('newAdminName').value.trim();
      const email = document.getElementById('newAdminEmail').value.trim();
      const password = document.getElementById('newAdminPassword').value;
      const fb = document.getElementById('createAdminFeedback');

      try {
        const resp = await fetch('/api/admin/super/admins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
          body: JSON.stringify({ name, email, password })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.message || 'Failed to create administrator');

        createModal.close();
        window.showAppAlert(`Success: Normal Administrator '${name}' created!\nMFA Secret Seed: ${data.admin?.mfa_seed || 'Unavailable'}`);
        loadSuperAdmins();
      } catch (err) {
        if (fb) {
          fb.textContent = err.message;
          fb.hidden = false;
        }
      }
    });
  }

  // 2. Refresh Roster
  document.getElementById('refreshSuperAdminsBtn')?.addEventListener('click', loadSuperAdmins);

  // 3. Save Role Permissions
  document.getElementById('saveNormalAdminPermissionsBtn')?.addEventListener('click', async () => {
    const checkboxes = document.querySelectorAll('.perm-cb');
    const permissions = {};
    checkboxes.forEach(cb => {
      permissions[cb.dataset.perm] = cb.checked;
    });

    try {
      const resp = await fetch('/api/admin/super/roles-permissions/NORMAL_ADMIN', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
        body: JSON.stringify({ permissions })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Failed to save permissions');
      window.showAppAlert('✓ Normal Admin permissions updated successfully.');
      loadRolesPermissions();
    } catch (err) {
      window.showAppAlert(`Error: ${err.message}`, { tone: "error" });
    }
  });

  // 4. Save Risk Config
  document.getElementById('saveRiskConfigBtn')?.addEventListener('click', async () => {
    const low = parseInt(document.getElementById('riskLowThreshold').value, 10);
    const med = parseInt(document.getElementById('riskMedThreshold').value, 10);
    const high = parseInt(document.getElementById('riskHighThreshold').value, 10);
    const crit = parseInt(document.getElementById('riskCritThreshold').value, 10);

    try {
      const resp = await fetch('/api/admin/super/risk-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
        body: JSON.stringify({
          risk_engine: {
            low_threshold: low,
            medium_threshold: med,
            high_threshold: high,
            critical_threshold: crit,
            auto_flag_enabled: true,
            auto_flag_threshold: 75
          }
        })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Failed to save risk config');
      window.showAppAlert('✓ Risk engine configuration successfully updated.');
      loadRiskConfig();
    } catch (err) {
      window.showAppAlert(`Error: ${err.message}`, { tone: "error" });
    }
  });

  // 5. Run Risk Simulator
  document.getElementById('runSimulationBtn')?.addEventListener('click', async () => {
    const aim = parseFloat(document.getElementById('simAimJitter').value);
    const reaction = parseFloat(document.getElementById('simReactionMs').value);
    const acc = parseFloat(document.getElementById('simAccuracy').value);
    const speed = parseFloat(document.getElementById('simSpeed').value);

    try {
      const resp = await fetch('/api/admin/super/risk-config/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
        body: JSON.stringify({
          aim_jitter: aim,
          reaction_time_ms: reaction,
          accuracy: acc,
          speed_multiplier: speed
        })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Simulation failed');

      const scoreEl = document.getElementById('simScoreVal');
      const verdictEl = document.getElementById('simVerdictVal');
      if (scoreEl) scoreEl.textContent = `${data.simulated_risk_score} / 100`;
      if (verdictEl) {
        verdictEl.textContent = `${data.risk_category} Risk (${data.verdict})`;
        verdictEl.style.color = data.simulated_risk_score >= 65 ? '#DC2626' : (data.simulated_risk_score >= 35 ? '#D97706' : '#059669');
      }
    } catch (err) {
      window.showAppAlert(`Simulation error: ${err.message}`, { tone: "error" });
    }
  });

  // 6. Emergency Lockdown Dialog
  const lockdownBtn = document.getElementById('toggleLockdownBtn');
  const lockdownModal = document.getElementById('superLockdownModal');
  const cancelLockdownBtn = document.getElementById('cancelLockdownModalBtn');
  const lockdownForm = document.getElementById('lockdownConfirmForm');
  const disengageBtn = document.getElementById('disengageLockdownBtn');

  if (lockdownBtn && lockdownModal) {
    lockdownBtn.addEventListener('click', () => {
      document.getElementById('lockdownReasonInput').value = '';
      document.getElementById('lockdownPasswordInput').value = '';
      const fb = document.getElementById('lockdownFeedback');
      if (fb) fb.hidden = true;
      lockdownModal.showModal();
    });
  }

  if (cancelLockdownBtn && lockdownModal) {
    cancelLockdownBtn.addEventListener('click', () => lockdownModal.close());
  }

  if (lockdownForm) {
    lockdownForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const reason = document.getElementById('lockdownReasonInput').value.trim();
      const password = document.getElementById('lockdownPasswordInput').value;
      const fb = document.getElementById('lockdownFeedback');

      try {
        const resp = await fetch('/api/admin/super/lockdown', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
          body: JSON.stringify({ lockdown: true, reason, reauth_password: password })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.message || 'Lockdown failed');

        lockdownModal.close();
        window.showAppAlert('🚨 EMERGENCY PLATFORM LOCKDOWN ENGAGED.');
        loadSecurityCommand();
      } catch (err) {
        if (fb) {
          fb.textContent = err.message;
          fb.hidden = false;
        }
      }
    });
  }

  if (disengageBtn) {
    disengageBtn.addEventListener('click', async () => {
      const pw = await window.showAppPrompt('Confirm your identity to disengage emergency lockdown.', { type: 'password', label: 'Super Admin password' });
      if (!pw) return;
      try {
        const resp = await fetch('/api/admin/super/lockdown', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
          body: JSON.stringify({ lockdown: false, reauth_password: pw })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.message || 'Failed to disengage lockdown');
        window.showAppAlert('✓ Emergency lockdown disengaged. Normal operations restored.');
        loadSecurityCommand();
      } catch (err) {
        window.showAppAlert(`Error: ${err.message}`, { tone: "error" });
      }
    });
  }

  // 7. System metrics refresh
  document.getElementById('refreshSystemMetricsBtn')?.addEventListener('click', loadSystemControlMetrics);

  // 8. Create Backup Snapshot
  document.getElementById('createBackupSnapshotBtn')?.addEventListener('click', async () => {
    if (!await window.showAppConfirm('Trigger immediate on-demand cluster snapshot and verify integrity?')) return;
    try {
      const resp = await fetch('/api/admin/super/backups/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' }
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Backup failed');
      window.showAppAlert(`✓ ${data.message}`);
      loadSystemBackups();
    } catch (err) {
      window.showAppAlert(`Backup error: ${err.message}`, { tone: "error" });
    }
  });

  // 9. Save Platform Config
  document.getElementById('savePlatformConfigBtn')?.addEventListener('click', async () => {
    const timeout = parseInt(document.getElementById('cfgSessionTimeout').value, 10);
    const maxAttempts = parseInt(document.getElementById('cfgMaxLoginAttempts').value, 10);
    const lockout = parseInt(document.getElementById('cfgLockoutDuration').value, 10);
    const maint = document.getElementById('cfgMaintenanceModeCb').checked;
    const maintMsg = document.getElementById('cfgMaintenanceMsg').value.trim();

    try {
      const resp = await fetch('/api/admin/super/platform-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
        body: JSON.stringify({
          security_policies: {
            session_timeout_minutes: timeout,
            max_login_attempts: maxAttempts,
            lockout_duration_minutes: lockout,
            maintenance_mode: maint,
            maintenance_message: maintMsg
          }
        })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Failed to save platform config');
      window.showAppAlert('✓ Platform security policies and settings saved.');
      loadPlatformConfig();
    } catch (err) {
      window.showAppAlert(`Error: ${err.message}`, { tone: "error" });
    }
  });

  // 10. Threat and Analytics refresh
  document.getElementById('refreshThreatsBtn')?.addEventListener('click', loadThreatMonitoring);
  document.getElementById('refreshAnalyticsBtn')?.addEventListener('click', loadReportsAnalytics);
}

// =========================================================================
// SUPER ADMIN DATA LOADERS
// =========================================================================

export async function loadSuperAdmins() {
  const tbody = document.getElementById('superAdminsTableBody');
  if (!tbody) return;

  try {
    const resp = await fetch('/api/admin/super/admins', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;

    const data = await resp.json();
    const admins = data.admins || [];

    tbody.innerHTML = admins.map(a => {
      const isSuper = a.is_super_admin;
      const statusBadge = a.account_status === 'active'
        ? '<span class="badge badge-success">Active</span>'
        : (a.account_status === 'suspended' ? '<span class="badge badge-warning">Suspended</span>' : '<span class="badge badge-danger">Deactivated</span>');
      
      const roleBadge = isSuper
        ? '<span class="admin-tier-badge level-2">👑 Super Admin (L2)</span>'
        : '<span class="admin-tier-badge level-1">🛡️ Normal Admin (L1)</span>';

      return `
        <tr>
          <td>
            <strong>${escapeHtml(a.name)}</strong>
            <br><small class="muted">${escapeHtml(a.email)}</small>
          </td>
          <td>${roleBadge}</td>
          <td>${statusBadge}</td>
          <td><span class="badge ${a.mfa_enabled ? 'badge-cyan' : 'badge-danger'}">${a.mfa_enabled ? 'MFA Enrolled' : 'MFA Disabled'}</span></td>
          <td><strong style="color:#4C1D95;">${a.active_sessions}</strong> active</td>
          <td><small class="muted">${formatTimeAgo(a.last_login)}</small></td>
          <td>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button class="ghost-btn admin-act-btn" data-act="reset-mfa" data-id="${a.id}" data-name="${escapeHtml(a.name)}" title="Reset MFA">MFA</button>
              <button class="ghost-btn admin-act-btn" data-act="revoke-sessions" data-id="${a.id}" data-name="${escapeHtml(a.name)}" title="Revoke Sessions">Sessions</button>
              ${!isSuper ? `
                <button class="ghost-btn admin-act-btn" data-act="toggle-status" data-id="${a.id}" data-status="${a.account_status}" data-name="${escapeHtml(a.name)}" style="color:#D97706;">${a.account_status === 'active' ? 'Suspend' : 'Activate'}</button>
                <button class="ghost-btn admin-act-btn" data-act="delete" data-id="${a.id}" data-name="${escapeHtml(a.name)}" style="color:#DC2626;">Delete</button>
              ` : `
                <span class="badge" style="background:#FEF3C7; color:#B45309; font-size:10px;">Root Protected</span>
              `}
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Wire action buttons
    tbody.querySelectorAll('.admin-act-btn').forEach(btn => {
      btn.addEventListener('click', () => handleAdminAction(btn.dataset.act, btn.dataset.id, btn.dataset.name, btn.dataset.status));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="error-cell">Failed to load administrator roster: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function handleAdminAction(act, id, name, currentStatus) {
  if (act === 'reset-mfa') {
    if (!await window.showAppConfirm(`Reset MFA configuration for administrator ${name}? They will re-enroll on next login.`)) return;
    const resp = await fetch(`/api/admin/super/admins/${id}/reset-mfa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' }
    });
    const d = await resp.json();
    window.showAppAlert(d.message || (resp.ok ? 'MFA Reset' : 'Failed'));
    loadSuperAdmins();
  } else if (act === 'revoke-sessions') {
    if (!await window.showAppConfirm(`Revoke all active sessions for administrator ${name}?`)) return;
    const resp = await fetch(`/api/admin/super/admins/${id}/revoke-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' }
    });
    const d = await resp.json();
    window.showAppAlert(d.message || (resp.ok ? 'Sessions Revoked' : 'Failed'));
    loadSuperAdmins();
  } else if (act === 'toggle-status') {
    const nextStatus = currentStatus === 'active' ? 'suspended' : 'active';
    if (!await window.showAppConfirm(`Set administrator ${name} status to '${nextStatus}'?`)) return;
    const resp = await fetch(`/api/admin/super/admins/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
      body: JSON.stringify({ status: nextStatus })
    });
    const d = await resp.json();
    window.showAppAlert(d.message || (resp.ok ? 'Status Updated' : 'Failed'));
    loadSuperAdmins();
  } else if (act === 'delete') {
    const pw = await window.showAppPrompt(`Permanently delete administrator ${name}?`, { type: 'password', label: 'Super Admin password', confirmText: 'Delete administrator' });
    if (!pw) return;
    const resp = await fetch(`/api/admin/super/admins/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
      body: JSON.stringify({ reauth_password: pw })
    });
    const d = await resp.json();
    window.showAppAlert(d.message || (resp.ok ? 'Admin Deleted' : 'Failed'));
    loadSuperAdmins();
  }
}

export async function loadRolesPermissions() {
  const grid = document.getElementById('normalAdminPermissionsGrid');
  if (!grid) return;

  try {
    const resp = await fetch('/api/admin/super/roles-permissions', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;

    const data = await resp.json();
    const roles = data.roles || [];
    const normalRole = roles.find(r => r.role === 'NORMAL_ADMIN') || {};
    const perms = normalRole.permissions || {};

    grid.innerHTML = Object.entries(perms).map(([k, val]) => `
      <div class="permission-toggle-item">
        <label for="perm_${k}" style="font-size:12px; font-weight:600; cursor:pointer; color:#1E1B4B;">
          <code>${escapeHtml(k)}</code>
        </label>
        <input type="checkbox" id="perm_${k}" class="perm-cb" data-perm="${escapeHtml(k)}" ${val ? 'checked' : ''} style="width:18px; height:18px;">
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = `<div class="error-cell">Error: ${escapeHtml(err.message)}</div>`;
  }
}

export async function loadMlModelsCatalog() {
  const tbody = document.getElementById('superMlCatalogTableBody');
  if (!tbody) return;

  try {
    const resp = await fetch('/api/admin/super/ml-models', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;

    const data = await resp.json();
    const active = data.active_model || {};
    const models = data.models || [];

    const nameEl = document.getElementById('superMlModelName');
    const badgeEl = document.getElementById('superMlActiveVersionBadge');
    if (nameEl) nameEl.textContent = active.name || 'No validated model';
    if (badgeEl) badgeEl.textContent = active.version ? `${active.version} Active` : 'Unavailable';

    const accEl = document.getElementById('mlMetricAccuracy');
    const precEl = document.getElementById('mlMetricPrecision');
    const recEl = document.getElementById('mlMetricRecall');
    const f1El = document.getElementById('mlMetricF1');

    const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "Unavailable";
    if (accEl) accEl.textContent = `${percent(active.accuracy)}`;
    if (precEl) precEl.textContent = `${percent(active.precision)}`;
    if (recEl) recEl.textContent = `${percent(active.recall)}`;
    if (f1El) f1El.textContent = Number.isFinite(active.f1_score) ? active.f1_score.toFixed(3) : "Unavailable";

    tbody.innerHTML = models.map(m => `
      <tr>
        <td><strong>${escapeHtml(m.version)}</strong><br><small class="muted">${escapeHtml(m.name)}</small></td>
        <td><span class="badge badge-cyan">${escapeHtml(m.algorithm)}</span></td>
        <td><strong style="color:#059669;">${percent(m.accuracy)}</strong></td>
        <td>${percent(m.precision)} / ${percent(m.recall)}</td>
        <td>${percent(m.false_positive_rate)}</td>
        <td><span class="badge ${m.is_active ? 'badge-success' : 'badge-warning'}">${m.is_active ? 'Active' : 'Archived'}</span></td>
        <td>
          ${!m.is_active ? `
            <button class="play-btn rollback-btn" data-version="${escapeHtml(m.version)}" style="min-width:auto; height:28px; padding:0 10px; font-size:11px; background:#DC2626;">Rollback to ${escapeHtml(m.version)}</button>
          ` : '<span style="color:#059669; font-weight:700; font-size:11px;">✓ Live</span>'}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.rollback-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ver = btn.dataset.version;
        if (!await window.showAppConfirm(`Are you sure you want to rollback active ML inference to model '${ver}'?`)) return;
        const resp = await fetch('/api/admin/super/ml-models/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
          body: JSON.stringify({ version: ver, reason: `Manual rollback by Super Admin to ${ver}` })
        });
        const d = await resp.json();
        window.showAppAlert(d.message || 'Rollback complete.');
        loadMlModelsCatalog();
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="error-cell">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

export async function loadRiskConfig() {
  try {
    const resp = await fetch('/api/admin/super/risk-config', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const r = data.risk_engine || {};

    const low = document.getElementById('riskLowThreshold');
    const med = document.getElementById('riskMedThreshold');
    const high = document.getElementById('riskHighThreshold');
    const crit = document.getElementById('riskCritThreshold');

    if (low && r.low_threshold != null) low.value = r.low_threshold;
    if (med && r.medium_threshold != null) med.value = r.medium_threshold;
    if (high && r.high_threshold != null) high.value = r.high_threshold;
    if (crit && r.critical_threshold != null) crit.value = r.critical_threshold;
  } catch (err) {
    console.error('[AdminSuper] Risk config load failed:', err);
  }
}

export async function loadSecurityCommand() {
  try {
    const resp = await fetch('/api/admin/super/security-command', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;
    const data = await resp.json();

    const lockdownNotice = document.getElementById('superLockdownNoticeBox');
    const reasonText = document.getElementById('lockdownReasonText');
    const toggleBtn = document.getElementById('toggleLockdownBtn');

    if (data.emergency_lockdown) {
      if (lockdownNotice) lockdownNotice.style.display = 'flex';
      if (reasonText) reasonText.textContent = `Reason: ${data.lockdown_reason || 'Critical security protocol'} (Engaged by ${data.lockdown_by || 'Super Admin'} at ${data.lockdown_at || 'Recently'})`;
      if (toggleBtn) {
        toggleBtn.textContent = '🚨 Lockdown Active';
        toggleBtn.disabled = true;
      }
    } else {
      if (lockdownNotice) lockdownNotice.style.display = 'none';
      if (toggleBtn) {
        toggleBtn.textContent = '🚨 Engage Platform Lockdown';
        toggleBtn.disabled = false;
      }
    }

    const tbody = document.getElementById('superCriticalIncidentsTableBody');
    if (tbody) {
      const incidents = data.recent_critical_incidents || [];
      if (incidents.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">No critical high-severity platform incidents recorded.</td></tr>';
      } else {
        tbody.innerHTML = incidents.map(inc => `
          <tr>
            <td><span class="badge badge-danger">${escapeHtml(inc.type || 'Incident')}</span></td>
            <td><strong>${escapeHtml(inc.description || '')}</strong></td>
            <td><small class="muted">${formatTimeAgo(inc.timestamp)}</small></td>
            <td><span class="badge badge-warning">Under Review</span></td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    console.error('[AdminSuper] Security command load failed:', err);
  }
}

export async function loadSystemControlMetrics() {
  try {
    const resp = await fetch('/api/admin/super/system-metrics', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;
    const data = await resp.json();

    const uptime = document.getElementById('metricServerUptime');
    const dbStat = document.getElementById('metricDbStatus');
    const dbLat = document.getElementById('metricDbLatency');
    const apiLat = document.getElementById('metricApiLatency');
    const mlInf = document.getElementById('metricMlInference');

    if (uptime && data.runtime) {
      const sec = data.runtime.uptime_seconds;
      const hours = Math.floor(sec / 3600);
      const mins = Math.floor((sec % 3600) / 60);
      uptime.textContent = `${hours}h ${mins}m`;
    }
    if (dbStat && data.database) dbStat.textContent = data.database.status;
    if (dbLat && data.database) dbLat.textContent = data.database.latency_ms == null ? "Unavailable" : `${data.database.latency_ms} ms · ${data.database.documents ?? "—"} docs`;
    if (apiLat && data.api_gateway) apiLat.textContent = data.api_gateway.latency_p95_ms == null ? "Unavailable" : `${data.api_gateway.latency_p95_ms} ms`;
    if (mlInf && data.ml_inference) mlInf.textContent = data.ml_inference.probe_inference_ms == null ? "Unavailable" : `${data.ml_inference.probe_inference_ms} ms (probe)`;
  } catch (err) {
    console.error('[AdminSuper] System metrics load failed:', err);
  }
}

export async function loadSystemBackups() {
  const tbody = document.getElementById('superBackupsTableBody');
  if (!tbody) return;

  try {
    const resp = await fetch('/api/admin/super/backups', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const backups = data.backups || [];

    if (backups.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No verified system snapshots found.</td></tr>';
      return;
    }

    tbody.innerHTML = backups.map(b => `
      <tr>
        <td><code>${escapeHtml(b.backup_id)}</code></td>
        <td><span class="badge badge-cyan">${escapeHtml(b.scope || 'Unavailable')}</span></td>
        <td><strong>${b.size_mb} MB</strong></td>
        <td>${b.documents_count} records</td>
        <td><code style="font-size:10px;">${escapeHtml(b.checksum ? b.checksum.substring(0, 24) : '—')}…</code></td>
        <td><span class="badge ${b.status === "verified" ? "badge-success" : "badge-warning"}">${b.status === "verified" ? "Verified" : "Unavailable"}</span></td>
        <td><small class="muted">${formatTimeAgo(b.created_at)}</small></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="error-cell">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

export async function loadPlatformConfig() {
  try {
    const resp = await fetch('/api/admin/super/platform-config', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const pol = data.security_policies || {};

    const timeout = document.getElementById('cfgSessionTimeout');
    const maxAtt = document.getElementById('cfgMaxLoginAttempts');
    const lockout = document.getElementById('cfgLockoutDuration');
    const maintCb = document.getElementById('cfgMaintenanceModeCb');
    const maintMsg = document.getElementById('cfgMaintenanceMsg');

    if (timeout && pol.session_timeout_minutes != null) timeout.value = pol.session_timeout_minutes;
    if (maxAtt && pol.max_login_attempts != null) maxAtt.value = pol.max_login_attempts;
    if (lockout && pol.lockout_duration_minutes != null) lockout.value = pol.lockout_duration_minutes;
    if (maintCb && pol.maintenance_mode != null) maintCb.checked = Boolean(pol.maintenance_mode);
    if (maintMsg && pol.maintenance_message) maintMsg.value = pol.maintenance_message;
  } catch (err) {
    console.error('[AdminSuper] Platform config load failed:', err);
  }
}

// =========================================================================
// NORMAL ADMIN DATA LOADERS: THREATS & ANALYTICS
// =========================================================================

export async function loadThreatMonitoring() {
  try {
    const resp = await fetch('/api/admin/threats', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;
    const data = await resp.json();

    const activeEl = document.getElementById('threatActiveCount');
    const highRiskEl = document.getElementById('threatHighRiskCount');
    const repeatEl = document.getElementById('threatRepeatViolatorsCount');
    const failedLoginsEl = document.getElementById('threatFailedLoginsCount');

    const highRisk = data.high_risk_players || [];
    const repeat = data.repeated_violators || [];
    const suspLogins = data.suspicious_logins || [];

    if (activeEl) activeEl.textContent = data.active_threat_count ?? 0;
    if (highRiskEl) highRiskEl.textContent = highRisk.length;
    if (repeatEl) repeatEl.textContent = repeat.length;
    if (failedLoginsEl) failedLoginsEl.textContent = suspLogins.length;

    // High Risk Table
    const tbodyHigh = document.getElementById('threatHighRiskTableBody');
    if (tbodyHigh) {
      if (highRisk.length === 0) {
        tbodyHigh.innerHTML = '<tr><td colspan="4" class="empty">No players currently exceeding high-risk threshold.</td></tr>';
      } else {
        tbodyHigh.innerHTML = highRisk.map(p => `
          <tr>
            <td><strong>${escapeHtml(p.name)}</strong><br><small class="muted">${escapeHtml(p.email)}</small></td>
            <td><strong style="color:#DC2626;">${p.risk_score} / 100</strong></td>
            <td><span class="badge ${p.status === 'banned' ? 'badge-danger' : 'badge-warning'}">${escapeHtml(p.status)}</span></td>
            <td><button class="play-btn inspect-threat-btn" data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-email="${escapeHtml(p.email || '')}" style="min-width:auto; height:28px; padding:0 10px; font-size:11px;">Inspect</button></td>
          </tr>
        `).join('');
      }
    }

    // Repeat Violators Table
    const tbodyRep = document.getElementById('threatRepeatViolatorsTableBody');
    if (tbodyRep) {
      if (repeat.length === 0) {
        tbodyRep.innerHTML = '<tr><td colspan="4" class="empty">No repeat violation records.</td></tr>';
      } else {
        tbodyRep.innerHTML = repeat.map(v => `
          <tr>
            <td><strong>${escapeHtml(v.name)}</strong><br><small class="muted">${escapeHtml(v.email)}</small></td>
            <td><span class="badge badge-danger">${v.violations} Infractions</span></td>
            <td><strong>${v.risk_score}</strong></td>
            <td><button class="ghost-btn inspect-threat-btn" data-id="${v.id}" data-name="${escapeHtml(v.name)}" data-email="${escapeHtml(v.email || '')}" style="min-width:auto; height:28px; padding:0 10px; font-size:11px;">View</button></td>
          </tr>
        `).join('');
      }
    }

    // Attach click listeners to inspect/view buttons
    document.querySelectorAll('.inspect-threat-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.dataset.id;
        const name = e.currentTarget.dataset.name;
        const email = e.currentTarget.dataset.email || '';
        if (window.openPlayerMatchesModal) {
          window.openPlayerMatchesModal(id, name, email);
        }
      });
    });

    // Suspicious Logins Table
    const tbodyLog = document.getElementById('threatSuspiciousLoginsTableBody');
    if (tbodyLog) {
      if (suspLogins.length === 0) {
        tbodyLog.innerHTML = '<tr><td colspan="6" class="empty">No suspicious login events detected.</td></tr>';
      } else {
        tbodyLog.innerHTML = suspLogins.map(l => `
          <tr>
            <td><code>${escapeHtml(l.identifier || '—')}</code></td>
            <td><strong>${escapeHtml(l.name)}</strong></td>
            <td><code style="background:#EDE9FE; color:#5B21B6; padding:2px 6px; border-radius:4px; font-size:11px;">${escapeHtml(l.ip || '127.0.0.1')}</code></td>
            <td><small>${escapeHtml(l.device || 'Chrome (Win)')}</small></td>
            <td><span class="badge badge-danger">${escapeHtml(l.reason || 'Failed auth')}</span></td>
            <td><small class="muted">${formatTimeAgo(l.time)}</small></td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    console.error('[AdminThreats] Load failed:', err);
  }
}

export async function loadReportsAnalytics() {
  try {
    const resp = await fetch('/api/admin/analytics/reports', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;
    const data = await resp.json();

    const dist = data.player_distribution || {};
    const det = data.detection_metrics || {};
    const fp = data.false_positive_metrics || {};

    const actEl = document.getElementById('analyticsActivePlayers');
    const sancEl = document.getElementById('analyticsSanctionedPlayers');
    const matchesEl = document.getElementById('analyticsAnalyzedMatches');
    const precEl = document.getElementById('analyticsPrecisionEstimate');

    const total = dist.total || 1;
    if (actEl) actEl.textContent = dist.active ?? 0;
    if (sancEl) sancEl.textContent = (dist.suspended || 0) + (dist.banned || 0);
    if (matchesEl) matchesEl.textContent = det.analyzed_sessions ?? det.total_matches ?? 0;
    if (precEl) precEl.textContent = fp.model_precision_estimate == null ? "Unavailable" : `${fp.model_precision_estimate}%`;

    // Distribution values & bars
    const dActVal = document.getElementById('distActiveVal');
    const dSuspVal = document.getElementById('distSuspendedVal');
    const dBanVal = document.getElementById('distBannedVal');

    const dActBar = document.getElementById('distActiveBar');
    const dSuspBar = document.getElementById('distSuspendedBar');
    const dBanBar = document.getElementById('distBannedBar');

    if (dActVal) dActVal.textContent = `${dist.active ?? 0} (${Math.round(((dist.active || 0) / total) * 100)}%)`;
    if (dSuspVal) dSuspVal.textContent = `${dist.suspended ?? 0} (${Math.round(((dist.suspended || 0) / total) * 100)}%)`;
    if (dBanVal) dBanVal.textContent = `${dist.banned ?? 0} (${Math.round(((dist.banned || 0) / total) * 100)}%)`;

    if (dActBar) dActBar.style.width = `${Math.round(((dist.active || 0) / total) * 100)}%`;
    if (dSuspBar) dSuspBar.style.width = `${Math.round(((dist.suspended || 0) / total) * 100)}%`;
    if (dBanBar) dBanBar.style.width = `${Math.round(((dist.banned || 0) / total) * 100)}%`;

    const totApp = document.getElementById('analyticsTotalAppeals');
    const otApp = document.getElementById('analyticsOverturnedAppeals');
    if (totApp) totApp.textContent = fp.total_appeals_reviewed ?? 0;
    if (otApp) otApp.textContent = fp.false_positives_overturned ?? 0;
  } catch (err) {
    console.error('[AdminAnalytics] Load failed:', err);
  }
}

// =========================================================================
// APPROVALS QUEUE (Tier 2 Command Center Workflows)
// =========================================================================

let currentApprovalFilter = 'all';

export async function loadApprovalsQueue(statusFilter = currentApprovalFilter) {
  currentApprovalFilter = statusFilter;
  const tbody = document.getElementById('approvalsTableBody');
  const badge = document.getElementById('approvalPendingBadge');
  const navBadge = document.getElementById('navApprovalBadge');
  if (!tbody) return;

  try {
    const query = statusFilter && statusFilter !== 'all' ? `?status=${statusFilter}` : '';
    const res = await fetch(`/api/admin/approvals${query}`, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const approvals = data.approvals || [];
    const pendingCount = data.pending_count || 0;

    if (badge) badge.textContent = pendingCount;
    if (navBadge) {
      navBadge.textContent = pendingCount;
      navBadge.style.display = pendingCount > 0 ? 'inline-block' : 'none';
    }

    if (!approvals.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No approval requests found for this filter.</td></tr>';
      return;
    }

    tbody.innerHTML = approvals.map(a => {
      const isPending = a.status === 'pending';
      const actionBadge = a.action === 'ban' 
        ? '<span class="badge bad" style="font-weight:800;">PERM BAN</span>' 
        : '<span class="badge warn" style="font-weight:800;">DELETE ACCOUNT</span>';
      const statusBadge = a.status === 'approved' 
        ? '<span class="badge good">APPROVED</span>' 
        : a.status === 'rejected' 
        ? '<span class="badge bad">REJECTED</span>' 
        : '<span class="badge warn">PENDING REVIEW</span>';

      const actionButtons = isPending && window.isSuperAdmin ? `
        <button class="play-btn review-approval-btn" data-id="${a.id}" data-action="approve" style="padding:4px 10px; font-size:11px; background:#10B981; color:#fff;">Approve</button>
        <button class="ghost-btn review-approval-btn" data-id="${a.id}" data-action="reject" style="padding:4px 10px; font-size:11px; color:#EF4444; border-color:#EF4444;">Reject</button>
      ` : (a.reviewed_by_email ? `<small class="muted">Reviewed: ${escapeHtml(a.reviewed_by_email)}</small>` : '<small class="muted">—</small>');

      return `
        <tr>
          <td>
            <strong>${escapeHtml(a.player_name || 'Player')}</strong>
            <small style="display:block; color:var(--muted); font-size:11px;">${escapeHtml(a.player_email || '')}</small>
          </td>
          <td>${actionBadge}</td>
          <td>
            <div style="font-size:12px; font-weight:600;">${escapeHtml(a.reason || '—')}</div>
            ${a.evidence ? `<small style="color:var(--mint); display:block; margin-top:2px;">Evidence: ${escapeHtml(a.evidence)}</small>` : ''}
            ${a.review_note ? `<small style="color:var(--muted); display:block; margin-top:2px;">Note: ${escapeHtml(a.review_note)}</small>` : ''}
          </td>
          <td>
            <span style="font-size:12px; font-weight:600;">${escapeHtml(a.requested_by_email || 'Normal Admin')}</span>
          </td>
          <td><small class="muted">${formatTimeAgo(a.created_at)}</small></td>
          <td>${statusBadge}</td>
          <td><div style="display:flex; gap:6px; align-items:center;">${actionButtons}</div></td>
        </tr>
      `;
    }).join('');

    // Wire review buttons
    tbody.querySelectorAll('.review-approval-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const initialDecision = btn.dataset.action;
        const req = approvals.find(x => x.id === id);
        if (req) openProcessApprovalModal(req, initialDecision);
      });
    });

  } catch (err) {
    console.error('Error loading approvals:', err);
    tbody.innerHTML = '<tr><td colspan="7" class="empty" style="color:var(--danger);">Failed to load approval requests.</td></tr>';
  }
}

export function openRequestApprovalModal(playerId, playerName, action = 'ban') {
  const modal = document.getElementById('requestApprovalModal');
  if (!modal) return;
  document.getElementById('reqApprovalPlayerId').value = playerId;
  document.getElementById('reqApprovalAction').value = action;
  document.getElementById('reqApprovalPlayerName').textContent = playerName || playerId;
  
  const badge = document.getElementById('reqApprovalActionBadge');
  const title = document.getElementById('reqApprovalTitle');
  if (action === 'ban') {
    if (title) title.textContent = 'Request Permanent Ban Approval';
    if (badge) {
      badge.textContent = 'Permanent Account Ban';
      badge.style.color = '#EF4444';
    }
  } else {
    if (title) title.textContent = 'Request Account Erasure Approval';
    if (badge) {
      badge.textContent = 'Soft Delete & GDPR Erasure';
      badge.style.color = '#F59E0B';
    }
  }

  document.getElementById('reqApprovalReason').value = '';
  document.getElementById('reqApprovalEvidence').value = '';
  const statusEl = document.getElementById('reqApprovalStatus');
  if (statusEl) statusEl.textContent = '';
  modal.hidden = false;
}

export function openProcessApprovalModal(req, defaultDecision = 'approve') {
  const modal = document.getElementById('processApprovalModal');
  if (!modal) return;
  document.getElementById('processApprovalId').value = req.id;
  document.getElementById('procModalPlayerName').textContent = `${req.player_name || 'Player'} (${req.player_email || ''})`;
  document.getElementById('procModalRequestedBy').textContent = req.requested_by_email || 'Normal Admin';
  document.getElementById('procModalReason').textContent = req.reason || '—';
  
  const evRow = document.getElementById('procModalEvidenceRow');
  const evText = document.getElementById('procModalEvidence');
  if (req.evidence) {
    evText.textContent = req.evidence;
    evRow.style.display = 'block';
  } else {
    evRow.style.display = 'none';
  }

  const badge = document.getElementById('procModalActionBadge');
  if (badge) {
    badge.textContent = req.action.toUpperCase();
    badge.className = req.action === 'ban' ? 'badge bad' : 'badge warn';
  }

  const radios = document.getElementsByName('procDecision');
  radios.forEach(r => { r.checked = (r.value === defaultDecision); });

  document.getElementById('procModalNote').value = '';
  const statusEl = document.getElementById('procModalStatus');
  if (statusEl) statusEl.textContent = '';
  modal.hidden = false;
}

export function initApprovalsSection() {
  // Filter buttons
  document.querySelectorAll('.approval-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.approval-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadApprovalsQueue(btn.dataset.filter);
    });
  });

  const refreshBtn = document.getElementById('refreshApprovalsBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadApprovalsQueue());

  // Request modal cancel/close
  document.getElementById('closeReqApprovalModalBtn')?.addEventListener('click', () => {
    document.getElementById('requestApprovalModal').hidden = true;
  });
  document.getElementById('cancelReqApprovalBtn')?.addEventListener('click', () => {
    document.getElementById('requestApprovalModal').hidden = true;
  });

  // Request form submission
  document.getElementById('requestApprovalForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const playerId = document.getElementById('reqApprovalPlayerId').value;
    const action = document.getElementById('reqApprovalAction').value;
    const reason = document.getElementById('reqApprovalReason').value.trim();
    const evidence = document.getElementById('reqApprovalEvidence').value.trim();
    const statusEl = document.getElementById('reqApprovalStatus');
    const submitBtn = document.getElementById('submitReqApprovalBtn');

    if (reason.length < 10) {
      statusEl.textContent = 'Reason must be at least 10 characters.';
      return;
    }

    try {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting request…';
      const res = await fetch('/api/admin/approvals/request', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ player_id: playerId, action, reason, evidence })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Submission failed');

      window.showAppAlert(`✅ ${data.message}`);
      document.getElementById('requestApprovalModal').hidden = true;
      if (window.loadApprovalsQueue) loadApprovalsQueue();
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit for Executive Review →';
    }
  });

  // Process modal cancel/close
  document.getElementById('closeProcessApprovalModalBtn')?.addEventListener('click', () => {
    document.getElementById('processApprovalModal').hidden = true;
  });
  document.getElementById('cancelProcApprovalBtn')?.addEventListener('click', () => {
    document.getElementById('processApprovalModal').hidden = true;
  });

  // Process form submission
  document.getElementById('processApprovalForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const approvalId = document.getElementById('processApprovalId').value;
    const radios = document.getElementsByName('procDecision');
    let decision = 'approve';
    for (const r of radios) { if (r.checked) decision = r.value; }
    const note = document.getElementById('procModalNote').value.trim();
    const statusEl = document.getElementById('procModalStatus');
    const submitBtn = document.getElementById('confirmProcApprovalBtn');

    try {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Processing…';
      const res = await fetch(`/api/admin/approvals/${approvalId}/action`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ decision, note })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Action failed');

      window.showAppAlert(`✅ ${data.message}`);
      document.getElementById('processApprovalModal').hidden = true;
      loadApprovalsQueue();
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Confirm Decision';
    }
  });
}

