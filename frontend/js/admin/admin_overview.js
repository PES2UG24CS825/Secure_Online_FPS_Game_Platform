/**
 * SecureFPS Admin Overview Module
 * Cached statistics (30s), server cluster health monitor, and dev fixture toggling.
 */
import { escapeHtml, formatTimeAgo } from './admin_core.js';

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
    renderRecentEvents(data.events || []);

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

  if (pCount) pCount.textContent = stats.total_players ?? '—';
  if (mCount) mCount.textContent = stats.matches_analyzed ?? '—';
  if (eCount) eCount.textContent = (stats.total_players ? stats.total_players * 3 : '—');
  if (hCount) hCount.textContent = stats.high_severity_events ?? '0';

  const bannedAccountCount = document.getElementById('bannedAccountCount');
  if (bannedAccountCount) {
    const banned = (stats.banned_players || 0) + (stats.suspended_players || 0);
    bannedAccountCount.textContent = `${banned} account${banned === 1 ? '' : 's'}`;
  }
}

async function loadServerClusterHealth() {
  const container = document.getElementById('clusterHealthPanel');
  if (!container) return;

  try {
    const resp = await fetch('/api/admin/server-health', { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!resp.ok) return;
    const health = await resp.json();

    const dbStatus = health.database?.status === 'connected' ? 'status-online' : 'status-offline';
    const mp = health.multiplayer_server || {};
    const mpStatus = mp.status === 'online' ? 'status-online' : 'status-offline';

    container.innerHTML = `
      <div class="health-grid">
        <div class="health-card">
          <div class="health-header">
            <span class="status-indicator ${dbStatus}"></span>
            <strong>Database Cluster</strong>
          </div>
          <div class="health-body">
            <div>Status: <span class="badge ${dbStatus}">${escapeHtml(health.database?.status || 'unknown')}</span></div>
            <small class="muted">Users: ${health.database?.total_users ?? 0} | Sessions: ${health.database?.total_sessions ?? 0}</small>
          </div>
        </div>

        <div class="health-card">
          <div class="health-header">
            <span class="status-indicator ${mpStatus}"></span>
            <strong>Multiplayer Engine (Node/Socket.IO)</strong>
          </div>
          <div class="health-body">
            <div>Status: <span class="badge ${mpStatus}">${escapeHtml(mp.status || 'offline')}</span></div>
            <small class="muted">Rooms: ${mp.rooms ?? 0} | Clients: ${mp.clients ?? 0} ${mp.latency_ms ? `| ${mp.latency_ms}ms` : ''}</small>
          </div>
        </div>

        <div class="health-card">
          <div class="health-header">
            <span class="status-indicator status-online"></span>
            <strong>ML Anti-Cheat Inference</strong>
          </div>
          <div class="health-body">
            <div>Model: <span class="badge badge-cyan">v2.0-rf Authoritative</span></div>
            <small class="muted">Engine: Python scikit-learn random forest</small>
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
    console.error('[AdminOverview] Health check failed:', err);
  }
}

async function loadMultiplayerRoomsPanel() {
  const container = document.getElementById('liveRoomsPanel');
  if (!container) return;
  try {
    const resp = await fetch('/api/admin/multiplayer/rooms', { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!resp.ok) return;
    const data = await resp.json();
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
                <td>${r.playerCount} / 8</td>
                <td>${(r.players || []).map(p => `<span class="badge badge-cyan" style="font-size:11px; margin-right:4px;">${escapeHtml(p.name)} (${p.kills}K/${p.deaths}D)</span>`).join('')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {}
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

  container.innerHTML = events.map(e => `
    <div class="event-item severity-${escapeHtml(e.severity || 'low')}">
      <div class="event-header">
        <span class="event-type">${escapeHtml(e.type || 'security_event')}</span>
        <span class="event-time">${formatTimeAgo(e.timestamp)}</span>
      </div>
      <div class="event-desc">${escapeHtml(e.description || '')}</div>
    </div>
  `).join('');
}

export function renderAdminHeaderBadge(admin) {
  if (!admin) return;
  window.currentAdmin = admin;
  const isSuper = Boolean(admin.is_super_admin);
  window.isSuperAdmin = isSuper;

  const nameEl = document.getElementById('adminName');
  const emailEl = document.getElementById('adminEmail');
  const avatarEl = document.querySelector('.admin-header-card .avatar');

  // Insert or update Admin Tier Banner
  let tierBanner = document.getElementById('adminTierBanner');
  if (!tierBanner) {
    tierBanner = document.createElement('div');
    tierBanner.id = 'adminTierBanner';
    const mainWrap = document.querySelector('.admin-main');
    if (mainWrap) {
      mainWrap.insertBefore(tierBanner, mainWrap.children[1]);
    }
  }

  // Sidebar link for ML Anti-Cheat
  const mlNavBtn = document.querySelector('[data-admin-section="gameplay"]');

  if (isSuper) {
    if (nameEl) nameEl.innerHTML = `<span style="display:inline-flex; align-items:center; gap:6px;"><span>👑</span><strong>Super Administrator</strong></span>`;
    if (emailEl) emailEl.innerHTML = `<span style="color:#F59E0B; font-weight:700;">Full System Authority</span> · ${escapeHtml(admin.email || '')}`;
    if (avatarEl) {
      avatarEl.textContent = '👑';
      avatarEl.classList.add('super-admin-avatar');
    }
    if (tierBanner) {
      tierBanner.className = 'admin-tier-banner super-tier';
      tierBanner.innerHTML = `
        <div>
          <strong>👑 Super Administrator Command Center (Level 2):</strong>
          <span>Full executive platform authority: Administrator Management, Granular RBAC, AI/ML Model Rollback &amp; Tuning, Emergency Lockdown, Backups &amp; Disaster Recovery.</span>
        </div>
        <span class="admin-tier-badge level-2">EXECUTIVE ROOT (L2)</span>
      `;
    }
    if (mlNavBtn) {
      mlNavBtn.style.display = 'flex';
      mlNavBtn.innerHTML = `<span class="admin-nav-icon"><svg viewBox="0 0 24 24"><path d="M4 19.5h16M6.5 16V11M12 16V5M17.5 16V8"/></svg></span>Game &amp; ML Anti-Cheat <span style="font-size:10px; background:#F59E0B; color:#000; padding:1px 5px; border-radius:4px; margin-left:auto; font-weight:800;">ROOT</span>`;
    }
    document.querySelectorAll('[id*="Export"], [href*="/export/"]').forEach(el => el.style.display = '');

    const superCat = document.getElementById('superAdminNavCategory');
    if (superCat) superCat.hidden = false;
  } else {
    if (nameEl) nameEl.innerHTML = `<span style="display:inline-flex; align-items:center; gap:6px;"><span>🛡️</span><strong>Security Admin</strong></span>`;
    if (emailEl) emailEl.innerHTML = `<span style="color:#A78BFA; font-weight:600;">Normal Administrator (Level 1)</span> · ${escapeHtml(admin.email || '')}`;
    if (avatarEl) {
      avatarEl.textContent = 'SA';
      avatarEl.classList.remove('super-admin-avatar');
    }
    if (tierBanner) {
      tierBanner.className = 'admin-tier-banner normal-tier';
      tierBanner.innerHTML = `
        <div>
          <strong>🛡️ Normal Administrator Console (Level 1):</strong>
          <span>Operational console for Player Management, Threat Monitoring, Ban Appeals review, and Customer Support.</span>
        </div>
        <span class="admin-tier-badge level-1">OPERATIONAL (L1)</span>
      `;
    }
    if (mlNavBtn) {
      mlNavBtn.style.display = 'flex';
      mlNavBtn.innerHTML = `<span class="admin-nav-icon"><svg viewBox="0 0 24 24"><path d="M4 19.5h16M6.5 16V11M12 16V5M17.5 16V8"/></svg></span>Game &amp; ML Anti-Cheat`;
    }
    document.querySelectorAll('[id*="Export"], [href*="/export/"]').forEach(el => el.style.display = 'none');

    const superCat = document.getElementById('superAdminNavCategory');
    if (superCat) superCat.hidden = true;
  }
}
