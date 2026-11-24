import { openPlayerMatchesModal } from "./admin_players.js";
/**
 * SecureFPS Admin Overview Module
 * Cached statistics (30s), server cluster health monitor, and dev fixture toggling.
 */
import { escapeHtml, formatTimeAgo, incidentLabel, PollingManager } from './admin_core.js';

export async function loadAdminOverview(forceRefresh = false) {
  try {
    const url = forceRefresh ? '/api/admin/overview?refresh=1' : '/api/admin/overview';
    const resp = await fetch(url, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        window.location.replace('login.html?next=admin.html');
        return false;
      }
      throw new Error(`Overview fetch failed: ${resp.status}`);
    }
    const data = await resp.json();
    if (data.admin) renderAdminHeaderBadge(data.admin);
    renderOverviewStats(data.stats || {});
    renderRecentMatches(data.matches || []);
    const unresolved = document.getElementById('unresolvedCritical');
    if (unresolved) {
      const count = data.stats?.unresolved_critical;
      unresolved.textContent = count == null ? 'Critical alert count unavailable' : `${count} unresolved critical`;
      unresolved.classList.toggle('badge-danger', count > 0);
    }
    renderRecentEvents(data.events || []);
    PollingManager.updateLastUpdatedDisplay();

    // Check cluster health
    await loadServerClusterHealth();
    await loadMultiplayerRoomsPanel();
    return true;
  } catch (err) {
    console.error('[AdminOverview] Error loading overview:', err);
    return false;
  }
}

function renderOverviewStats(stats) {
  const pCount = document.getElementById('playerCount');
  const mCount = document.getElementById('matchCount');
  const eCount = document.getElementById('eventCount');
  const hCount = document.getElementById('highCount');

  if (pCount) pCount.textContent = stats.total_players ?? 0;
  if (mCount) mCount.textContent = stats.matches_analyzed ?? 0;
  if (eCount) eCount.textContent = stats.total_security_events ?? '—';
  if (hCount) hCount.textContent = stats.high_severity_events ?? '0';

  for (const [id, field] of Object.entries({
    activePlayerCount: 'active_players',
    activeSessionCount: 'active_sessions',
    pendingAppealCount: 'pending_appeals',
  })) {
    const node = document.getElementById(id);
    if (node) node.textContent = stats[field] ?? '—';
  }
}

async function loadServerClusterHealth() {
  const container = document.getElementById('clusterHealthPanel');
  if (!container) return;

  try {
    const resp = await fetch(`${window.API_BASE}/admin/server-health`, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!resp.ok) throw new Error('Service check failed');
    const health = await resp.json();

    const dbConnected = health.database?.status === 'connected';
    const mp = health.multiplayer_server || {};
    const mpOnline = mp.status === 'online';
    const ml = health.ml || {};

    container.innerHTML = `
      <div class="health-grid">
        <div class="health-card">
          <div class="health-header">
            <span class="live-pulse-dot"></span>
            <strong>Database Cluster</strong>
          </div>
          <div class="health-body">
            <div style="display:flex; align-items:center; gap:6px;">Status: <span class="live-status-pill ${dbConnected ? 'connected' : 'offline'}">${dbConnected ? 'CONNECTED' : 'DISCONNECTED'}</span></div>
            <small class="muted">Users: ${health.database?.total_users ?? '—'} | Sessions: ${health.database?.total_sessions ?? '—'}</small>
          </div>
        </div>

        <div class="health-card">
          <div class="health-header">
            <span class="live-pulse-dot"></span>
            <strong>Multiplayer Engine (Node/Socket.IO)</strong>
          </div>
          <div class="health-body">
            <div style="display:flex; align-items:center; gap:6px;">Status: <span class="live-status-pill ${mpOnline ? 'online' : 'offline'}">${mpOnline ? 'ONLINE' : 'OFFLINE'}</span></div>
            <small class="muted">Rooms: ${mp.rooms ?? '—'} | Clients: ${mp.clients ?? '—'} ${mp.latency_ms ? `| ${mp.latency_ms}ms` : ''}</small>
          </div>
        </div>

        <div class="health-card">
          <div class="health-header">
            <span class="live-pulse-dot"></span>
            <strong>ML Anti-Cheat Inference</strong>
          </div>
          <div class="health-body">
            <div style="display:flex; align-items:center; gap:6px;">Status: <span class="live-status-pill ${ml.status === 'operational' ? 'operational' : 'offline'}">${escapeHtml((ml.status || 'unavailable').toUpperCase())}</span></div>
            <small class="muted">${escapeHtml(ml.model_version || 'Model version unavailable')}</small>
          </div>
        </div>
      </div>
    `;

    // Item 8: Hide hacker demo controls unless demo mode is enabled
    const demoControls = document.getElementById('hackerDemoControls');
    const demoPanel = document.getElementById('hackerAccountsPanel');
    const demoBanner = document.getElementById('demoComparisonBanner');

    const demoEnabled = Boolean(health.demo_mode_enabled);
    if (demoControls) demoControls.hidden = !demoEnabled;
    if (demoPanel) demoPanel.hidden = !demoEnabled;
    if (demoBanner) demoBanner.hidden = !demoEnabled;
  } catch (err) {
    container.textContent = 'Service health unavailable. The dashboard will retry automatically.';
    console.error('[AdminOverview] Health check failed:', err);
  }
}

async function loadMultiplayerRoomsPanel() {
  const container = document.getElementById('liveRoomsPanel');
  if (!container) return;
  try {
    const resp = await fetch('/api/admin/multiplayer/rooms', { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!resp.ok) throw new Error('Room status unavailable');
    const data = await resp.json();
    if (data.status === 'offline') throw new Error('Multiplayer server offline');
    const rooms = data.rooms || [];
    if (rooms.length === 0) {
      container.innerHTML = '<div class="empty">No active multiplayer rooms currently running.</div>';
      return;
    }
    container.innerHTML = `
      <div class="admin-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Room Code</th>
              <th>State</th>
              <th>Host</th>
              <th>Players</th>
              <th>Active Operators</th>
            </tr>
          </thead>
          <tbody>
            ${rooms.map(r => `
              <tr>
                <td><code>${escapeHtml(r.roomCode)}</code></td>
                <td><span class="badge ${r.state === 'in_game' ? 'badge-success' : 'badge-cyan'}">${escapeHtml(r.state)}</span></td>
                <td>${escapeHtml(r.hostName || 'Operator')}</td>
                <td>${escapeHtml(r.playerCount)} / ${escapeHtml(r.maxPlayers ?? '—')}</td>
                <td>${(r.players || []).map(p => `<span class="badge badge-cyan" style="font-size:11px; margin-right:4px;">${escapeHtml(p.name)} (${escapeHtml(p.kills)}K/${escapeHtml(p.deaths)}D)</span>`).join('')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    container.innerHTML = '<div class="empty">Multiplayer room status unavailable.</div>';
  }
}

function renderRecentMatches(matches) {
  const tbody = document.getElementById('allMatches');
  if (!tbody) return;
  if (!matches || matches.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No recent game sessions recorded.</td></tr>';
    return;
  }

  tbody.innerHTML = matches.map(m => {
    const risk = m.risk_score !== null && m.risk_score !== undefined ? m.risk_score : '—';
    const riskClass = (m.risk_score >= 70) ? 'risk-high' : ((m.risk_score >= 40) ? 'risk-med' : 'risk-low');
    return `
      <tr>
        <td><code>${escapeHtml(m.session_id ? m.session_id.substring(0, 8) : '—')}</code></td>
        <td><strong>${escapeHtml(m.player_name || 'Operator')}</strong></td>
        <td>${escapeHtml(m.game || 'CyberStrike 3D')}</td>
        <td>${formatTimeAgo(m.started_at)}</td>
        <td><span class="badge">${escapeHtml(m.status || 'completed')}</span></td>
        <td><span class="risk-pill ${riskClass}">${escapeHtml(risk)} (${escapeHtml(m.risk_category || 'Normal')})</span></td>
      </tr>
    `;
  }).join('');
}

function renderRecentEvents(events) {
  const container = document.getElementById('events');
  if (!container) return;
  if (!events || events.length === 0) {
    container.innerHTML = '<div class="empty">No security events.</div>';
    return;
  }

  container.innerHTML = `<div class="admin-table-wrap"><table>
    <thead><tr><th>Incident</th><th>Player</th><th>Severity</th><th>Time</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${events.map(e => `
      <tr>
        <td><details><summary>${escapeHtml(incidentLabel(e.type))}</summary>${escapeHtml(e.description || 'No additional detail.')}</details></td>
        <td>${escapeHtml(e.player_name || '—')}</td>
        <td><span class="badge ${e.severity === 'critical' ? 'badge-danger' : ''}">${escapeHtml(e.severity || 'Unknown')}</span></td>
        <td><time>${formatTimeAgo(e.timestamp)}</time></td>
        <td>${escapeHtml(e.acknowledged && e.status === 'open' ? 'Acknowledged' : incidentLabel(e.status))}</td>
        <td><div class="event-actions">
          ${e.player_id ? `<button type="button" class="ghost-btn" data-investigate="${escapeHtml(e.player_id)}" data-name="${escapeHtml(e.player_name || 'Player')}">Investigate</button>` : ''}
          ${e.severity === 'critical' && !e.acknowledged && !['closed', 'resolved'].includes(e.status) ? `<button type="button" class="ghost-btn" data-acknowledge="${escapeHtml(e.id)}">Acknowledge</button>` : ''}
        </div></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  container.querySelectorAll('[data-investigate]').forEach(button => {
    button.onclick = () => openPlayerMatchesModal(button.dataset.investigate, button.dataset.name, '');
  });
  container.querySelectorAll('[data-acknowledge]').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(`/admin/security-events/${encodeURIComponent(button.dataset.acknowledge)}/acknowledge`, { method: 'POST' });
        await loadAdminOverview(true);
      } catch (error) {
        window.showAppAlert(error.message);
        button.disabled = false;
      }
    };
  });
}

export function renderAdminHeaderBadge(admin) {
  if (!admin) return;
  window.currentAdmin = admin;
  const isSuper = Boolean(admin.is_super_admin);
  window.isSuperAdmin = isSuper;
  document.body.dataset.adminRole = isSuper ? 'super' : 'normal';

  const nameEl = document.getElementById('adminName');
  const emailEl = document.getElementById('adminEmail');
  const avatarEl = document.querySelector('.admin-header-card .avatar');
  const roleBadgeEl = document.getElementById('adminRoleBadge');

  if (nameEl) nameEl.textContent = isSuper ? 'Super administrator' : 'Administrator';
  if (emailEl) emailEl.textContent = [admin.name, admin.email].filter(Boolean).join(' · ');
  if (avatarEl) avatarEl.textContent = isSuper ? 'SA' : 'AD';
  if (roleBadgeEl) {
    roleBadgeEl.textContent = isSuper ? 'Super Admin · L2' : 'Normal Admin · L1';
    roleBadgeEl.dataset.role = isSuper ? 'super' : 'normal';
  }
  const superCat = document.getElementById('superAdminNavCategory');
  if (superCat) superCat.hidden = !isSuper;

  if (isSuper) {
    // Check approvals queue count
    fetch('/api/admin/approvals?status=pending', { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        const pCount = d.pending_count || 0;
        const navBadge = document.getElementById('navApprovalBadge');
        const badge = document.getElementById('approvalPendingBadge');
        if (navBadge) {
          navBadge.textContent = pCount;
          navBadge.style.display = pCount > 0 ? 'inline-block' : 'none';
        }
        if (badge) badge.textContent = pCount;
      })
      .catch(() => {});
  }
}
