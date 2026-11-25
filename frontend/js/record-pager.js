/* Compact paging for record sets already loaded by a dashboard. */
window.createRecordPager = function (container, label, pageSize = 10) {
  const nav = document.createElement('nav');
  nav.className = 'record-page-controls';
  nav.setAttribute('aria-label', label);
  nav.hidden = true;
  const makeButton = text => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost-btn';
    button.textContent = text;
    return button;
  };
  const previous = makeButton('Previous');
  const next = makeButton('Next');
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  nav.append(previous, status, next);
  (container.closest('.admin-table-wrap, .overview-table-wrap') || container).after(nav);

  let list = [];
  let page = 0;
  let paint;
  let group;

  function render() {
    const start = page * pageSize;
    paint(list.slice(start, start + pageSize));
    nav.hidden = list.length <= pageSize;
    previous.disabled = page === 0;
    next.disabled = start + pageSize >= list.length;
    status.textContent = `${start + 1}–${Math.min(start + pageSize, list.length)} of ${list.length}`;
  }

  for (const [button, change] of [[previous, -1], [next, 1]]) {
    button.addEventListener('click', () => {
      page += change;
      render();
      if (button.disabled) (change > 0 ? previous : next).focus();
    });
  }

  return function update(rows, renderer, key = '') {
    if (key !== group) page = 0;
    group = key;
    list = rows;
    paint = renderer;
    page = Math.min(page, Math.max(0, Math.ceil(list.length / pageSize) - 1));
    render();
  };
};
