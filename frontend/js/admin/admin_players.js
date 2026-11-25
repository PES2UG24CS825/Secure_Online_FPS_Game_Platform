/**
 * SecureFPS Admin Players Module
 * Server-side pagination, sorting, search, bulk actions, soft delete, and CSV export.
 */
import { escapeHtml, formatTimeAgo, incidentLabel, promptAdminAction } from './admin_core.js?v=20261125_demo_visibility';
import { openRequestApprovalModal } from './admin_super.js?v=20261125_demo_visibility';

let currentPlayersPage = 0;
const PAGE_SIZE = 10;
let currentSearch = '';
let currentStatusFilter = '';
let currentSortBy = 'created_at';
let currentSortDir = 'desc';
let selectedPlayerIds = new Set();

export async function initPlayersSection() {
  window.openPlayerMatchesModal = openPlayerMatchesModal;
  const searchInput = document.getElementById('playerSearch');
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        currentSearch = e.target.value.trim();
        currentPlayersPage = 0;
        loadPlayersTable();
      }, 350);
    });
  }

  document.getElementById('adminPlayerAccountType')?.addEventListener('change', () => {
    currentPlayersPage = 0;
    void loadPlayersTable();
  });
  const statusSelect = document.getElementById('playerStatusFilter');
  if (statusSelect) {
    statusSelect.addEventListener('change', (e) => {
      currentStatusFilter = e.target.value;
      currentPlayersPage = 0;
      loadPlayersTable();
    });
  }

  const exportBtn = document.getElementById('exportPlayersCsvBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      window.location.href = '/api/admin/export/players';
    });
  }

  const closeBtn = document.getElementById('closePlayerModalBtn');
  const closeFooterBtn = document.getElementById('closePlayerModalFooterBtn');
  const modal = document.getElementById('playerMatchesModal');
  if (closeBtn && modal) closeBtn.addEventListener('click', () => modal.close());
  if (closeFooterBtn && modal) closeFooterBtn.addEventListener('click', () => modal.close());

  // Player Honour Score & Account Security Quick Controls
  const btnHonourPlus5 = document.getElementById('btnHonourPlus5');
  if (btnHonourPlus5) btnHonourPlus5.addEventListener('click', () => sendPlayerHonourAdjustment(5, undefined, 'Admin fair-play boost (+5 Honour)'));

  const btnHonourPlus10 = document.getElementById('btnHonourPlus10');
  if (btnHonourPlus10) btnHonourPlus10.addEventListener('click', () => sendPlayerHonourAdjustment(10, undefined, 'Admin exemplary commendation (+10 Honour)'));

  const btnHonourMinus10 = document.getElementById('btnHonourMinus10');
  if (btnHonourMinus10) btnHonourMinus10.addEventListener('click', () => sendPlayerHonourAdjustment(-10, undefined, 'Admin sportsmanship penalty (-10 Honour)'));

  const btnHonourReset = document.getElementById('btnHonourReset');
  if (btnHonourReset) btnHonourReset.addEventListener('click', () => sendPlayerHonourAdjustment(undefined, 100, 'Admin full honour restoration'));

  const btnResetMfa = document.getElementById('btnResetMfa');
  if (btnResetMfa) btnResetMfa.addEventListener('click', async () => {
    if (await window.showAppConfirm('Are you sure you want to reset MFA for this player? They will need to set up their authenticator again on next sign-in.')) {
      sendPlayerSecurityAction('reset-mfa', 'MFA has been successfully reset.');
    }
  });

  const btnRevokeSessions = document.getElementById('btnRevokeSessions');
  if (btnRevokeSessions) btnRevokeSessions.addEventListener('click', async () => {
    if (await window.showAppConfirm('Are you sure you want to revoke all active sessions for this player?')) {
      sendPlayerSecurityAction('revoke-sessions', 'All active sessions revoked.');
    }
  });

  const btnForcePassReset = document.getElementById('btnForcePassReset');
  if (btnForcePassReset) btnForcePassReset.addEventListener('click', async () => {
    if (await window.showAppConfirm('Force this player to reset their password on next sign-in?')) {
      sendPlayerSecurityAction('force-password-reset', 'Password reset flagged.');
    }
  });

  await loadPlayersTable();
}

let activePlayerModalId = null;

async function sendPlayerHonourAdjustment(delta, newScore, reason) {
  if (!activePlayerModalId) return;
  const fb = document.getElementById('modalHonourFeedback');
  if (fb) { fb.textContent = 'Updating honour score…'; fb.style.color = '#7C3AED'; }
  try {
    const payload = {};
    if (newScore !== undefined) payload.new_score = newScore;
    else payload.delta = delta;
    if (reason) payload.reason = reason;

    const resp = await fetch(`/api/admin/players/${activePlayerModalId}/honour`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || 'Honour update failed');

    const honourEl = document.getElementById('modalHonourScore');
    const badgeEl = document.getElementById('modalHonourRankBadge');
    if (honourEl) honourEl.textContent = data.honour_score;
    if (badgeEl) badgeEl.textContent = `${data.honour_score} / 100`;
    if (fb) { fb.textContent = `âœ“ ${data.message}`; fb.style.color = '#059669'; }
    loadPlayersTable();
  } catch (err) {
    if (fb) { fb.textContent = `âœ• ${err.message}`; fb.style.color = '#DC2626'; }
  }
}

async function sendPlayerSecurityAction(endpoint, successText) {
  if (!activePlayerModalId) return;
  const fb = document.getElementById('modalSecurityFeedback');
  if (fb) { fb.textContent = 'Processing security operation…'; fb.style.color = '#7C3AED'; }
  try {
    const resp = await fetch(`/api/admin/players/${activePlayerModalId}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || 'Security operation failed');
    if (fb) { fb.textContent = `âœ“ ${data.message || successText}`; fb.style.color = '#059669'; }
    if (endpoint === 'reset-mfa') {
      const mfaBadge = document.getElementById('modalMfaStatusBadge');
      if (mfaBadge) { mfaBadge.textContent = 'MFA: Disabled'; mfaBadge.style.background = '#FEE2E2'; mfaBadge.style.color = '#B91C1C'; }
    }
    loadPlayersTable();
  } catch (err) {
    if (fb) { fb.textContent = `âœ• ${err.message}`; fb.style.color = '#DC2626'; }
  }
}

export async function loadPlayersTable() {
  const tbody = document.getElementById('players');
  const paginationEl = document.getElementById('playersPagination');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="9" class="loading-cell">Loading players…</td></tr>';

  try {
    const params = new URLSearchParams({
      limit: PAGE_SIZE,
      offset: currentPlayersPage * PAGE_SIZE,
      sort_by: currentSortBy,
      sort_dir: currentSortDir,
      account_type: document.getElementById("adminPlayerAccountType")?.value || "all",
    });
    if (currentSearch) params.set('q', currentSearch);
    if (currentStatusFilter) params.set('status', currentStatusFilter);

    const resp = await fetch(`/api/admin/players?${params.toString()}`, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });

    if (!resp.ok) {
      if (resp.status === 403) return;
      throw new Error(`Failed to load players: ${resp.status}`);
    }

    const data = await resp.json();
    if (data.is_super_admin !== undefined) {
      window.isSuperAdmin = Boolean(data.is_super_admin);
    }
    const players = data.players || [];
    const total = data.total || 0;

    renderPlayersRows(players, tbody);
    renderPagination(paginationEl, total);
  } catch (err) {
    console.error('[AdminPlayers] Error loading players:', err);
    tbody.innerHTML = `<tr><td colspan="9" class="error-cell">Error loading players: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderPlayersRows(players, tbody) {
  if (!players || players.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No players found matching current filters.</td></tr>';
    return;
  }

  const isSuper = Boolean(window.isSuperAdmin || (window.currentAdmin && window.currentAdmin.is_super_admin));

  tbody.innerHTML = players.map(p => {
    const status = p.account_status || 'active';
    let statusBadge = '<span class="badge badge-success">Active</span>';
    if (status === 'suspended') {
      const until = p.suspended_until ? ` until ${new Date(p.suspended_until).toLocaleDateString()}` : '';
      statusBadge = `<span class="badge badge-warning" title="${escapeHtml(p.ban_reason || 'Suspended')}">Suspended${until}</span>`;
    } else if (status === 'banned') {
      statusBadge = `<span class="badge badge-danger" title="${escapeHtml(p.ban_reason || 'Banned')}">Banned</span>`;
    } else if (status === 'deleted') {
      statusBadge = '<span class="badge badge-deleted" title="PII anonymized">Deleted</span>';
    }

    const riskScore = p.risk_score !== null && p.risk_score !== undefined ? p.risk_score : '—';
    const riskClass = (p.risk_score >= 70) ? 'risk-high' : ((p.risk_score >= 40) ? 'risk-med' : 'risk-low');

    return `
      <tr data-player-id="${escapeHtml(p.id)}">
        <td>
          <div class="player-cell">
            <strong>${escapeHtml(p.name)}${p.is_demo ? ' <span class="badge badge-danger" style="font-size:10px; padding:1px 6px; margin-left:4px;">DEMO</span>' : ''}</strong>
            <small class="muted">${escapeHtml(p.email)}</small>
          </div>
        </td>
        <td><span class="role-badge">${escapeHtml(p.role || 'player')}</span></td>
        <td>${statusBadge}</td>
        <td>
          <div class="security-score-bar">
            <span>${p.account_security_score ?? 100}%</span>
            <small class="muted">${escapeHtml(p.account_security_level || 'Good')}</small>
          </div>
        </td>
        <td>${p.matches_played ?? 0} matches</td>
        <td><span class="risk-pill ${riskClass}">${escapeHtml(riskScore)}</span></td>
        <td>${formatTimeAgo(p.created_at)}</td>
        <td class="table-actions">
          <button class="action-btn view-matches-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" data-email="${escapeHtml(p.email)}" style="background:#7C3AED !important; color:#FFFFFF !important; font-weight:700 !important;">Matches</button>
          <button class="action-btn view-violations-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" data-email="${escapeHtml(p.email)}">View Violations</button>
          ${isSuper ? (
            status === 'active' ? `
              <button class="action-btn suspend-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">Suspend</button>
              <button class="action-btn ban-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">Ban</button>
            ` : (status === 'suspended' ? `
              <button class="action-btn unsuspend-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">Unsuspend</button>
              <button class="action-btn ban-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">Ban</button>
            ` : (status === 'banned' ? `
              <button class="action-btn unban-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">Unban</button>
            ` : ''))
          ) : `
            <span class="badge" style="background:#1E293B; color:#38BDF8; font-weight:600;">Verified</span>
          `}
          ${status !== 'deleted' ? `
            <button class="action-btn delete-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" title="${isSuper ? 'Soft delete (anonymize PII)' : 'Request deletion approval'}">${isSuper ? 'Soft Delete' : 'Request Delete'}</button>
          ` : ''}
        </td>
      </tr>
    `;
  }).join('');

  attachRowListeners(tbody);
}

function attachRowListeners(tbody) {
  // Checkbox selection
  tbody.querySelectorAll('.player-select-cb').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) {
        selectedPlayerIds.add(id);
      } else {
        selectedPlayerIds.delete(id);
      }
      updateBulkToolbar();
    });
  });

  // Action Buttons
  tbody.querySelectorAll('.view-matches-btn').forEach(btn => {
    btn.addEventListener('click', () => openPlayerMatchesModal(btn.dataset.id, btn.dataset.name, btn.dataset.email));
  });
  tbody.querySelectorAll('.view-violations-btn').forEach(btn => {
    btn.addEventListener('click', () => openPlayerMatchesModal(btn.dataset.id, btn.dataset.name, btn.dataset.email, 'violations'));
  });
  tbody.querySelectorAll('.suspend-btn').forEach(btn => {
    btn.addEventListener('click', () => handleSuspend(btn.dataset.id, btn.dataset.name));
  });
  tbody.querySelectorAll('.unsuspend-btn').forEach(btn => {
    btn.addEventListener('click', () => handleUnsuspend(btn.dataset.id, btn.dataset.name));
  });
  tbody.querySelectorAll('.ban-btn').forEach(btn => {
    btn.addEventListener('click', () => handleBan(btn.dataset.id, btn.dataset.name));
  });
  tbody.querySelectorAll('.unban-btn').forEach(btn => {
    btn.addEventListener('click', () => handleUnban(btn.dataset.id, btn.dataset.name));
  });
  tbody.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => handleDelete(btn.dataset.id, btn.dataset.name));
  });
}

function handleSuspend(id, name) {
  promptAdminAction({
    title: `Suspend Player: ${name}`,
    message: 'Temporary suspension will revoke active sessions and prevent matchmaking.',
    actionLabel: 'Suspend Account',
    isDestructive: false,
    requireReason: true,
    allowEndDate: true,
    onConfirm: async (payload) => {
      const resp = await fetch(`/api/admin/players/${id}/suspend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Suspension failed');
      await loadPlayersTable();
    }
  });
}

function handleUnsuspend(id, name) {
  promptAdminAction({
    title: `Unsuspend Player: ${name}`,
    message: 'Restores the account to active status with full matchmaking access.',
    actionLabel: 'Unsuspend Account',
    requireReason: true,
    onConfirm: async (payload) => {
      const resp = await fetch(`/api/admin/players/${id}/unsuspend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Action failed');
      await loadPlayersTable();
    }
  });
}

function handleBan(id, name) {
  if (!window.isSuperAdmin) {
    openRequestApprovalModal(id, name, 'ban');
    return;
  }
  promptAdminAction({
    title: `Permanent Ban: ${name}`,
    message: 'Permanent ban revokes all sessions and terminates matchmaking access. Requires admin re-authentication.',
    actionLabel: 'Permanently Ban',
    isDestructive: true,
    requireReason: true,
    requireReauth: true,
    onConfirm: async (payload) => {
      const resp = await fetch(`/api/admin/players/${id}/ban`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) {
        if (data.can_request_approval) {
          openRequestApprovalModal(id, name, 'ban');
          return;
        }
        throw new Error(data.message || 'Ban failed');
      }
      await loadPlayersTable();
    }
  });
}

function handleUnban(id, name) {
  promptAdminAction({
    title: `Unban Player: ${name}`,
    message: 'Remove permanent ban and restore player account.',
    actionLabel: 'Unban Account',
    requireReason: true,
    onConfirm: async (payload) => {
      const resp = await fetch(`/api/admin/players/${id}/unban`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Unban failed');
      await loadPlayersTable();
    }
  });
}

const plainViolationLabels = {
  'Rapid Fire Violation': 'Shooting Too Fast',
  'Excessive Movement Speed': 'Moving Too Fast',
  'Angle Snap / Aimbot': 'Sudden Aim Changes',
  'Abnormal Accuracy': 'Unusually High Accuracy',
  'Gameplay Anomaly': 'Unusual Gameplay',
  'Server Hard-Rule Violation': 'Game Rule Violation',
};

const violationRows = document.getElementById('modalViolationsTableBody');
const renderViolationPage = violationRows && window.createRecordPager(violationRows, 'Violation pages');
const matchRows = document.getElementById('modalMatchesTableBody');
const renderAdminMatchPage = matchRows && window.createRecordPager(matchRows, 'Player match pages');

function renderPlayerViolations(events) {
  const tableBody = document.getElementById('modalViolationsTableBody');
  const badge = document.getElementById('modalViolationsCountBadge');
  const records = Array.isArray(events) ? events : [];
  if (badge) {
    badge.textContent = `${records.length} violation${records.length === 1 ? '' : 's'}`;
    badge.className = `badge ${records.length ? 'badge-danger' : 'badge-success'}`;
  }
  if (!tableBody) return;
  renderViolationPage(records, rows => paintViolations(tableBody, rows), activePlayerModalId);
}

function paintViolations(tableBody, records) {
  if (!records.length) {
    tableBody.innerHTML = '<tr><td colspan="4" class="empty">No violations recorded for this player.</td></tr>';
    return;
  }
  tableBody.innerHTML = records.map(event => {
    const severity = (event.severity || 'medium').toLowerCase();
    const badgeClass = severity === 'high' ? 'badge-danger' : (severity === 'medium' ? 'badge-warning' : 'badge-cyan');
    const label = event.violation || incidentLabel(event.incident_type || event.event_type || event.type || 'game_rule_violation');
    const details = event.description || 'This event was flagged by the system.';
    const observed = event.observed_value;
    const allowed = event.allowed_value;
    return `<tr>
      <td><span class="badge ${badgeClass}">${escapeHtml(Object.hasOwn(plainViolationLabels, label) ? plainViolationLabels[label] : label)}</span></td>
      <td><strong class="violation-severity ${escapeHtml(severity)}">${escapeHtml(severity)}</strong></td>
      <td><details class="violation-details"><summary>See what happened</summary>${escapeHtml(details)}
        <small>${event.is_demo ? 'Demo evidence · ' : ''}${escapeHtml(event.source || 'Source unavailable')}</small>
        <small>Match: ${escapeHtml(event.session_id || 'Unavailable')} · Risk: ${escapeHtml(event.risk_score ?? 'Unavailable')}</small>
        ${observed != null && observed !== '' ? `<small><b>Recorded:</b> ${escapeHtml(observed)}</small>` : ''}
        ${allowed != null && allowed !== '' ? `<small><b>Allowed:</b> ${escapeHtml(allowed)}</small>` : ''}
      </details></td>
      <td><small class="muted">${formatTimeAgo(event.created_at || event.timestamp)}</small></td>
    </tr>`;
  }).join('');
}

export async function openPlayerMatchesModal(id, name, email, view = 'player') {
  window.openPlayerMatchesModal = openPlayerMatchesModal;
  const modal = document.getElementById('playerMatchesModal');
  if (!modal) return;
  modal.dataset.view = view === 'violations' ? 'violations' : 'player';

  activePlayerModalId = id;

  const nameEl = document.getElementById('modalPlayerName');
  const emailEl = document.getElementById('modalPlayerEmail');
  const avatarEl = document.getElementById('modalPlayerAvatar');
  if (nameEl) nameEl.textContent = name || 'Player';
  if (emailEl) emailEl.textContent = email || '';
  if (avatarEl) avatarEl.textContent = (name || 'P').charAt(0).toUpperCase();

  const fbHonour = document.getElementById('modalHonourFeedback');
  const fbSec = document.getElementById('modalSecurityFeedback');
  if (fbHonour) fbHonour.textContent = '';
  if (fbSec) fbSec.textContent = '';

  const tbody = document.getElementById('modalMatchesTableBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="12" class="loading-cell">Loading combat sessions…</td></tr>';
  const violationsTbodyPre = document.getElementById('modalViolationsTableBody');
  renderViolationPage?.([], () => {}, id);
  renderAdminMatchPage?.([], () => {}, id);
  if (violationsTbodyPre) violationsTbodyPre.innerHTML = '<tr><td colspan="4" class="loading-cell">Loading violations…</td></tr>';

  if (!modal.open) modal.showModal();

  try {
    const endpoint = view === 'violations'
      ? `/admin/players/${encodeURIComponent(id)}/violations`
      : `/admin/players/${encodeURIComponent(id)}`;
    const resp = await fetch(`${window.API_BASE}${endpoint}`, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) {
      const message = view === 'violations'
        ? `Violations request failed (HTTP ${resp.status})`
        : `Player match request failed (HTTP ${resp.status})`;
      throw new Error(message);
    }
    const data = await resp.json();

    if (!modal.open || activePlayerModalId !== id) return;
    const stats = data.stats || {};
    if (view === 'violations') {
      if (!Array.isArray(data.security_events)) throw new Error('The violations response was incomplete.');
      renderPlayerViolations(data.security_events);
      return;
    }
    const totalM = document.getElementById('modalTotalMatches');
    const totalK = document.getElementById('modalTotalKills');
    const totalD = document.getElementById('modalTotalDeaths');
    const kdrEl = document.getElementById('modalCareerKdr');
    const totalShotsEl = document.getElementById('modalTotalShots');
    const totalHitsEl = document.getElementById('modalTotalHits');
    const accuracyEl = document.getElementById('modalCareerAccuracy');
    const totalHeadshotsEl = document.getElementById('modalTotalHeadshots');
    const headshotsCoverageEl = document.getElementById('modalHeadshotsCoverage');
    const shotsCoverageEl = document.getElementById('modalShotsCoverage');
    const hitsCoverageEl = document.getElementById('modalHitsCoverage');
    const honourEl = document.getElementById('modalHonourScore');
    const honourRankBadge = document.getElementById('modalHonourRankBadge');
    const riskEl = document.getElementById('modalRiskScore');
    const badgeEl = document.getElementById('modalMatchCountBadge');
    const mfaBadge = document.getElementById('modalMfaStatusBadge');
    const standingBadge = document.getElementById('modalAccountStateBadge');

    if (totalM) totalM.textContent = stats.total_matches == null ? '—' : stats.total_matches;
    if (totalK) totalK.textContent = stats.kills == null ? '—' : stats.kills;
    if (totalD) totalD.textContent = stats.deaths == null ? '—' : stats.deaths;
    const careerKdr = stats.kills == null || stats.deaths == null
      ? null
      : Number(stats.deaths) > 0 ? Number(stats.kills) / Number(stats.deaths) : Number(stats.kills);
    if (kdrEl) kdrEl.textContent = careerKdr == null ? '—' : careerKdr.toFixed(2);
    if (totalShotsEl) totalShotsEl.textContent = stats.shots_fired == null ? '—' : Number(stats.shots_fired).toLocaleString();
    if (totalHitsEl) totalHitsEl.textContent = stats.shots_hit == null ? '—' : Number(stats.shots_hit).toLocaleString();
    const careerAccuracy = stats.shots_fired != null && stats.shots_hit != null && Number(stats.shots_fired) > 0
      ? (Number(stats.shots_hit) / Number(stats.shots_fired)) * 100
      : null;
    if (accuracyEl) accuracyEl.textContent = careerAccuracy == null ? '—' : `${careerAccuracy.toFixed(1)}%`;
    const coverage = (status, total) => total == null || status === 'unavailable'
      ? 'Unavailable'
      : status === 'partial' ? 'Partial history' : 'Complete history';
    if (totalHeadshotsEl) totalHeadshotsEl.textContent = stats.headshots == null ? '—' : Number(stats.headshots).toLocaleString();
    if (headshotsCoverageEl) headshotsCoverageEl.textContent = coverage(stats.headshots_coverage, stats.headshots);
    if (shotsCoverageEl) shotsCoverageEl.textContent = coverage(stats.shots_fired_coverage, stats.shots_fired);
    if (hitsCoverageEl) hitsCoverageEl.textContent = coverage(stats.shots_hit_coverage, stats.shots_hit);
    
    const hScore = data.account_info?.honour_score ?? 100;
    if (honourEl) honourEl.textContent = hScore;
    if (honourRankBadge) honourRankBadge.textContent = `${hScore} / 100`;

    if (mfaBadge) {
      const isMfa = data.account_info?.mfa_enabled;
      mfaBadge.textContent = isMfa ? 'MFA: Enabled' : 'MFA: Disabled';
      mfaBadge.style.background = isMfa ? '#EDE9FE' : '#FEE2E2';
      mfaBadge.style.color = isMfa ? '#5B21B6' : '#B91C1C';
    }

    if (standingBadge) {
      const status = data.account_info?.account_status || 'active';
      standingBadge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
      standingBadge.style.background = status === 'active' ? '#DCFCE7' : '#FEE2E2';
      standingBadge.style.color = status === 'active' ? '#15803D' : '#B91C1C';
    }

    const riskVal = stats.risk_score != null ? `${stats.risk_score} (${stats.risk_category || 'Normal'})` : 'Normal';
    if (riskEl) riskEl.textContent = riskVal;

    const matches = data.recent_matches || [];
    if (badgeEl) badgeEl.textContent = `${matches.length} Sessions`;

    if (!tbody) return;
    if (matches.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" class="empty">No completed combat sessions found for this player.</td></tr>';
    } else {
      renderAdminMatchPage(matches, rows => {
        tbody.innerHTML = rows.map(m => {
          const riskScore = m.risk_score != null ? `${Number(m.risk_score).toFixed(1)} / 100` : 'Normal';
          const riskClass = (m.risk_score >= 70) ? 'risk-high' : ((m.risk_score >= 40) ? 'risk-med' : 'risk-low');
          return `
            <tr>
              <td><code style="background:#EDE9FE; color:#5B21B6; padding:2px 8px; border-radius:4px; font-weight:700;">${escapeHtml(m.session_id ? (String(m.session_id).startsWith('#') ? m.session_id : '#' + m.session_id) : '—')}</code></td>
              <td><strong>${escapeHtml(m.game || 'CyberStrike 3D')}</strong></td>
              <td>${formatTimeAgo(m.started_at)}</td>
              <td><strong style="color:#059669;">${m.kills == null ? '—' : m.kills}</strong></td>
              <td><strong style="color:#DC2626;">${m.deaths == null ? '—' : m.deaths}</strong></td>
              <td><span style="font-weight:700; color:#4C1D95;">${m.kdr == null ? '—' : Number(m.kdr).toFixed(2)}</span></td>
              <td>${m.shots_fired == null ? '—' : Number(m.shots_fired).toLocaleString()}</td>
              <td>${m.shots_hit == null ? '—' : Number(m.shots_hit).toLocaleString()}</td>
              <td>${m.headshots == null ? '—' : Number(m.headshots).toLocaleString()}</td>
              <td>${m.accuracy == null ? '—' : `${Number(m.accuracy).toFixed(1)}%`}</td>
              <td><span class="risk-pill ${riskClass}">${riskScore}</span></td>
              <td><span class="badge badge-success">${escapeHtml(m.status || 'completed')}</span></td>
            </tr>
          `;
        }).join('');
      }, id);
    }

    renderPlayerViolations(data.security_events);
  } catch (err) {
    if (view === 'violations') {
      const violationsTbody = document.getElementById('modalViolationsTableBody');
      const badge = document.getElementById('modalViolationsCountBadge');
      if (violationsTbody) violationsTbody.innerHTML = `<tr><td colspan="4" class="error-cell">Unable to load violations: ${escapeHtml(err.message || 'Request failed')}</td></tr>`;
      if (badge) {
        badge.textContent = 'Unavailable';
        badge.className = 'badge badge-warning';
      }
      return;
    }
    if (tbody) tbody.innerHTML = `<tr><td colspan="12" class="error-cell">Error: ${escapeHtml(err.message)}</td></tr>`;
    const violationsTbody = document.getElementById('modalViolationsTableBody');
    if (violationsTbody) violationsTbody.innerHTML = '<tr><td colspan="4" class="error-cell">Could not load violations.</td></tr>';
    ['modalTotalMatches','modalTotalKills','modalTotalDeaths','modalCareerKdr','modalTotalShots','modalTotalHits','modalCareerAccuracy','modalTotalHeadshots','modalHonourScore','modalRiskScore'].forEach(metricId => {
      const metric = document.getElementById(metricId);
      if (metric) metric.textContent = 'Unavailable';
    });
  }
}

// Super Admin threat monitoring can be initialized independently of the player
// table. Keep a module-level event entry point so its dynamically rendered
// violation buttons never silently depend on initPlayersSection() having run.
window.addEventListener('securefps:open-player-inspection', (event) => {
  const { id, name, email, view } = event.detail || {};
  if (!id) return;
  openPlayerMatchesModal(id, name, email, view === 'violations' ? 'violations' : 'player');
});

function handleDelete(id, name) {
  if (!window.isSuperAdmin) {
    openRequestApprovalModal(id, name, 'delete');
    return;
  }
  promptAdminAction({
    title: `Soft-Delete Account: ${name}`,
    message: 'Soft delete marks account as deleted, revokes sessions, and anonymizes personal identifiable information (PII). Match, honour, and reward records are retained for auditing.',
    actionLabel: 'Soft Delete Account',
    isDestructive: true,
    requireReason: true,
    requireReauth: true,
    onConfirm: async (payload) => {
      const resp = await fetch(`/api/admin/players/${id}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) {
        if (data.can_request_approval) {
          openRequestApprovalModal(id, name, 'delete');
          return;
        }
        throw new Error(data.message || 'Delete failed');
      }
      await loadPlayersTable();
    }
  });
}

function setupBulkActions() {
  const selectAll = document.getElementById('selectAllPlayers');
  if (selectAll) {
    selectAll.addEventListener('change', (e) => {
      const allCbs = document.querySelectorAll('.player-select-cb');
      allCbs.forEach(cb => {
        cb.checked = e.target.checked;
        const id = cb.dataset.id;
        if (e.target.checked) selectedPlayerIds.add(id);
        else selectedPlayerIds.delete(id);
      });
      updateBulkToolbar();
    });
  }

  const bulkSuspendBtn = document.getElementById('bulkSuspendBtn');
  if (bulkSuspendBtn) {
    bulkSuspendBtn.addEventListener('click', () => runBulkAction('suspend'));
  }

  const bulkBanBtn = document.getElementById('bulkBanBtn');
  if (bulkBanBtn) {
    bulkBanBtn.addEventListener('click', () => runBulkAction('ban'));
  }

  const bulkUnsuspendBtn = document.getElementById('bulkUnsuspendBtn');
  if (bulkUnsuspendBtn) {
    bulkUnsuspendBtn.addEventListener('click', () => runBulkAction('unsuspend'));
  }
}

function updateBulkToolbar() {
  const toolbar = document.getElementById('bulkActionsToolbar');
  const countSpan = document.getElementById('selectedPlayersCount');
  if (!toolbar) return;

  const isSuper = Boolean(window.isSuperAdmin || (window.currentAdmin && window.currentAdmin.is_super_admin));
  const count = selectedPlayerIds.size;
  if (countSpan) countSpan.textContent = count;
  
  if (!isSuper || count === 0) {
    toolbar.hidden = true;
    toolbar.style.display = 'none';
  } else {
    toolbar.hidden = false;
    toolbar.style.display = 'flex';
  }
}

function runBulkAction(action) {
  const count = selectedPlayerIds.size;
  if (count === 0) return;

  promptAdminAction({
    title: `Bulk ${action.toUpperCase()} (${count} players)`,
    message: `Apply ${action} to ${count} selected player accounts. Requires reason (min 10 characters).`,
    actionLabel: `Confirm Bulk ${action}`,
    isDestructive: action === 'ban',
    requireReason: true,
    requireReauth: action === 'ban',
    onConfirm: async (payload) => {
      const body = {
        action,
        player_ids: Array.from(selectedPlayerIds),
        reason: payload.reason,
        reauth_password: payload.reauth_password,
        mfa_code: payload.mfa_code
      };
      const resp = await fetch('/api/admin/players/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Bulk action failed');
      selectedPlayerIds.clear();
      updateBulkToolbar();
      await loadPlayersTable();
    }
  });
}

function renderPagination(container, total) {
  if (!container) return;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  const current = currentPlayersPage;

  container.innerHTML = `
    <div class="pagination-info">Page ${current + 1} of ${totalPages} (${total} total players)</div>
    <div class="pagination-buttons">
      <button class="ghost-btn" id="prevPlayersPage" ${current === 0 ? 'disabled' : ''}>Previous</button>
      <button class="ghost-btn" id="nextPlayersPage" ${current >= totalPages - 1 ? 'disabled' : ''}>Next</button>
    </div>
  `;

  const prev = container.querySelector('#prevPlayersPage');
  const next = container.querySelector('#nextPlayersPage');
  if (prev) {
    prev.onclick = () => {
      if (currentPlayersPage > 0) {
        currentPlayersPage--;
        loadPlayersTable();
      }
    };
  }
  if (next) {
    next.onclick = () => {
      if (currentPlayersPage < totalPages - 1) {
        currentPlayersPage++;
        loadPlayersTable();
      }
    };
  }
}
