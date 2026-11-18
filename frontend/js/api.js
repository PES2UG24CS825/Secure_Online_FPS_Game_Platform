const API_BASE = window.APP_CONFIG?.apiBase || `http://${window.location.hostname || "127.0.0.1"}:5000/api`;
window.API_BASE = API_BASE;
window.text = window.text || ((value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])));
window.dateText = window.dateText || ((value) => value ? new Date(value).toLocaleString() : "Unknown");

let appDialogSequence = 0;

function showAppDialog(message, options = {}) {
  const trigger = document.activeElement;
  const dialog = document.createElement("dialog");
  const id = `app-dialog-${++appDialogSequence}`;
  dialog.className = "app-alert-dialog";
  dialog.dataset.tone = options.tone || "info";
  dialog.setAttribute("aria-labelledby", id);
  dialog.setAttribute("aria-describedby", `${id}-message`);
  const form = document.createElement("form");
  form.className = "app-alert-content";
  const title = document.createElement("h2");
  title.className = "app-alert-title";
  title.id = id;
  title.textContent = options.title || "Notice";
  const body = document.createElement("p");
  body.className = "app-alert-message";
  body.id = `${id}-message`;
  body.textContent = String(message ?? "");
  form.append(title, body);

  let field;
  if (options.input || options.requireName) {
    const label = document.createElement("label");
    label.className = "app-dialog-field";
    label.textContent = options.requireName ? `Type ${options.requireName} to confirm` : options.input.label;
    field = document.createElement("input");
    field.type = options.input?.type || "text";
    field.autocomplete = field.type === "password" ? "current-password" : "off";
    field.required = true;
    label.append(field);
    form.append(label);
  }

  const actions = document.createElement("div");
  actions.className = "app-alert-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost-btn";
  cancel.textContent = "Cancel";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary-btn";
  submit.textContent = options.confirmText || (options.cancelable ? "Confirm" : "Got it");
  if (options.cancelable) actions.append(cancel);
  actions.append(submit);
  form.append(actions);
  dialog.append(form);

  return new Promise(resolve => {
    function finish(result) {
      if (!dialog.open) return;
      if (field) field.value = "";
      dialog.close();
      dialog.remove();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      resolve(result);
    }
    if (options.requireName) {
      submit.disabled = true;
      field.addEventListener("input", () => {
        submit.disabled = field.value.trim() !== options.requireName;
      });
    }
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!submit.disabled) finish(options.input ? field.value : true);
    });
    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener("click", event => {
      if (event.target === dialog) finish(null);
    });
    document.body.append(dialog);
    dialog.showModal();
    (field || (options.cancelable ? cancel : submit)).focus();
  });
}

window.showAppAlert = (message, options = {}) => showAppDialog(message, options);
window.showAppConfirm = (message, options = {}) =>
  showAppDialog(message, { title: "Confirm action", tone: "warning", ...options, cancelable: true });
window.showAppPrompt = (message, options = {}) =>
  showAppDialog(message, {
    title: "Provide details", ...options, cancelable: true,
    input: { label: options.label || "Response", type: options.type || "text" },
  });

let appToastRegion = null;

window.showAppToast = function (message, tone = "info") {
  if (!appToastRegion?.isConnected) {
    appToastRegion = document.createElement("div");
    appToastRegion.className = "app-toast-region";
    appToastRegion.setAttribute("role", "status");
    appToastRegion.setAttribute("aria-live", "polite");
    appToastRegion.setAttribute("aria-relevant", "additions");
    document.body.append(appToastRegion);
  }
  const toast = document.createElement("div");
  toast.className = "app-toast";
  toast.dataset.tone = tone;
  toast.textContent = String(message ?? "");
  appToastRegion.append(toast);
  window.setTimeout(() => {
    toast.remove();
    if (appToastRegion?.isConnected && !appToastRegion.childElementCount) {
      appToastRegion.remove();
      appToastRegion = null;
    }
  }, 3200);
};

async function api(path, options = {}) {
  let response;
  try {
    const headers = {
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": "securefps-csrf",
      ...(options.headers || {})
    };
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
