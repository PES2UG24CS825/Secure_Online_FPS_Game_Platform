/**
 * SecureFPS Admin Customer Support Module
 * Enhanced support tickets with pagination, status/priority filtering, and macro reply templates.
 */
import { escapeHtml, formatTimeAgo } from './admin_core.js';

let supportStatusFilter = '';
let supportPriorityFilter = '';
let replyTemplates = [];

export async function initSupportSection() {
  const statusFilterEl = document.getElementById('supportStatusFilter');
  if (statusFilterEl) {
    statusFilterEl.addEventListener('change', (e) => {
      supportStatusFilter = e.target.value;
      loadSupportTickets();
    });
  }

  const priorityFilterEl = document.getElementById('supportPriorityFilter');
  if (priorityFilterEl) {
    priorityFilterEl.addEventListener('change', (e) => {
      supportPriorityFilter = e.target.value;
      loadSupportTickets();
    });
  }

  await loadSupportTickets();
}

export async function loadSupportTickets() {
  const container = document.getElementById('supportTicketInbox');
  if (!container) return;

  container.innerHTML = '<div class="loading">Loading support tickets…</div>';

  try {
    const params = new URLSearchParams({ limit: 50, offset: 0 });
    if (supportStatusFilter) params.set('status', supportStatusFilter);
    if (supportPriorityFilter) params.set('priority', supportPriorityFilter);

    const resp = await fetch(`/api/admin/support/tickets?${params.toString()}`, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });

    if (!resp.ok) {
      if (resp.status === 403) return;
      throw new Error(`Failed to load support tickets: ${resp.status}`);
    }

    const data = await resp.json();
    const tickets = data.tickets || [];
    replyTemplates = data.reply_templates || [];

    if (tickets.length === 0) {
      container.innerHTML = '<div class="empty">No support tickets matching current filters.</div>';
      return;
    }

    container.innerHTML = tickets.map(t => {
      const isResolved = t.status === 'resolved';
      const isAnswered = t.status === 'answered';
      const statusClass = isResolved ? 'badge-success' : (isAnswered ? 'badge-cyan' : 'badge-warning');
      const priorityClass = t.priority === 'urgent' ? 'badge-danger' : (t.priority === 'high' ? 'badge-warning' : 'badge-normal');

      return `
        <article class="support-ticket-card ${t.status}" id="ticket-${escapeHtml(t.id)}">
          <div class="ticket-header">
            <div>
              <strong>${escapeHtml(t.player_name || 'Player')}</strong>
              <small class="muted" style="margin-left:6px;">(${escapeHtml(t.player_email || '')})</small>
              <div class="ticket-tags">
                <span class="badge ${statusClass}">${escapeHtml(t.status || 'open')}</span>
                <span class="badge ${priorityClass}">Priority: ${escapeHtml(t.priority || 'normal')}</span>
                <span class="badge badge-subtle">Category: ${escapeHtml(t.category || 'other')}</span>
                ${t.assignee ? `<span class="badge badge-subtle">Assignee: ${escapeHtml(t.assignee)}</span>` : ''}
              </div>
            </div>
            <div class="ticket-time">${formatTimeAgo(t.created_at)}</div>
          </div>

          <div class="ticket-body">
            <p class="ticket-message">${escapeHtml(t.message)}</p>
            ${t.attachment ? `
              <div class="ticket-attachment">
                <button class="ghost-btn view-attachment-btn" data-id="${escapeHtml(t.id)}">📎 View Evidence Image (${escapeHtml(t.attachment.name || 'Image')})</button>
              </div>
            ` : ''}
          </div>

          ${t.admin_reply ? `
            <div class="ticket-existing-reply">
              <strong>Support Response:</strong>
              <p>${escapeHtml(t.admin_reply)}</p>
              <small class="muted">Sent ${formatTimeAgo(t.replied_at)}</small>
            </div>
          ` : ''}

          ${!isResolved ? `
            <div class="ticket-reply-form">
              <div class="macro-picker-row">
                <label for="macro-${escapeHtml(t.id)}">Reply Template:</label>
                <select class="macro-select admin-modal-input" id="macro-${escapeHtml(t.id)}" data-id="${escapeHtml(t.id)}">
                  <option value="">-- Choose pre-written reply macro --</option>
                  ${replyTemplates.map(tmpl => `
                    <option value="${escapeHtml(tmpl.id)}">${escapeHtml(tmpl.title)}</option>
                  `).join('')}
                </select>
              </div>

              <textarea class="reply-textarea admin-modal-textarea" id="reply-text-${escapeHtml(t.id)}" rows="3" placeholder="Type response to player..."></textarea>
              
              <div class="ticket-actions">
                <button class="play-btn send-reply-btn" data-id="${escapeHtml(t.id)}">Send Reply</button>
                <button class="ghost-btn resolve-btn" data-id="${escapeHtml(t.id)}">Mark Resolved</button>
              </div>
            </div>
          ` : `
            <div class="ticket-resolved-banner">
              <span>✓ Ticket resolved</span>
            </div>
          `}
        </article>
      `;
    }).join('');

    attachSupportListeners(container);
  } catch (err) {
    console.error('[AdminSupport] Load tickets error:', err);
    container.innerHTML = `<div class="error-cell">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function attachSupportListeners(container) {
  // Macro template selection
  container.querySelectorAll('.macro-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const ticketId = e.target.dataset.id;
      const tmplId = e.target.value;
      const tmpl = replyTemplates.find(t => t.id === tmplId);
      const textarea = document.getElementById(`reply-text-${ticketId}`);
      if (tmpl && textarea) {
        textarea.value = tmpl.text;
      }
    });
  });

  // Send reply
  container.querySelectorAll('.send-reply-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ticketId = btn.dataset.id;
      const textarea = document.getElementById(`reply-text-${ticketId}`);
      const reply = (textarea?.value || '').trim();
      if (!reply) {
        alert('Please enter a reply before sending.');
        return;
      }

      btn.disabled = true;
      try {
        const resp = await fetch(`/api/admin/support/tickets/${ticketId}/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' },
          body: JSON.stringify({ reply })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.message || 'Failed to send reply');
        await loadSupportTickets();
      } catch (err) {
        alert(`Error: ${err.message}`);
        btn.disabled = false;
      }
    });
  });

  // Resolve ticket
  container.querySelectorAll('.resolve-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ticketId = btn.dataset.id;
      btn.disabled = true;
      try {
        const resp = await fetch(`/api/admin/support/tickets/${ticketId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 'securefps-csrf' }
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.message || 'Failed to resolve ticket');
        await loadSupportTickets();
      } catch (err) {
        alert(`Error: ${err.message}`);
        btn.disabled = false;
      }
    });
  });
}
