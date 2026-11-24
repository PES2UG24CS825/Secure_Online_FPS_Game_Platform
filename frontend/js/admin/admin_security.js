/**
 * SecureFPS Admin Security Module
 * Ban appeals queue, anti-cheat decisions review panel, and audit log viewer.
 */
import { escapeHtml, formatTimeAgo, incidentLabel, promptAdminAction } from './admin_core.js';
import { initCheaterDemoControls, loadCheaterDemoState } from './admin_demo_cheater.js';

let appealsFilter = 'pending';
let auditPage = 0;
let auditRequest = 0;
let auditFilters = new URLSearchParams();
let currentAuditLogins = [];
let currentAuditAccounts = [];
let activeAuditAccount = null;
const AUDIT_PAGE_SIZE = 20;

export async function initSecuritySection() {
  const auditForm = document.getElementById('auditFilters');
  auditForm?.addEventListener('submit', event => {
    event.preventDefault();
    auditFilters = new URLSearchParams(new FormData(auditForm));
    auditPage = 0;
    loadAuditLogTable();
  });
  document.getElementById('auditPrevious')?.addEventListener('click', () => {
    auditPage = Math.max(0, auditPage - 1);
    loadAuditLogTable();
  });
  document.getElementById('auditNext')?.addEventListener('click', () => {
    auditPage += 1;
    loadAuditLogTable();
  });
  const appealsFilterSelect = document.getElementById('appealsStatusFilter');
  if (appealsFilterSelect) {
    appealsFilterSelect.addEventListener('change', (e) => {
      appealsFilter = e.target.value;
      loadBanAppeals();
    });
  }

  const exportAuditBtn = document.getElementById('exportAuditLogBtn');
  if (exportAuditBtn) {
    exportAuditBtn.addEventListener('click', () => {
      window.location.href = '/api/admin/export/audit-log';
    });
  }

  const roleFilterEl = document.getElementById('loginAuditRoleFilter');
  if (roleFilterEl) {
    roleFilterEl.addEventListener('change', () => {
      loadRecentLoginsTable();
    });
  }
  const refreshLoginsBtn = document.getElementById('refreshLoginsBtn');
  if (refreshLoginsBtn) {
    refreshLoginsBtn.addEventListener('click', () => {
      loadRecentLoginsTable();
    });
  }

  initCheaterDemoControls();

  await Promise.all([
    loadBanAppeals(),
    loadAntiCheatDecisions(),
    loadCheaterDemoState(),
    loadAuditLogTable(),
    loadRecentLoginsTable()
  ]);
}

export async function loadBanAppeals() {
  const container = document.getElementById('banAppealsList');
  if (!container) return;

  try {
    const url = appealsFilter ? `/api/admin/appeals?status=${encodeURIComponent(appealsFilter)}` : '/api/admin/appeals';
    const resp = await fetch(url, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!resp.ok) return;

    const data = await resp.json();
    const appeals = data.appeals || [];

    if (appeals.length === 0) {
      container.innerHTML = '<div class="empty">No ban appeals pending review.</div>';
      return;
    }

    container.innerHTML = `
      <div class="admin-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Status</th>
              <th>Ban Reason</th>
              <th>Appeal Statement</th>
              <th>Submitted</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${appeals.map(a => `
              <tr>
                <td>
                  <strong>${escapeHtml(a.player_name)}</strong>
                  <br><small class="muted">${escapeHtml(a.player_email)}</small>
                </td>
                <td><span class="badge ${a.status === 'approved' ? 'badge-success' : (a.status === 'rejected' ? 'badge-danger' : 'badge-warning')}">${escapeHtml(a.status)}</span></td>
                <td><span class="muted">${escapeHtml(a.ban_reason || 'Security violation')}</span></td>
                <td class="appeal-text-cell" title="${escapeHtml(a.appeal_text)}">"${escapeHtml(a.appeal_text)}"</td>
                <td>${formatTimeAgo(a.created_at)}</td>
                <td>
                  ${a.status === 'pending' ? `
                    <button class="play-btn review-appeal-btn" data-id="${escapeHtml(a.id)}" data-player="${escapeHtml(a.player_name)}">Review Appeal</button>
                  ` : `
                    <small class="muted">${escapeHtml(a.reviewed_by || 'Admin')}: ${escapeHtml(a.admin_note || '')}</small>
                  `}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    container.querySelectorAll('.review-appeal-btn').forEach(btn => {
      btn.addEventListener('click', () => openAppealReviewModal(btn.dataset.id, btn.dataset.player));
    });
  } catch (err) {
    console.error('[AdminSecurity] Appeals load error:', err);
  }
}

function openAppealReviewModal(appealId, playerName) {
  let modal = document.getElementById('appealReviewModal');
  if (!modal) {
    modal = document.createElement('dialog');
    modal.id = 'appealReviewModal';
    modal.className = 'admin-action-modal';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <form method="dialog" class="admin-modal-card" novalidate>
      <h3>Review Ban Appeal: ${escapeHtml(playerName)}</h3>
      <p class="muted">Approving will restore player account to active status and send a notification. Rejecting maintains the ban.</p>

      <div class="modal-form-group">
        <label for="appealDecision">Decision <span class="required-star">*</span></label>
        <select id="appealDecision" class="admin-modal-input">
          <option value="approve">Approve Appeal (Restore Account)</option>
          <option value="reject">Reject Appeal (Maintain Ban)</option>
        </select>
      </div>

      <div class="modal-form-group">
        <label for="appealAdminNote">Review Note <span class="required-star">*</span> (minimum 5 characters)</label>
        <textarea id="appealAdminNote" class="admin-modal-textarea" rows="3" placeholder="Provide note explaining why this appeal was approved or rejected..."></textarea>
        <small id="appealNoteErr" class="modal-err-msg" hidden>Review note must be at least 5 characters.</small>
      </div>

      <div class="modal-actions">
        <button type="button" class="ghost-btn" id="cancelAppealBtn">Cancel</button>
        <button type="submit" class="play-btn" id="submitAppealDecisionBtn">Submit Decision</button>
      </div>
    </form>
  `;

  const cancelBtn = modal.querySelector('#cancelAppealBtn');
  const form = modal.querySelector('form');
  const decisionSelect = modal.querySelector('#appealDecision');
  const noteInput = modal.querySelector('#appealAdminNote');
  const noteErr = modal.querySelector('#appealNoteErr');

  cancelBtn.onclick = () => modal.close();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const action = decisionSelect.value;
    const note = (noteInput.value || '').trim();
    if (note.length < 5) {
      noteErr.hidden = false;
      return;
    }
    noteErr.hidden = true;
    modal.close();

    try {
      const resp = await fetch(`/api/admin/appeals/${appealId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
        body: JSON.stringify({ action, note })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Appeal decision failed');
      await loadBanAppeals();
    } catch (err) {
      console.error('[AdminSecurity] Appeal action failed:', err);
      window.showAppAlert(`Decision failed: ${err.message}`, { tone: "error" });
    }
  };

  modal.showModal();
}

export async function loadAntiCheatDecisions() {
  const container = document.getElementById('antiCheatDecisionsPanel');
  if (!container) return;

  try {
    const resp = await fetch('/api/admin/anticheat/decisions', { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!resp.ok) return;

    const data = await resp.json();
    const meta = data.model_metadata || {};
    const topFeats = meta.top_features || [];
    const flagged = data.flagged_sessions || [];

    container.innerHTML = `
      <div class="anticheat-meta-card">
        <div class="meta-row">
          <div>
            <strong>Inference Model:</strong> <span class="badge badge-cyan">${escapeHtml(meta.version || 'Unavailable')}</span>
            <small class="muted" style="margin-left:8px;">Trained: ${escapeHtml(meta.trained_at ? formatTimeAgo(meta.trained_at) : 'Unavailable')}</small>
          </div>
          <div>
            <strong>Evaluation accuracy</strong> <span>${Number.isFinite(meta.accuracy) ? (meta.accuracy * 100).toFixed(1) + "%" : "Unavailable"}</span><small class="muted"> ${escapeHtml(meta.evaluation_basis || "")}</small>
          </div>
        </div>
        <div class="top-features-wrap">
          <strong>Random Forest impurity-based feature importance</strong>
          <div class="feature-bar-list">
            ${topFeats.slice(0, 8).map(f => `
              <div class="feature-bar-item">
                <div class="feat-name">${escapeHtml(f.name)}</div>
                <div class="feat-track"><div class="feat-fill" style="width:${Math.round(f.importance * 100)}%"></div></div>
                <div class="feat-val">${Math.round(f.importance * 100)}%</div>
              </div>
            `).join('') || '<p>Feature importance unavailable.</p>'}
            <details><summary>Deployed features</summary>${escapeHtml(meta.feature_names?.join(', ') || 'Unavailable')}</details>
          </div>
        </div>
      </div>

      <div class="section-subtitle">Flagged High-Risk Sessions Awaiting Verification</div>
      ${flagged.length === 0 ? '<div class="empty">No flagged sessions at this time.</div>' : `
        <div class="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Player</th>
                <th>Risk Score</th>
                <th>Telemetry Features</th>
                <th>Review Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${flagged.map(s => `
                <tr>
                  <td><details><summary>${escapeHtml(s.session_id.substring(0, 8))}</summary>${escapeHtml(s.session_id)}</details></td>
                  <td>${escapeHtml(s.player_name)}</td>
                  <td>
                    <span class="risk-pill risk-high">${escapeHtml(s.risk_score)} (${escapeHtml(s.risk_category)})</span>
                    <br><small class="badge badge-cyan">${s.detected_at ? formatTimeAgo(s.detected_at) : 'Detection time unavailable'}</small>
                  </td>
                  <td>
                    ${s.has_telemetry ? `<details><summary>Recorded telemetry</summary><dl>${Object.entries(s.features || {})
                      .filter(([, value]) => Number.isFinite(value))
                      .map(([label, value]) => `<dt>${escapeHtml(incidentLabel(label))}</dt><dd>${escapeHtml(value)}</dd>`).join('') || '<dd>Selected telemetry unavailable</dd>'}</dl></details>` : 'Telemetry unavailable'}
                  </td>
                  <td><span class="badge ${s.review_status === 'confirm_cheat' ? 'badge-danger' : (s.review_status === 'false_positive' ? 'badge-success' : 'badge-warning')}">${escapeHtml(s.review_status)}</span></td>
                  <td>
                    ${data.can_finalize_review ? `
                      <button class="action-btn danger-btn verify-cheat-btn" data-id="${escapeHtml(s.session_id)}" ${s.has_hard_evidence && s.review_status === "pending_review" ? "" : "disabled"}>Confirm Cheat</button>
                      <button class="action-btn ghost-btn fp-btn" data-id="${escapeHtml(s.session_id)}" ${s.review_status === "pending_review" ? "" : "disabled"}>False Positive</button>
                      ${s.review_status === 'pending_review' && !s.has_hard_evidence ? '<small class="muted">Hard evidence unavailable</small>' : ''}
                    ` : '<small class="muted">Final verdicts require Super Admin</small>'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    `;

    container.querySelectorAll('.verify-cheat-btn').forEach(btn => {
      btn.onclick = () => submitAnticheatReview(btn.dataset.id, 'confirm_cheat');
    });
    container.querySelectorAll('.fp-btn').forEach(btn => {
      btn.onclick = () => submitAnticheatReview(btn.dataset.id, 'false_positive');
    });
  } catch (err) {
    console.error('[AdminSecurity] Anti-cheat decisions load failed:', err);
  }
}

async function submitAnticheatReview(sessionId, verdict) {
  const note = await window.showAppPrompt(`Record this verdict as ${verdict}.`, { label: 'Review note' });
  if (note === null || !note.trim()) return;
  try {
    const resp = await fetch(`/api/admin/anticheat/review/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
      body: JSON.stringify({ verdict, note })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || 'Review failed');
    await loadAntiCheatDecisions();
  } catch (err) {
    window.showAppAlert(`Review failed: ${err.message}`, { tone: "error" });
  }
}

export async function loadAuditLogTable() {
  const tbody = document.getElementById('auditLogTableBody');
  const form = document.getElementById('auditFilters');
  if (!tbody || !form) return;

  const request = ++auditRequest;
  const offset = auditPage * AUDIT_PAGE_SIZE;
  const query = new URLSearchParams(auditFilters);
  query.set('limit', AUDIT_PAGE_SIZE);
  query.set('offset', offset);
  const previous = document.getElementById('auditPrevious');
  const next = document.getElementById('auditNext');
  const status = document.getElementById('auditPageStatus');
  previous.disabled = true;
  next.disabled = true;

  try {
    const response = await fetch(`/api/admin/audit-log?${query}`, { credentials: 'include' });
    const data = await response.json();
    if (request !== auditRequest) return;
    if (!response.ok) throw new Error(data.message || 'Audit history unavailable.');
    if (data.total > 0 && offset >= data.total) {
      auditPage = Math.floor((data.total - 1) / AUDIT_PAGE_SIZE);
      return loadAuditLogTable();
    }

    const selected = form.elements.action.value;
    const actions = [...new Set([...(data.actions || []), selected].filter(Boolean))];
    form.elements.action.replaceChildren(new Option('All actions', ''), ...actions.map(action => new Option(incidentLabel(action), action)));
    form.elements.action.value = selected;

    const logs = data.audit_logs || [];
    tbody.innerHTML = logs.map(entry => {
      const details = entry.details || {};
      const reason = details.reason ?? details.note ?? details.ban_reason ?? '—';
      const result = details.result ?? details.status ?? details.verdict ?? '—';
      return `
        <tr>
          <td>${formatTimeAgo(entry.timestamp)}</td>
          <td>${escapeHtml(entry.admin_email || 'System')}</td>
          <td>${escapeHtml(incidentLabel(entry.action))}</td>
          <td><code>${escapeHtml(entry.target_user_id || '—')}</code></td>
          <td>${escapeHtml(reason)}</td>
          <td>${escapeHtml(result)}</td>
          <td><details><summary>View event</summary><code>${escapeHtml(entry.action || '—')}</code><dl>${Object.entries(details).map(([key, value]) =>
            `<dt>${escapeHtml(incidentLabel(key))}</dt><dd>${escapeHtml(value)}</dd>`
          ).join('')}</dl></details></td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">No matching audit records.</td></tr>';
    previous.disabled = auditPage === 0;
    next.disabled = offset + logs.length >= data.total;
    status.textContent = logs.length ? `${offset + 1}–${offset + logs.length} of ${data.total}` : '0 records';
  } catch (err) {
    if (request !== auditRequest) return;
    tbody.innerHTML = '<tr><td colspan="7"></td></tr>';
    tbody.firstElementChild.firstElementChild.textContent = err.message;
    status.textContent = 'Audit history unavailable';
  }
}

export async function loadRecentLoginsTable() {
  const tbody = document.getElementById('recentLogins');
  const cardsGrid = document.getElementById('playerAuditCardsGrid');
  if (!tbody) return;

  const roleFilter = document.getElementById('loginAuditRoleFilter')?.value || 'player';

  try {
    const resp = await fetch(`/api/admin/logins?role=${encodeURIComponent(roleFilter)}&limit=100`, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;

    const data = await resp.json();
    currentAuditLogins = data.logins || [];
    currentAuditAccounts = data.accounts || [];

    // Render 4 Player Cards
    if (cardsGrid) {
      if (currentAuditAccounts.length === 0) {
        cardsGrid.innerHTML = '<div class="empty" style="grid-column: 1 / -1;">No matching accounts found.</div>';
      } else {
        cardsGrid.innerHTML = currentAuditAccounts.map((acc, idx) => {
          const initial = (acc.name || 'P').charAt(0).toUpperCase();
          const isHighRisk = (acc.risk_score || 0) >= 65;
          const riskClass = isHighRisk ? 'risk-high' : 'risk-low';
          const riskLabel = isHighRisk ? `Risk: ${acc.risk_score}` : `Risk: ${acc.risk_score} (Normal)`;
          const honourLabel = `Honour: ${acc.honour_score ?? 100} / 100`;

          return `
            <div class="player-audit-card ${idx === 0 ? 'active' : ''}" data-account-id="${acc.id}">
              <div class="player-audit-card-head">
                <div class="player-audit-card-avatar">${initial}</div>
                <div class="player-audit-card-info">
                  <strong>${escapeHtml(acc.name)}</strong>
                  <small>${escapeHtml(acc.email)}</small>
                </div>
              </div>
              <div class="player-audit-card-badges">
                <span class="player-audit-pill honour">${honourLabel}</span>
                <span class="player-audit-pill mfa">${acc.mfa_enabled ? 'MFA: On' : 'MFA: Off'}</span>
                <span class="player-audit-pill ${riskClass}">${riskLabel}</span>
              </div>
              <div class="player-audit-card-meta">
                <span>${acc.login_count} recorded session(s)</span>
                <span style="color:#7C3AED; font-weight:600;">Hover to inspect →</span>
              </div>
            </div>
          `;
        }).join('');

        // Attach cursor hover / move and click listeners to each card
        cardsGrid.querySelectorAll('.player-audit-card').forEach(card => {
          const accId = card.dataset.accountId;
          const acc = currentAuditAccounts.find(a => a.id === accId);
          if (!acc) return;

          card.addEventListener('mouseenter', () => selectAuditAccount(acc));
          card.addEventListener('mousemove', () => {
            if (activeAuditAccount?.id !== acc.id) selectAuditAccount(acc);
          });
          card.addEventListener('click', () => {
            selectAuditAccount(acc);
            if (window.openPlayerMatchesModal) {
              window.openPlayerMatchesModal(acc.id, acc.name, acc.email);
            }
          });
        });
      }
    }

    // Default select first account
    if (currentAuditAccounts.length > 0) {
      selectAuditAccount(currentAuditAccounts[0]);
    } else {
      renderLoginsTable(currentAuditLogins);
    }
  } catch (err) {
    console.error('[AdminSecurity] Error loading recent logins:', err);
    tbody.innerHTML = `<tr><td colspan="6" class="error-cell">Failed to load sign-in activity: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function selectAuditAccount(acc) {
  activeAuditAccount = acc;

  // Highlight active card
  document.querySelectorAll('#playerAuditCardsGrid .player-audit-card').forEach(card => {
    card.classList.toggle('active', card.dataset.accountId === acc.id);
  });

  // Update header info
  const avatarEl = document.getElementById('auditActiveAvatar');
  const nameEl = document.getElementById('auditActiveName');
  const emailEl = document.getElementById('auditActiveEmail');
  const honourEl = document.getElementById('auditActiveHonour');
  const secEl = document.getElementById('auditActiveSecurity');
  const riskEl = document.getElementById('auditActiveRisk');
  const inspectBtn = document.getElementById('auditInspectPlayerBtn');

  if (avatarEl) avatarEl.textContent = (acc.name || 'P').charAt(0).toUpperCase();
  if (nameEl) nameEl.textContent = acc.name || 'Operator';
  if (emailEl) emailEl.textContent = acc.email || '';
  if (honourEl) honourEl.textContent = `Honour: ${acc.honour_score ?? 100} / 100`;
  if (secEl) {
    secEl.textContent = acc.mfa_enabled ? 'MFA: Active' : 'MFA: Disabled';
    secEl.style.background = acc.mfa_enabled ? '#EDE9FE' : '#FEE2E2';
    secEl.style.color = acc.mfa_enabled ? '#5B21B6' : '#991B1B';
  }
  if (riskEl) {
    const isHigh = (acc.risk_score || 0) >= 65;
    riskEl.textContent = isHigh ? `Risk: ${acc.risk_score} (High Risk)` : `Risk: ${acc.risk_score} (Normal)`;
    riskEl.style.background = isHigh ? '#FEE2E2' : '#F3F4F6';
    riskEl.style.color = isHigh ? '#B91C1C' : '#374151';
  }
  if (inspectBtn) {
    inspectBtn.onclick = () => {
      if (window.openPlayerMatchesModal) {
        window.openPlayerMatchesModal(acc.id, acc.name, acc.email);
      }
    };
  }

  // Filter logins for this specific account
  const accEmail = (acc.email || '').toLowerCase();
  const accId = acc.id;
  const filteredLogins = currentAuditLogins.filter(l => {
    return (l.user_id && l.user_id === accId) || (l.identifier && l.identifier.toLowerCase() === accEmail);
  });

  renderLoginsTable(filteredLogins);
}

function renderLoginsTable(logins) {
  const tbody = document.getElementById('recentLogins');
  if (!tbody) return;

  if (logins.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No recent sign-in events recorded for this player.</td></tr>';
    return;
  }

  tbody.innerHTML = logins.map(item => {
    const isSuccess = item.status === 'success';
    const statusBadge = isSuccess
      ? `<span class="status-chip-success">✓ Success</span>`
      : item.status === 'failed' ? `<span class="status-chip-failed">${escapeHtml(item.reason || 'Failed')}</span>` : 'Unknown';

    return `
      <tr>
        <td>${statusBadge}</td>
        <td><span class="device-badge-slate">${escapeHtml(item.device || 'Desktop / Browser')}</span></td>
        <td><span class="ip-badge-purple">${escapeHtml(item.ip || 'Unknown')}</span></td>
        <td><span style="font-weight:600; color:#4C1D95;">${escapeHtml(item.location || 'Unknown')}</span></td>
        <td>${escapeHtml(item.risk || '—')}</td>
        <td><span style="color:#64748B; font-size:12px;">${formatTimeAgo(item.time)}</span></td>
      </tr>
    `;
  }).join('');
}
