const API_HOST = window.location.hostname || "127.0.0.1";
const API_BASE = `http://${API_HOST}:5000/api`;
window.API_BASE = API_BASE;
window.text = window.text || ((value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])));
window.dateText = window.dateText || ((value) => value ? new Date(value).toLocaleString() : "Unknown");

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
