(() => {
  const byId = id => document.getElementById(id);
  const navLink = byId("notificationNavLink");
  const badge = byId("notifBadge");
  const history = byId("notificationHistory");
  const historyPage = byId("notifications");
  const category = byId("notificationCategory");
  const unread = byId("notificationsUnread");
  const previous = byId("notificationsPrevious");
  const next = byId("notificationsNext");
  const preferences = byId("notificationPreferences");
  const preferenceStatus = byId("notificationPreferenceStatus");
  const allowedSections = new Set(["security", "fairplay", "support", "matches", "rewards", "games"]);
  const limit = 10;
  let page = 1;
  let version = 0;
  let preferenceLoad;

  function actionButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-btn";
    button.dataset.notificationAction = action;
    button.textContent = label;
    return button;
  }

  function render(notifications) {
    history.replaceChildren();
    if (!notifications.length) {
      history.textContent = "No notifications to show.";
      return;
    }
    for (const note of notifications) {
      const item = document.createElement("article");
      item.className = "notification-item";
      item.dataset.notificationId = note.id;
      item.classList.toggle("notification-unread", !note.read);
      const title = document.createElement("strong");
      title.textContent = note.read ? note.title : `${note.title} · Unread`;
      const time = document.createElement("time");
      const date = new Date(note.created_at || NaN);
      if (Number.isFinite(date.getTime())) {
        time.dateTime = note.created_at;
        time.textContent = date.toLocaleString();
      } else {
        time.textContent = "Date unavailable";
      }
      const message = document.createElement("p");
      message.textContent = note.message;
      const actions = document.createElement("div");
      actions.className = "notification-actions";
      if (allowedSections.has(note.destination)) {
        const link = document.createElement("a");
        link.href = "#" + note.destination;
        link.dataset.notificationAction = "read";
        link.textContent = "Open related page";
        actions.append(link);
      }
      actions.append(actionButton(note.read ? "Mark unread" : "Mark read", note.read ? "unread" : "read"), actionButton("Dismiss", "dismiss"));
      item.append(title, time, message, actions);
      history.append(item);
    }
  }

  window.refreshPlayerNotifications = async () => {
    if (document.hidden) return;
    const request = ++version;
    const viewingHistory = historyPage.classList.contains("player-view-active");
    try {
      const query = new URLSearchParams({ limit, page, category: category.value, status: unread.checked ? "unread" : "" });
      const data = await api(viewingHistory ? `/player/notifications?${query}` : "/player/notifications?limit=1");
      if (request !== version) return;
      badge.textContent = data.unread_count;
      badge.hidden = !data.unread_count;
      navLink.setAttribute("aria-label", data.unread_count ? `Notifications, ${data.unread_count} unread` : "Notifications");
      if (viewingHistory) {
        const pages = Math.max(1, Math.ceil(data.total / limit));
        if (page > pages) {
          page = pages;
          return window.refreshPlayerNotifications();
        }
        render(data.notifications);
        previous.disabled = page === 1;
        next.disabled = page >= pages;
        byId("notificationPage").textContent = `Page ${page} of ${pages}`;
      }
      byId("notificationError").textContent = "";
    } catch (error) {
      if (request === version) byId("notificationError").textContent = error.message || "Notifications unavailable.";
    }
  };

  function loadPreferences() {
    if (preferenceLoad) return preferenceLoad;
    preferenceLoad = api("/player/notifications/preferences").then(data => {
      const fields = byId("notificationPreferenceFields");
      fields.replaceChildren(...Object.entries(data.labels).map(([key, title]) => {
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = key;
        checkbox.checked = data.preferences[key];
        label.append(checkbox, " " + title);
        return label;
      }));
      preferences.querySelector("button").disabled = false;
    }).catch(error => {
      preferenceLoad = null;
      preferenceStatus.textContent = error.message;
    });
    return preferenceLoad;
  }

  historyPage.addEventListener("click", async event => {
    const all = event.target.closest("[data-notification-all]");
    const control = event.target.closest("[data-notification-action]");
    if (!all && !control) return;
    const destination = control?.tagName === "A" ? control.hash : "";
    if (destination) event.preventDefault();
    const body = all ? { mark_all: true } : {
      action: control.dataset.notificationAction,
      notification_ids: [control.closest("[data-notification-id]").dataset.notificationId],
    };
    try {
      await api("/player/notifications/read", { method: "POST", body: JSON.stringify(body) });
      if (destination) window.location.hash = destination;
      window.refreshPlayerNotifications();
    } catch (error) {
      byId("notificationError").textContent = error.message;
    }
  });
  function resetPage() {
    page = 1;
    window.refreshPlayerNotifications();
  }
  category.addEventListener("change", resetPage);
  unread.addEventListener("change", resetPage);
  previous.addEventListener("click", () => { page -= 1; window.refreshPlayerNotifications(); });
  next.addEventListener("click", () => { page += 1; window.refreshPlayerNotifications(); });
  document.addEventListener("securefps:view", event => {
    if (event.detail !== "notifications") return;
    loadPreferences();
    window.refreshPlayerNotifications();
  });
  preferences.addEventListener("submit", async event => {
    event.preventDefault();
    const button = preferences.querySelector("button");
    button.disabled = true;
    try {
      const choices = Object.fromEntries([...preferences.querySelectorAll("input")].map(input => [input.name, input.checked]));
      await api("/player/notifications/preferences", { method: "PUT", body: JSON.stringify(choices) });
      preferenceStatus.textContent = "Preferences saved.";
    } catch (error) {
      preferenceStatus.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
})();
