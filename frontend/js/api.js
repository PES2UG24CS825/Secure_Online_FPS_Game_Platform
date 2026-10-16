const API_HOST = window.location.hostname || "127.0.0.1";
const API_BASE = `http://${API_HOST}:5000/api`;
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

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
