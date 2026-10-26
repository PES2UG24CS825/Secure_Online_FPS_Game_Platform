const API_BASE = window.APP_CONFIG?.apiBase || `http://${window.location.hostname || "127.0.0.1"}:5000/api`;
window.API_BASE = API_BASE;
window.text = window.text || ((value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])));
window.dateText = window.dateText || ((value) => value ? new Date(value).toLocaleString() : "Unknown");

window.showAppAlert = function (message, options = {}) {
  const dialog = document.createElement("dialog");
  dialog.className = "app-alert-dialog";
  dialog.dataset.tone = options.tone || "info";

  const content = document.createElement("div");
  content.className = "app-alert-content";
  const heading = document.createElement("div");
  heading.className = "app-alert-heading";
  const icon = document.createElement("span");
  icon.className = "app-alert-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = options.tone === "error" ? "!" : options.tone === "warning" ? "!" : "i";
  const title = document.createElement("h2");
  title.className = "app-alert-title";
  title.textContent = options.title || (options.tone === "error" ? "Action needed" : "Notice");
  heading.append(icon, title);

  const body = document.createElement("p");
  body.className = "app-alert-message";
  body.textContent = String(message ?? "");
  const actions = document.createElement("div");
  actions.className = "app-alert-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Got it";
  button.addEventListener("click", () => dialog.close());
  actions.append(button);
  content.append(heading, body, actions);
  dialog.append(content);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  button.focus();
};

window.showAppConfirm = function (message, options = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "app-alert-dialog";
    dialog.dataset.tone = options.tone || "warning";
    const content = document.createElement("div");
    content.className = "app-alert-content";
    const title = document.createElement("h2");
    title.className = "app-alert-title";
    title.textContent = options.title || "Confirm action";
    const body = document.createElement("p");
    body.className = "app-alert-message";
    body.textContent = String(message ?? "");
    const verification = options.requireName ? document.createElement("input") : null;
    if (verification) {
      verification.type = "text";
      verification.className = "confirm-name-input";
      verification.placeholder = `Type ${options.requireName} to confirm`;
      verification.setAttribute("aria-label", `Type ${options.requireName} to confirm deletion`);
    }
    const actions = document.createElement("div");
    actions.className = "app-alert-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost-btn";
    cancel.textContent = "Cancel";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "primary-btn";
    confirm.textContent = options.confirmText || "Confirm";
    if (verification) {
      confirm.disabled = true;
      verification.addEventListener("input", () => {
        confirm.disabled = verification.value.trim() !== options.requireName;
      });
    }
    const finish = (value) => {
      dialog.close();
      resolve(value);
    };
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    actions.append(cancel, confirm);
    content.append(title, body);
    if (verification) content.append(verification);
    content.append(actions);
    dialog.append(content);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(false);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    confirm.focus();
  });
};

window.showAppToast = function (message, tone = "info") {
  const toast = document.createElement("div");
  toast.className = "app-toast";
  toast.dataset.tone = tone;
  toast.setAttribute("role", "status");
  toast.textContent = String(message ?? "");
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 3200);
};

async function api(path, options = {}) {
  let response;
  try {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers
    });
  } catch (error) {
    throw new Error(`Cannot connect to the backend at ${API_BASE}. Start the backend and try again.`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
