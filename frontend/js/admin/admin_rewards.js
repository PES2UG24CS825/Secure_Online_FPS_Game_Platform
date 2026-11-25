import { escapeHtml } from './admin_core.js?v=20261125_live_alert';

const status = document.getElementById('adminRewardsStatus');
const search = document.getElementById('adminRewardSearch');
const prevBtn = document.getElementById('adminRewardPrev');
const nextBtn = document.getElementById('adminRewardNext');
const pageInfo = document.getElementById('adminRewardPageInfo');
const catalog = document.getElementById('adminRewardCatalog');
const credits = document.getElementById('adminRewardCredits');
const itemForm = document.getElementById('adminRewardItemForm');
const adjustment = document.getElementById('adminRewardAdjustmentForm');
let currentItems = [];
let adjustmentRequest;
let currentPage = 1;

const feed = document.getElementById('adminRewardTransactions');
const pageNumber = document.getElementById('adminRewardPageNumber');
const counts = {
  coins_distributed: 'adminRewardCoinsDistributed',
  coins_spent: 'adminRewardCoinsSpent',
  xp_awarded: 'adminRewardXpAwarded',
  recipients: 'adminRewardRecipients',
};
const categories = {
  daily_login: 'Daily bonus', match_completed: 'Match reward', purchase: 'Purchase',
  achievement: 'Achievement', adjustment: 'Admin adjustment', other: 'Other activity',
};
const metrics = [
  ['transactions', 'Transactions'], ['coins_distributed', 'Coins earned'],
  ['coins_spent', 'Coins spent'], ['xp_awarded', 'XP earned'], ['honour_earned', 'Honour earned'],
];
const dateFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
  hour: 'numeric', minute: '2-digit',
});
const numbers = new Intl.NumberFormat('en-IN');
let requestVersion = 0;
let renderedFeed;
let historyVersion = 0;
let pendingSignature;
const historyState = new WeakMap();

function amount(value, unit, tone = '') {
  if (typeof value !== 'number') return `<span class="reward-feed-amount">— ${unit}</span>`;
  return `<span class="reward-feed-amount ${tone}">${value > 0 ? '+' : ''}${numbers.format(value)} ${unit}</span>`;
}

function renderTransaction(row) {
  const category = Object.hasOwn(categories, row.category) ? categories[row.category] : categories.other;
  const date = row.created_at ? new Date(row.created_at) : null;
  const hasDate = date && Number.isFinite(date.getTime());
  return `<li class="reward-history-entry">
    <span><small>${category}</small><span>${escapeHtml(row.description || category)}</span></span>
    <span class="reward-history-amounts">${amount(row.coins, 'coins', row.coins < 0 ? 'spent' : row.coins > 0 ? 'earned' : '')}${amount(row.xp, 'XP', 'xp')}${amount(row.honour, 'Honour')}</span>
    ${hasDate ? `<time datetime="${escapeHtml(row.created_at)}">${dateFormat.format(date)} IST</time>` : '<small>Date unavailable</small>'}
  </li>`;
}

function renderPlayer(player) {
  const id = escapeHtml(player.id);
  const labels = metrics.map(([key, label]) => `<span><small>${label}</small><strong>${numbers.format(player[key])}</strong></span>`).join('');
  return `<details class="reward-player-card" name="reward-player-history" data-player="${id}" data-total="${player.transactions}">
    <summary>
      <span class="reward-player-name">
        <img src="${escapeHtml(player.avatar)}" alt="" width="34" height="34" loading="lazy">
        <span><strong>${escapeHtml(player.username || player.name)}</strong><small>${player.is_demo ? 'Demonstration account' : 'Player account'}</small></span>
      </span>
      <span class="reward-player-metrics">${labels}</span>
      <span class="reward-player-action"><span>View history</span><span>Close history</span></span>
      <span class="reward-player-preview" aria-hidden="true">${labels}</span>
    </summary>
    <section class="reward-player-history" aria-label="Transaction history">
      <form class="admin-reward-filters reward-history-filters" hidden>
        <label>Category <select name="category"><option value="all">All categories</option>${Object.entries(categories).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
        <label>From (IST) <input name="date_from" type="date"></label>
        <label>To (IST) <input name="date_to" type="date"></label>
        <button class="ghost-btn" type="submit">Apply</button>
      </form>
      <p class="reward-history-status" role="status"></p>
      <ul class="reward-history-list"></ul>
      <nav class="record-page-controls reward-history-pages" aria-label="Transaction pages" hidden>
        <button type="button" class="ghost-btn" data-history-step="-1">Previous</button>
        <span role="status"></span>
        <button type="button" class="ghost-btn" data-history-step="1">Next</button>
      </nav>
    </section>
  </details>`;
}

async function loadPlayerHistory(row, page = 1, filters = {}) {
  const version = ++historyVersion;
  const status = row.querySelector('.reward-history-status');
  const nav = row.querySelector('.reward-history-pages');
  status.textContent = 'Loading transactions…';
  nav.hidden = true;
  try {
    const params = new URLSearchParams({ view: 'history', player_id: row.dataset.player, page, limit: 10, ...filters });
    const data = await api('/admin/rewards/shop?' + params);
    if (version !== historyVersion || !row.isConnected || !row.open) return;
    row.querySelector('.reward-history-list').innerHTML = data.transactions.map(renderTransaction).join('');
    status.textContent = data.total ? `${numbers.format(data.total)} transactions` : 'No transactions to show.';
    nav.querySelector('[role="status"]').textContent = `Page ${data.page} of ${data.pages}`;
    nav.querySelector('[data-history-step="-1"]').disabled = data.page <= 1;
    nav.querySelector('[data-history-step="1"]').disabled = data.page >= data.pages;
    nav.hidden = data.pages <= 1;
    row.querySelector('.reward-history-filters').hidden = row.dataset.total === '0';
    historyState.set(row, { page: data.page, filters });
  } catch (error) {
    if (version === historyVersion && row.isConnected && row.open) {
      row.querySelector('.reward-history-list').replaceChildren();
      status.textContent = error.message;
    }
  }
}

feed?.addEventListener('toggle', event => {
  const row = event.target;
  if (row.matches('.reward-player-card') && row.open) {
    for (const other of feed.querySelectorAll('.reward-player-card[open]')) {
      if (other !== row) other.open = false;
    }
    const state = historyState.get(row);
    void loadPlayerHistory(row, state?.page, state?.filters);
  }
}, true);
feed?.addEventListener('submit', event => {
  if (!event.target.matches('.reward-history-filters')) return;
  event.preventDefault();
  void loadPlayerHistory(event.target.closest('.reward-player-card'), 1, Object.fromEntries(new FormData(event.target)));
});
feed?.addEventListener('click', event => {
  const button = event.target.closest('[data-history-step]');
  if (!button) return;
  const row = button.closest('.reward-player-card');
  const state = historyState.get(row);
  if (state) void loadPlayerHistory(row, state.page + Number(button.dataset.historyStep), state.filters);
});

function renderCredits(rows, canManage) {
  const signature = JSON.stringify([rows, canManage]);
  if (signature === pendingSignature) return;
  pendingSignature = signature;
  const open = new Set([...credits.querySelectorAll('details[open]')].map(row => row.dataset.player));
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.player)) groups.set(row.player, []);
    groups.get(row.player).push(row);
  }
  credits.innerHTML = [...groups].map(([player, entries]) => `<details data-player="${escapeHtml(player)}"${open.has(player) ? ' open' : ''}>
    <summary>${escapeHtml(entries[0].player_name)} · ${entries.length} ${entries.length === 1 ? 'credit' : 'credits'}</summary>
    ${entries.map(row => `<div>${escapeHtml(row.session_id || 'Match')} · ${escapeHtml(row.status)} ${canManage ? `<button class="ghost-btn" data-retry-credit="${escapeHtml(row.id)}">Retry credit</button>` : ''}</div>`).join('')}
  </details>`).join('') || '<p>No pending or failed credits.</p>';
}

export async function loadRewardOperations(resetPage = false) {
  if (!status) return;
  if (resetPage) currentPage = 1;
  const version = ++requestVersion;
  if (renderedFeed === undefined) status.textContent = 'Loading players…';
  try {
    const params = new URLSearchParams(new FormData(search));
    params.set('view', 'players');
    params.set('page', currentPage);
    params.set('limit', '10');
    const data = await api('/admin/rewards/shop?' + params);
    if (version !== requestVersion) return;
    currentItems = data.items || [];
    itemForm.hidden = !data.can_manage;
    document.getElementById('adminRewardAdjustments').hidden = !data.can_manage;

    for (const [key, id] of Object.entries(counts)) {
      const value = data.summary?.[key];
      document.getElementById(id).textContent = typeof value === 'number' ? numbers.format(value) : '—';
    }
    const groups = data.player_groups || [];
    const signature = JSON.stringify(groups);
    if (signature !== renderedFeed) {
      const expanded = feed.querySelector('.reward-player-card[open]');
      const state = expanded && historyState.get(expanded);
      const focusedId = document.activeElement?.closest('.reward-player-card')?.dataset.player;
      feed.innerHTML = groups.map(renderPlayer).join('') || '<p class="empty">No matching players.</p>';
      for (const row of feed.querySelectorAll('.reward-player-card')) {
        if (row.dataset.player === expanded?.dataset.player) {
          if (state) {
            historyState.set(row, state);
            const form = row.querySelector('.reward-history-filters');
            for (const [key, value] of Object.entries(state.filters)) form.elements[key].value = value;
          }
          row.open = true;
        }
        if (row.dataset.player === focusedId) row.querySelector('summary').focus({ preventScroll: true });
      }
      renderedFeed = signature;
    }
    const pages = data.pages || 1;
    currentPage = data.page || 1;
    pageInfo.textContent = `${numbers.format(data.total)} matching players`;
    pageNumber.textContent = `Page ${currentPage} of ${pages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= pages;
    document.getElementById('adminRewardPagination').hidden = pages <= 1;

    catalog.innerHTML = currentItems.map(item =>
      `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.category || 'Badge')}</td><td>${Number(item.price)}</td><td>${item.available ? 'Enabled' : item.artwork_ready ? 'Disabled' : 'Awaiting artwork'}</td><td>${data.can_manage ? `<button class="ghost-btn" data-edit-item="${escapeHtml(item.id)}">Edit</button>` : ''}</td></tr>`
    ).join('');
    renderCredits(data.pending || [], data.can_manage);
    status.textContent = '';
  } catch (error) {
    if (version === requestVersion) status.textContent = error.message;
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
  void loadRewardOperations(true);
});
search?.elements.account_type.addEventListener('change', () => void loadRewardOperations(true));
prevBtn?.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage -= 1;
    void loadRewardOperations(false);
  }
});
nextBtn?.addEventListener('click', () => {
  currentPage += 1;
  void loadRewardOperations(false);
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
