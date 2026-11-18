import { escapeHtml } from './admin_core.js';

const status = document.getElementById('adminRewardsStatus');
const search = document.getElementById('adminRewardSearch');
const catalog = document.getElementById('adminRewardCatalog');
const credits = document.getElementById('adminRewardCredits');
const itemForm = document.getElementById('adminRewardItemForm');
const adjustment = document.getElementById('adminRewardAdjustmentForm');
let currentItems = [];
let adjustmentRequest;

export async function loadRewardOperations() {
  if (!status) return;
  status.textContent = 'Loading rewards operations…';
  try {
    const data = await api('/admin/rewards/shop?q=' + encodeURIComponent(search.elements.q.value));
    currentItems = data.items;
    itemForm.hidden = !data.can_manage;
    document.getElementById('adminRewardAdjustments').hidden = !data.can_manage;
    document.getElementById('adminRewardTransactions').innerHTML = data.transactions.map(row =>
      `<tr><td>${escapeHtml(row.player)}</td><td>${escapeHtml(row.description)}</td><td>${Number(row.coins)}</td><td>${Number(row.xp)}</td><td>${escapeHtml(row.created_at || '—')}</td></tr>`
    ).join('') || '<tr><td colspan="5">No matching transactions.</td></tr>';
    catalog.innerHTML = currentItems.map(item =>
      `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.category || 'Badge')}</td><td>${Number(item.price)}</td><td>${item.available ? 'Enabled' : item.artwork_ready ? 'Disabled' : 'Awaiting artwork'}</td><td>${data.can_manage ? `<button class="ghost-btn" data-edit-item="${escapeHtml(item.id)}">Edit</button>` : ''}</td></tr>`
    ).join('');
    credits.innerHTML = data.pending.map(row =>
      `<div><strong>${escapeHtml(row.session_id)}</strong> · ${escapeHtml(row.status)} ${data.can_manage ? `<button class="ghost-btn" data-retry-credit="${escapeHtml(row.id)}">Retry credit</button>` : ''}</div>`
    ).join('') || '<p>No pending or failed credits.</p>';
    status.textContent = '';
  } catch (error) {
    status.textContent = error.message;
  }
}

async function submitRewardAction(button, path, options) {
  button.disabled = true;
  try {
    const data = await api(path, options);
    await loadRewardOperations();
    status.textContent = data.message;
    return true;
  } catch (error) {
    status.textContent = error.message;
    return false;
  } finally {
    button.disabled = false;
  }
}

search?.addEventListener('submit', event => {
  event.preventDefault();
  void loadRewardOperations();
});
catalog?.addEventListener('click', event => {
  const button = event.target.closest('[data-edit-item]');
  const item = button && currentItems.find(row => row.id === button.dataset.editItem);
  if (!item) return;
  itemForm.reset();
  itemForm.elements.item_id.value = item.id;
  itemForm.elements.name.value = item.name;
  itemForm.elements.price.value = item.price;
  itemForm.elements.enabled.checked = item.enabled !== false;
  itemForm.elements.name.focus();
});
itemForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(itemForm));
  const saved = await submitRewardAction(event.submitter, '/admin/rewards/shop/' + encodeURIComponent(data.item_id), {
    method: 'PUT',
    body: JSON.stringify({ ...data, price: Number(data.price), enabled: itemForm.elements.enabled.checked }),
  });
  if (saved) itemForm.reset();
});
adjustment?.addEventListener('submit', async event => {
  event.preventDefault();
  const { password, ...details } = Object.fromEntries(new FormData(adjustment));
  const fingerprint = JSON.stringify(details);
  if (adjustmentRequest?.fingerprint !== fingerprint) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    adjustmentRequest = { fingerprint, id };
  }
  adjustment.elements.password.value = '';
  const saved = await submitRewardAction(event.submitter, '/admin/rewards/adjustments', {
    method: 'POST',
    body: JSON.stringify({ ...details, password, coins: Number(details.coins), request_id: adjustmentRequest.id }),
  });
  if (saved) {
    adjustmentRequest = null;
    adjustment.reset();
  }
});
credits?.addEventListener('click', event => {
  const button = event.target.closest('[data-retry-credit]');
  if (button) void submitRewardAction(button, '/admin/rewards/credits/' + button.dataset.retryCredit + '/retry', { method: 'POST' });
});
