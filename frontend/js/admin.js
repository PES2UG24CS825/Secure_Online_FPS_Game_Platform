/**
 * SecureFPS Admin Dashboard Coordinator
 * Coordinates section modules, tab navigation, responsive polling, and manual refresh.
 */
import { PollingManager, connectAdminLiveEvents, escapeHtml, formatTimeAgo } from './admin/admin_core.js';
import { loadAdminOverview } from './admin/admin_overview.js';
import { initPlayersSection, loadPlayersTable } from './admin/admin_players.js';
import { initSecuritySection, loadBanAppeals, loadAntiCheatDecisions, loadAuditLogTable } from './admin/admin_security.js';
import { initSupportSection, loadSupportTickets } from './admin/admin_support.js';

let activeSection = 'overview';

async function initAdminApp() {
  setupNavigation();
  setupHeaderControls();

  // Load initial view
  await loadAdminOverview();

  // Initialize modular sections
  initPlayersSection();
  initSecuritySection();
  initSupportSection();

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
    case 'gameplay':
      title.textContent = 'Game & ML Anti-Cheat';
      if (sub) sub.textContent = 'Model inference performance, top telemetry features, and match logs.';
      break;
    case 'support':
      title.textContent = 'Customer Support';
      if (sub) sub.textContent = 'Answer player tickets, view attachments, and use reply macros.';
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
      await Promise.all([loadBanAppeals(), loadAuditLogTable()]);
      break;
    case 'gameplay':
      await loadAntiCheatDecisions();
      break;
    case 'support':
      await loadSupportTickets();
      break;
  }
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdminApp);
} else {
  initAdminApp();
}
