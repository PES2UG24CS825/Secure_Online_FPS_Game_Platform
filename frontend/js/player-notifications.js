(() => {
  const byId = id => document.getElementById(id);
  const navLink = byId("notificationNavLink");
  const badge = byId("notifBadge");
  const headingBadge = byId("notifHeadingBadge");
  const connStatus = byId("notifConnStatus");
  const history = byId("notificationHistory");
  const historyPage = byId("notifications");
  const pagination = byId("notifPagination");
  const previous = byId("notificationsPrevious");
  const next = byId("notificationsNext");
  const pageIndicator = byId("notificationPage");
  const errorBanner = byId("notificationError");
  const toastContainer = byId("notificationToastContainer");
  const settingsModal = byId("notifSettingsModal");
  const settingsBtn = byId("notifSettingsBtn");
  const closeSettingsModal = byId("closeNotifSettingsModal");
  const preferencesForm = byId("notificationPreferences");
  const preferenceStatus = byId("notificationPreferenceStatus");

  // Proxy elements for legacy compatibility
  const categorySelect = byId("notificationCategory");
  const unreadCheckbox = byId("notificationsUnread");

  const allowedSections = new Set(["security", "fairplay", "support", "matches", "rewards", "games", "overview"]);
  const limit = 10;
  let page = 1;
  let version = 0;
  let preferenceLoad = null;
  let activeFilter = "all";
  let knownIds = new Set();
  let initialLoadDone = false;

  const categoryMeta = {
    security: { icon: "🛡️", label: "Security", className: "notif-cat-security" },
    account: { icon: "👤", label: "Account", className: "notif-cat-account" },
    matches: { icon: "🎯", label: "Match", className: "notif-cat-matches" },
    rewards: { icon: "🏆", label: "Rewards", className: "notif-cat-rewards" },
    support: { icon: "💬", label: "Support", className: "notif-cat-support" },
    announcements: { icon: "📢", label: "Notice", className: "notif-cat-announcements" },
    default: { icon: "🔔", label: "System", className: "notif-cat-announcements" }
  };

  function updateConnStatus(state) {
    if (!connStatus) return;
    connStatus.className = `notif-conn-status ${state}`;
    const dot = '<span class="status-dot"></span>';
    if (state === "live") {
      connStatus.innerHTML = `${dot} Live`;
      connStatus.title = "Real-time sync active";
    } else if (state === "reconnecting") {
      connStatus.innerHTML = `${dot} Reconnecting…`;
      connStatus.title = "Connecting to sync server";
    } else {
      connStatus.innerHTML = `${dot} Offline`;
      connStatus.title = "Offline or server unreachable";
    }
  }

  function formatRelativeTime(date) {
    if (!date || !Number.isFinite(date.getTime())) return "Recently";
    const now = Date.now();
    const diffSec = Math.floor((now - date.getTime()) / 1000);
    if (diffSec < 45) return "Just now";
    if (diffSec < 3600) return `${Math.max(1, Math.floor(diffSec / 60))}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function getDateBucket(date) {
    if (!date || !Number.isFinite(date.getTime())) return "Earlier";
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86400000;
    const time = date.getTime();
    if (time >= startOfToday) return "Today";
    if (time >= startOfYesterday) return "Yesterday";
    return "Earlier";
  }

  function showNotificationToast(note) {
    if (!toastContainer) return;
    const meta = categoryMeta[note.category] || categoryMeta.default;
    const toast = document.createElement("aside");
    toast.className = `notif-toast ${meta.className}`;
    toast.setAttribute("role", "alert");

    const icon = document.createElement("span");
    icon.className = "notif-toast-icon";
    icon.textContent = meta.icon;

    const body = document.createElement("div");
    body.className = "notif-toast-body";

    const title = document.createElement("strong");
    title.className = "notif-toast-title";
    title.textContent = note.title;

    const msg = document.createElement("p");
    msg.className = "notif-toast-msg";
    msg.textContent = note.message;

    body.append(title, msg);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "notif-toast-close";
    close.setAttribute("aria-label", "Dismiss alert");
    close.textContent = "✕";

    toast.append(icon, body, close);
    toastContainer.append(toast);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      toast.style.opacity = "0";
      toast.style.transform = "translateX(60px)";
      toast.style.transition = "all 0.25s ease";
      setTimeout(() => toast.remove(), 260);
    };

    close.addEventListener("click", dismiss);
    toast.addEventListener("click", (e) => {
      if (e.target !== close && note.destination && allowedSections.has(note.destination)) {
        window.location.hash = note.destination;
        dismiss();
      }
    });

    setTimeout(dismiss, 5500);
  }

  function renderGrouped(notifications) {
    if (!history) return;
    history.replaceChildren();

    if (!notifications.length) {
      const empty = document.createElement("div");
      empty.className = "notif-empty-card";
      empty.innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.85; margin-bottom:8px;">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
        <h4>You're all caught up</h4>
        <p>No notifications match this filter. Live platform events will appear here in real time.</p>
      `;
      history.append(empty);
      return;
    }

    // Group into Today, Yesterday, Earlier
    const buckets = { Today: [], Yesterday: [], Earlier: [] };
    for (const note of notifications) {
      const date = new Date(note.created_at || NaN);
      const bucket = getDateBucket(date);
      buckets[bucket].push({ note, date });
    }

    for (const [bucketName, items] of Object.entries(buckets)) {
      if (!items.length) continue;

      const groupWrap = document.createElement("div");
      groupWrap.className = "notif-group";

      const groupHead = document.createElement("div");
      groupHead.className = "notif-group-header";
      const badge = document.createElement("span");
      badge.textContent = bucketName;
      groupHead.append(badge);
      groupWrap.append(groupHead);

      for (const { note, date } of items) {
        const row = document.createElement("article");
        row.dataset.notificationId = note.id;
        const meta = categoryMeta[note.category] || categoryMeta.default;

        let extraSeverity = "";
        const lowerMsg = (note.message || "").toLowerCase() + (note.title || "").toLowerCase();
        if (note.category === "security") {
          if (lowerMsg.includes("suspicious") || lowerMsg.includes("warning") || lowerMsg.includes("alert")) {
            extraSeverity = "warn";
          } else if (lowerMsg.includes("failed") || lowerMsg.includes("critical") || lowerMsg.includes("banned")) {
            extraSeverity = "critical";
          }
        }

        row.className = `notif-row ${meta.className} ${extraSeverity}`.trim();
        if (!note.read) row.classList.add("unread");

        // Left section: Icon + body
        const left = document.createElement("div");
        left.className = "notif-row-left";

        const badgeIcon = document.createElement("div");
        badgeIcon.className = "notif-badge-icon";
        badgeIcon.textContent = meta.icon;

        const body = document.createElement("div");
        body.className = "notif-body";

        const metaLine = document.createElement("div");
        metaLine.className = "notif-meta-line";

        const catTag = document.createElement("span");
        catTag.className = "notif-cat-tag";
        catTag.textContent = meta.label;
        metaLine.append(catTag);

        if (!note.read) {
          const newDot = document.createElement("span");
          newDot.className = "notif-new-dot";
          newDot.title = "Unread";
          metaLine.append(newDot);
        }

        const timeText = document.createElement("span");
        timeText.className = "notif-time-text";
        timeText.textContent = formatRelativeTime(date);
        timeText.title = Number.isFinite(date.getTime()) ? date.toLocaleString() : "Date unavailable";
        metaLine.append(timeText);

        const title = document.createElement("h4");
        title.className = "notif-title";
        title.textContent = note.title;

        const desc = document.createElement("p");
        desc.className = "notif-desc";
        desc.textContent = note.message;

        body.append(metaLine, title, desc);
        left.append(badgeIcon, body);

        // Right section: Actions (View details, Toggle read)
        const right = document.createElement("div");
        right.className = "notif-row-right";

        if (note.destination && allowedSections.has(note.destination)) {
          const destLink = document.createElement("a");
          destLink.href = `#${note.destination}`;
          destLink.className = "notif-link-btn";
          destLink.textContent = "View details ↗";
          destLink.dataset.notificationAction = "read";
          right.append(destLink);
        }

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "notif-toggle-btn";
        toggleBtn.dataset.notificationAction = note.read ? "unread" : "read";
        toggleBtn.textContent = note.read ? "Mark unread" : "Mark read";
        right.append(toggleBtn);

        row.append(left, right);
        groupWrap.append(row);
      }

      history.append(groupWrap);
    }
  }

  window.refreshPlayerNotifications = async () => {
    if (document.hidden) return;
    const reqVersion = ++version;
    const viewingHistory = historyPage && historyPage.classList.contains("player-view-active");

    try {
      let catParam = "";
      let statusParam = "";

      if (activeFilter === "unread") {
        statusParam = "unread";
      } else if (activeFilter !== "all") {
        catParam = activeFilter;
      }

      const query = new URLSearchParams({
        limit,
        page,
        category: catParam,
        status: statusParam
      });

      const data = await api(viewingHistory ? `/player/notifications?${query}` : "/player/notifications?limit=10");
      if (reqVersion !== version) return;

      updateConnStatus("live");

      // Update sidebar badge
      const unreadCount = Number(data.unread_count || 0);
      if (badge) {
        badge.textContent = unreadCount;
        badge.hidden = !unreadCount;
      }
      if (headingBadge) {
        headingBadge.textContent = `${unreadCount} unread`;
        headingBadge.hidden = !unreadCount;
      }
      if (navLink) {
        navLink.setAttribute("aria-label", unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications");
      }

      // Check for incoming new unread notifications to trigger real-time toast
      if (Array.isArray(data.notifications)) {
        if (initialLoadDone) {
          for (const note of data.notifications) {
            if (!note.read && !knownIds.has(note.id)) {
              showNotificationToast(note);
            }
          }
        }
        for (const note of data.notifications) {
          knownIds.add(note.id);
        }
        initialLoadDone = true;
      }

      // Render feed if viewing notifications view
      if (viewingHistory && history) {
        const total = Number(data.total || 0);
        const pages = Math.max(1, Math.ceil(total / limit));
        if (page > pages && pages > 0) {
          page = pages;
          return window.refreshPlayerNotifications();
        }

        renderGrouped(data.notifications || []);

        if (pagination) {
          pagination.hidden = pages <= 1;
        }
        if (previous) previous.disabled = page <= 1;
        if (next) next.disabled = page >= pages;
        if (pageIndicator) pageIndicator.textContent = `Page ${page} of ${pages}`;
      }

      if (errorBanner) {
        errorBanner.hidden = true;
        errorBanner.textContent = "";
      }
    } catch (err) {
      if (reqVersion === version) {
        updateConnStatus("offline");
        if (errorBanner) {
          errorBanner.hidden = false;
          errorBanner.textContent = err.message || "Notifications currently unavailable.";
        }
      }
    }
  };

  function loadPreferences() {
    if (preferenceLoad) return preferenceLoad;
    preferenceLoad = api("/player/notifications/preferences").then(data => {
      const fields = byId("notificationPreferenceFields");
      if (!fields) return;
      fields.replaceChildren(...Object.entries(data.labels || {}).map(([key, title]) => {
        const row = document.createElement("label");
        row.className = "notif-pref-row";

        const textCol = document.createElement("div");
        textCol.className = "notif-pref-meta";
        const strong = document.createElement("strong");
        strong.textContent = title;
        const sub = document.createElement("small");
        sub.textContent = key === "security"
          ? "Critical security and account alerts (always enabled)"
          : "Live updates and notifications for this channel";
        textCol.append(strong, sub);

        const switchWrap = document.createElement("span");
        switchWrap.className = "notif-switch";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = key;
        checkbox.checked = data.preferences ? data.preferences[key] !== false : true;
        if (key === "security") {
          checkbox.disabled = true;
          checkbox.checked = true;
        }
        const slider = document.createElement("span");
        slider.className = "notif-slider";
        switchWrap.append(checkbox, slider);

        row.append(textCol, switchWrap);
        return row;
      }));
      if (preferencesForm) {
        const btn = preferencesForm.querySelector("button");
        if (btn) btn.disabled = false;
      }
    }).catch(error => {
      preferenceLoad = null;
      if (preferenceStatus) preferenceStatus.textContent = error.message;
    });
    return preferenceLoad;
  }

  // Filter tabs click handler
  document.addEventListener("click", e => {
    const tab = e.target.closest("[data-notif-filter]");
    if (!tab) return;
    document.querySelectorAll("[data-notif-filter]").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    activeFilter = tab.dataset.notifFilter;
    page = 1;
    if (categorySelect) categorySelect.value = (activeFilter === "unread" || activeFilter === "all") ? "" : activeFilter;
    if (unreadCheckbox) unreadCheckbox.checked = activeFilter === "unread";
    window.refreshPlayerNotifications();
  });

  // Settings modal handlers
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
      loadPreferences();
      if (settingsModal && typeof settingsModal.showModal === "function") {
        settingsModal.showModal();
      }
    });
  }
  if (closeSettingsModal) {
    closeSettingsModal.addEventListener("click", () => {
      if (settingsModal && typeof settingsModal.close === "function") {
        settingsModal.close();
      }
    });
  }
  if (settingsModal) {
    settingsModal.addEventListener("click", (e) => {
      if (e.target === settingsModal && typeof settingsModal.close === "function") {
        settingsModal.close();
      }
    });
  }

  // Action clicks (mark read, toggle, view details, mark all)
  if (historyPage) {
    historyPage.addEventListener("click", async event => {
      const all = event.target.closest("[data-notification-all]");
      const control = event.target.closest("[data-notification-action]");
      if (!all && !control) return;

      const destination = control?.tagName === "A" ? control.hash : "";
      if (destination) event.preventDefault();

      const body = all
        ? { mark_all: true }
        : {
            action: control.dataset.notificationAction,
            notification_ids: [control.closest("[data-notification-id]").dataset.notificationId]
          };

      try {
        await api("/player/notifications/read", { method: "POST", body: JSON.stringify(body) });
        if (destination) window.location.hash = destination;
        window.refreshPlayerNotifications();
      } catch (err) {
        if (errorBanner) {
          errorBanner.hidden = false;
          errorBanner.textContent = err.message;
        }
      }
    });
  }

  // Pagination handlers
  if (previous) {
    previous.addEventListener("click", () => {
      if (page > 1) {
        page -= 1;
        window.refreshPlayerNotifications();
      }
    });
  }
  if (next) {
    next.addEventListener("click", () => {
      page += 1;
      window.refreshPlayerNotifications();
    });
  }

  // Tab switch view listener
  document.addEventListener("securefps:view", event => {
    if (event.detail === "notifications") {
      loadPreferences();
      window.refreshPlayerNotifications();
    }
  });

  // Preferences save
  if (preferencesForm) {
    preferencesForm.addEventListener("submit", async event => {
      event.preventDefault();
      const button = preferencesForm.querySelector("button");
      if (button) button.disabled = true;
      try {
        const choices = Object.fromEntries(
          [...preferencesForm.querySelectorAll("input")].map(input => [input.name, input.checked])
        );
        await api("/player/notifications/preferences", { method: "PUT", body: JSON.stringify(choices) });
        if (preferenceStatus) {
          preferenceStatus.textContent = "✓ Preferences saved.";
          setTimeout(() => { if (preferenceStatus) preferenceStatus.textContent = ""; }, 3000);
        }
      } catch (error) {
        if (preferenceStatus) preferenceStatus.textContent = error.message;
      } finally {
        if (button) button.disabled = false;
      }
    });
  }

  // Real-time background sync loop every 10 seconds when tab is active
  setInterval(() => {
    if (!document.hidden) {
      window.refreshPlayerNotifications?.();
    }
  }, 10000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      window.refreshPlayerNotifications?.();
    }
  });
})();

(() => {
  const timeline = document.getElementById("activityTimeline");
  const category = document.getElementById("activityCategory");
  const refresh = document.getElementById("refreshActivity");
  if (!timeline || !category || !refresh) return;

  const renderActivityPage = window.createRecordPager(timeline, "Activity pages");
  let activityRequest = 0;

  async function loadActivity() {
    const request = ++activityRequest;
    timeline.innerHTML = '<div class="empty">Loading activity…</div>';
    try {
      const data = await api(`/player/activity?category=${encodeURIComponent(category.value)}`);
      if (request !== activityRequest) return;
      renderActivityPage(data.activity || [], rows => {
        if (!rows.length) {
          timeline.innerHTML = '<div class="empty">No account activity is recorded yet.</div>';
          return;
        }
        timeline.replaceChildren(...rows.map(item => {
          const article = document.createElement("article");
          article.className = "activity-item";
          article.setAttribute("role", "listitem");
          const title = document.createElement("strong");
          title.textContent = item.title;
          const message = document.createElement("p");
          message.textContent = item.message;
          const meta = document.createElement("small");
          const date = item.created_at ? new Date(item.created_at) : null;
          meta.textContent = date && Number.isFinite(date.getTime())
            ? `${item.category} · ${date.toLocaleString()}`
            : `${item.category} · Date unavailable`;
          article.append(title, message, meta);
          return article;
        }));
      }, category.value);
    } catch (error) {
      if (request !== activityRequest) return;
      renderActivityPage([], () => {});
      timeline.innerHTML = "";
      const message = document.createElement("div");
      message.className = "empty";
      message.textContent = error.message || "Activity could not be loaded.";
      timeline.append(message);
    }
  }

  category.addEventListener("change", loadActivity);
  refresh.addEventListener("click", loadActivity);
  document.addEventListener("securefps:view", event => {
    if (event.detail === "activity") loadActivity();
  });
})();
