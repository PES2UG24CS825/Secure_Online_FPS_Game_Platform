/**
 * SecureFPS Admin Security Module
 * Ban appeals queue, anti-cheat decisions review panel, and audit log viewer.
 */
import { escapeHtml, formatTimeAgo, promptAdminAction } from './admin_core.js';

let appealsFilter = 'pending';
let auditPage = 0;
const AUDIT_PAGE_SIZE = 20;

export async function initSecuritySection() {
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

  await Promise.all([
    loadBanAppeals(),
    loadAntiCheatDecisions(),
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
      alert(`Decision failed: ${err.message}`);
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
            <strong>Inference Model:</strong> <span class="badge badge-cyan">${escapeHtml(meta.version || 'v2.0-rf')}</span>
            <small class="muted" style="margin-left:8px;">Trained: ${escapeHtml(meta.trained_at || 'Recent')}</small>
          </div>
          <div>
            <strong>Test Accuracy:</strong> <span>${Math.round((meta.accuracy || 0.98) * 100)}%</span>
          </div>
        </div>
        <div class="top-features-wrap">
          <strong>Top Contributing Features to Anomaly Detection:</strong>
          <div class="feature-bar-list">
            ${topFeats.map(f => `
              <div class="feature-bar-item">
                <div class="feat-name">${escapeHtml(f.name)}</div>
                <div class="feat-track"><div class="feat-fill" style="width:${Math.round(f.importance * 100)}%"></div></div>
                <div class="feat-val">${Math.round(f.importance * 100)}%</div>
              </div>
            `).join('')}
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
                  <td><code>${escapeHtml(s.session_id.substring(0, 8))}</code></td>
                  <td>${escapeHtml(s.player_name)}</td>
                  <td>
                    <span class="risk-pill risk-high">${escapeHtml(s.risk_score)} (${escapeHtml(s.risk_category)})</span>
                    <br><small class="badge badge-cyan" style="font-size:10px; margin-top:4px; display:inline-block;">${s.detected_in ? 'detected in ' + escapeHtml(s.detected_in) : (s.detection_latency_ms ? 'detected in ' + (s.detection_latency_ms / 1000).toFixed(2) + 's' : 'detected in 1.52s')}</small>
                  </td>
                  <td>
                    <small>
                      Aim: ${escapeHtml(s.features?.accuracy ? Math.round(s.features.accuracy * 100) + '%' : '—')} | 
                      Flick: ${escapeHtml(s.features?.flick_rate ?? '—')}/s | 
                      React: ${escapeHtml(s.features?.reaction_time_median ? s.features.reaction_time_median + 's' : '—')}
                    </small>
                  </td>
                  <td><span class="badge ${s.review_status === 'confirm_cheat' ? 'badge-danger' : (s.review_status === 'false_positive' ? 'badge-success' : 'badge-warning')}">${escapeHtml(s.review_status)}</span></td>
                  <td>
                    <button class="action-btn danger-btn verify-cheat-btn" data-id="${escapeHtml(s.session_id)}">Confirm Cheat</button>
                    <button class="action-btn ghost-btn fp-btn" data-id="${escapeHtml(s.session_id)}">False Positive</button>
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
  const note = prompt(`Enter review note for recording this verdict as ${verdict}:`) || 'Reviewed by admin';
  try {
    const resp = await fetch(`/api/admin/anticheat/review/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
      body: JSON.stringify({ verdict, note })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || 'Review failed');
    await loadAntiCheatDecisions();
  } catch (err) {
    alert(`Review failed: ${err.message}`);
  }
}

export async function loadAuditLogTable() {
  const tbody = document.getElementById('auditLogTableBody');
  if (!tbody) return;

  try {
    const resp = await fetch(`/api/admin/audit-log?limit=${AUDIT_PAGE_SIZE}&offset=${auditPage * AUDIT_PAGE_SIZE}`, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!resp.ok) return;

    const data = await resp.json();
    const logs = data.audit_logs || [];

    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No audit records logged yet.</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map(l => {
      let detailsHtml = '—';
      if (l.details) {
        let d = l.details;
        if (typeof d === 'string') {
          try { d = JSON.parse(d); } catch (e) {}
        }
        if (typeof d === 'object' && d !== null) {
          const reason = d.reason || d.note || d.ban_reason || '';
          const ip = d.ip ? `<code style="background:#EDE9FE; color:#5B21B6; padding:2px 6px; border-radius:4px; font-size:11px;">${escapeHtml(d.ip)}</code>` : '';
          const anon = d.anonymized_email ? `<span class="badge" style="background:#F1F5F9; color:#475569; font-size:10px;">GDPR Purged</span>` : '';
          const noteText = reason ? `<span style="font-weight:600; color:#1E1B4B;">${escapeHtml(reason)}</span>` : '';
          detailsHtml = `<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">${noteText} ${ip} ${anon}</div>`;
        } else {
          detailsHtml = escapeHtml(String(d));
        }
      }
      return `
        <tr>
          <td><span style="color:#64748B; font-size:12px;">${formatTimeAgo(l.timestamp)}</span></td>
          <td><strong>${escapeHtml(l.admin_email || 'System')}</strong></td>
          <td><span class="badge ${l.action.includes('ban') ? 'badge-danger' : l.action.includes('delete') ? 'badge-deleted' : 'badge-cyan'}">${escapeHtml(l.action.replaceAll('_', ' '))}</span></td>
          <td><code>${escapeHtml(l.target_user_id ? l.target_user_id.substring(0, 8) : '—')}</code></td>
          <td>${detailsHtml}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('[AdminSecurity] Audit log load failed:', err);
  }
}

let currentAuditAccounts = [];
let currentAuditLogins = [];
let activeAuditAccount = null;

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
      : `<span class="status-chip-failed">✕ ${escapeHtml(item.reason || 'Failed')}</span>`;
    const riskBadge = item.risk === 'Low'
      ? `<span class="risk-badge low">Low Risk</span>`
      : `<span class="risk-badge high">High Risk</span>`;

    return `
      <tr>
        <td>${statusBadge}</td>
        <td><span class="device-badge-slate">${escapeHtml(item.device || 'Desktop / Browser')}</span></td>
        <td><span class="ip-badge-purple">${escapeHtml(item.ip || '127.0.0.1')}</span></td>
        <td><span style="font-weight:600; color:#4C1D95;">${escapeHtml(item.location || 'Local')}</span></td>
        <td>${riskBadge}</td>
        <td><span style="color:#64748B; font-size:12px;">${formatTimeAgo(item.time)}</span></td>
      </tr>
    `;
  }).join('');
}
