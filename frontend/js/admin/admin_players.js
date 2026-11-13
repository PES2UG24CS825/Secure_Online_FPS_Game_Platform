/**
 * SecureFPS Admin Players Module
 * Server-side pagination, sorting, search, bulk actions, soft delete, and CSV export.
 */
import { escapeHtml, formatTimeAgo, promptAdminAction } from './admin_core.js';

let currentPlayersPage = 0;
const PAGE_SIZE = 15;
let currentSearch = '';
let currentStatusFilter = '';
let currentSortBy = 'created_at';
let currentSortDir = 'desc';
let selectedPlayerIds = new Set();

export async function initPlayersSection() {
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

  setupBulkActions();
  await loadPlayersTable();
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
    const isChecked = selectedPlayerIds.has(p.id);
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
      <tr data-player-id="${escapeHtml(p.id)}" class="${isChecked ? 'row-selected' : ''}">
        <td><input type="checkbox" class="player-select-cb" data-id="${escapeHtml(p.id)}" ${isChecked ? 'checked' : ''}></td>
        <td>
          <div class="player-cell">
            <strong>${escapeHtml(p.name)}</strong>
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
          ${status === 'active' ? `
            <button class="action-btn suspend-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">Suspend</button>
            <button class="action-btn ban-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">Ban</button>
          ` : (status === 'suspended' ? `
            <button class="action-btn unsuspend-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">Unsuspend</button>
            <button class="action-btn ban-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">Ban</button>
          ` : (status === 'banned' ? `
            <button class="action-btn unban-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">Unban</button>
          ` : ''))}
          ${status !== 'deleted' ? (
            isSuper
              ? `<button class="action-btn delete-btn" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" title="Soft delete (anonymize PII)">Soft Delete</button>`
              : `<span class="badge" style="font-size:10px; background:rgba(148,163,184,0.15); color:#64748B; cursor:not-allowed;" title="Account deletion requires Super Administrator access">🔒 Super Admin</span>`
          ) : ''}
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
      if (!resp.ok) throw new Error(data.message || 'Ban failed');
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

function handleDelete(id, name) {
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
      if (!resp.ok) throw new Error(data.message || 'Delete failed');
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

  const count = selectedPlayerIds.size;
  if (countSpan) countSpan.textContent = count;
  toolbar.hidden = count === 0;
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
