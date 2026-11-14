/**
 * SecureFPS Admin Dashboard Coordinator
 * Coordinates section modules, tab navigation, responsive polling, and manual refresh.
 */
import { PollingManager, connectAdminLiveEvents, escapeHtml, formatTimeAgo } from './admin/admin_core.js';
import { loadAdminOverview } from './admin/admin_overview.js';
import { initPlayersSection, loadPlayersTable } from './admin/admin_players.js';
import { initSecuritySection, loadBanAppeals, loadAntiCheatDecisions, loadAuditLogTable, loadRecentLoginsTable } from './admin/admin_security.js';
import { initSupportSection, loadSupportTickets } from './admin/admin_support.js';
import {
  initSuperAdminModules, loadSuperAdmins, loadRolesPermissions, loadMlModelsCatalog,
  loadRiskConfig, loadSecurityCommand, loadSystemControlMetrics, loadSystemBackups,
  loadPlatformConfig, loadThreatMonitoring, loadReportsAnalytics, loadApprovalsQueue
} from './admin/admin_super.js';

let activeSection = 'overview';

async function initAdminApp() {
  setupNavigation();
  setupHeaderControls();

  // Load initial view - will redirect to login if session is expired or unauthenticated
  const ok = await loadAdminOverview();
  if (!ok) return;

  // Initialize modular sections
  initPlayersSection();
  initSecuritySection();
  initSupportSection();
  initSuperAdminModules();

  // Connect Primary Real-Time SSE Stream with Fallback Polling
  connectAdminLiveEvents();
  PollingManager.subscribe(() => {
    refreshCurrentSection();
  });
  PollingManager.start();
}

function setupNavigation() {
  const navBtns = document.querySelectorAll('.admin-nav-btn');
  const sections = document.querySelectorAll('.admin-section');

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.adminSection;
      if (!target) return;

      navBtns.forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });

      sections.forEach(s => {
        s.classList.toggle('active', s.dataset.adminView === target);
      });

      activeSection = target;
      updatePageTitle(target);
      refreshCurrentSection();
    });
  });
}

function updatePageTitle(section) {
  const title = document.getElementById('adminPageTitle');
  const sub = document.getElementById('adminPageSubtitle');
  if (!title) return;

  switch (section) {
    case 'overview':
      title.textContent = 'Admin overview';
      if (sub) sub.textContent = 'Live platform activity, cluster health and security alerts.';
      break;
    case 'players':
      title.textContent = 'Player Accounts';
      if (sub) sub.textContent = 'Manage player access, soft delete accounts, and inspect risk scores.';
      break;
    case 'security':
      title.textContent = 'Security & Ban Appeals';
      if (sub) sub.textContent = 'Review player ban appeals, audit enforcement logs, and logins.';
      break;
    case 'threats':
      title.textContent = 'Threat Monitoring';
      if (sub) sub.textContent = 'Active threats, suspicious logins, and repeated player violations.';
      break;
    case 'analytics':
      title.textContent = 'Reports & Platform Analytics';
      if (sub) sub.textContent = 'Sanction trends, detection accuracy, and false-positive statistics.';
      break;
    case 'gameplay':
      title.textContent = 'Game & ML Anti-Cheat';
      if (sub) sub.textContent = 'Model inference performance, top telemetry features, and match logs.';
      break;
    case 'support':
      title.textContent = 'Customer Support';
      if (sub) sub.textContent = 'Answer player tickets, view attachments, and use reply macros.';
      break;
    case 'super_admins':
      title.textContent = '👑 Administrator Management';
      if (sub) sub.textContent = 'Provision Normal Admins, edit profiles, revoke sessions, and manage credentials.';
      break;
    case 'super_roles':
      title.textContent = '👑 Role & Permission Management';
      if (sub) sub.textContent = 'Centralized permission matrix and route-level authorization control.';
      break;
    case 'super_ml':
      title.textContent = '👑 AI & ML Detection Management';
      if (sub) sub.textContent = 'Model accuracy, precision, recall, threshold tuning, and instant rollback.';
      break;
    case 'super_risk':
      title.textContent = '👑 Risk Engine Configuration';
      if (sub) sub.textContent = 'Category boundaries, automated enforcement rules, and Interactive Simulator.';
      break;
    case 'super_command':
      title.textContent = '👑 Global Security Command';
      if (sub) sub.textContent = 'Real-time platform threat overview and Emergency Lockdown controls.';
      break;
    case 'super_control':
      title.textContent = '👑 System Control Center';
      if (sub) sub.textContent = 'Runtime metrics, database cluster health, API throughput, and latency.';
      break;
    case 'super_backups':
      title.textContent = '👑 Backup & Disaster Recovery';
      if (sub) sub.textContent = 'Verified recovery points, rolling retention, and on-demand snapshots.';
      break;
    case 'super_config':
      title.textContent = '👑 Platform Configuration';
      if (sub) sub.textContent = 'Authentication limits, session timeouts, and platform maintenance mode.';
      break;
  }
}

function setupHeaderControls() {
  const manualRefresh = document.getElementById('manualRefreshBtn');
  if (manualRefresh) {
    manualRefresh.addEventListener('click', async () => {
      manualRefresh.disabled = true;
      manualRefresh.textContent = 'Refreshing…';
      try {
        await refreshCurrentSection(true);
      } finally {
        manualRefresh.disabled = false;
        manualRefresh.textContent = '↻ Refresh';
      }
    });
  }

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      } catch (err) {}
      window.location.href = 'login.html';
    });
  }

  const playerViewBtn = document.getElementById('playerViewBtn');
  if (playerViewBtn) {
    playerViewBtn.addEventListener('click', () => {
      window.location.href = '/player.html';
    });
  }

  // Hook up section refresh buttons
  document.getElementById('refreshAdminBtn')?.addEventListener('click', () => loadAdminOverview(true));
  document.getElementById('refreshPlayersBtn')?.addEventListener('click', () => loadPlayersTable());
  document.getElementById('refreshSupportInbox')?.addEventListener('click', () => loadSupportTickets());
}

async function refreshCurrentSection(force = false) {
  switch (activeSection) {
    case 'overview':
      await loadAdminOverview(force);
      break;
    case 'players':
      await loadPlayersTable();
      break;
    case 'security':
      await Promise.all([loadBanAppeals(), loadAuditLogTable(), loadRecentLoginsTable()]);
      break;
    case 'threats':
      await loadThreatMonitoring();
      break;
    case 'analytics':
      await loadReportsAnalytics();
      break;
    case 'gameplay':
      await loadAntiCheatDecisions();
      break;
    case 'support':
      await loadSupportTickets();
      break;
    case 'approvals':
      await loadApprovalsQueue();
      break;
    case 'super_admins':
      await loadSuperAdmins();
      break;
    case 'super_roles':
      await loadRolesPermissions();
      break;
    case 'super_ml':
      await loadMlModelsCatalog();
      break;
    case 'super_risk':
      await loadRiskConfig();
      break;
    case 'super_command':
      await loadSecurityCommand();
      break;
    case 'super_control':
      await loadSystemControlMetrics();
      break;
    case 'super_backups':
      await loadSystemBackups();
      break;
    case 'super_config':
      await loadPlatformConfig();
      break;
  }
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdminApp);
} else {
  initAdminApp();
}
