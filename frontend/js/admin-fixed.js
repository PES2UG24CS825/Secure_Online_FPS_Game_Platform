const text = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const dateText = (value) => value ? new Date(value).toLocaleString() : "Unknown";

async function loadAdmin() {
  try {
    const me = await api("/auth/me");
    if (me.user.role !== "admin") { window.location.href = "player.html"; return; }
    document.getElementById("adminName").textContent = me.user.name;
    document.getElementById("adminEmail").textContent = me.user.email;
    await Promise.all([loadOverview(), loadPlayers(), loadEvents(), loadMonitoring()]);
  } catch (error) {
    console.error("Admin dashboard failed", error);
    window.location.href = "login.html";
  }
}

async function loadOverview() {
  const data = await api("/admin/overview");
  const summary = data.summary || {};
  document.getElementById("playerCount").textContent = summary.total_players ?? data.players.length;
  document.getElementById("activeSessionCount").textContent = summary.active_sessions ?? 0;
  document.getElementById("matchCount").textContent = summary.matches_analyzed ?? 0;
  document.getElementById("highCount").textContent = summary.high_severity_events ?? 0;
}

async function loadPlayers() {
  const data = await api("/admin/players");
  document.getElementById("players").innerHTML = data.players.map((player) => `<tr><td><strong>${text(player.username)}</strong></td><td>${text(player.email)}</td><td><span class="badge ${player.mfa_status === "Enabled" ? "good" : "warn"}">${text(player.mfa_status)}</span></td><td>${text(player.account_status)}</td><td>${text(player.risk_score)}%</td><td>${dateText(player.created_at)}</td><td><button class="ghost-btn" data-action="view" data-id="${text(player.id)}">View</button> <button class="ghost-btn" data-action="matches" data-id="${text(player.id)}">Matches</button> <button class="ghost-btn" data-action="detections" data-id="${text(player.id)}">Detections</button> <button class="play-btn" data-action="${player.account_status === "suspended" ? "activate" : "suspend"}" data-id="${text(player.id)}">${player.account_status === "suspended" ? "Activate" : "Suspend"}</button></td></tr>`).join("") || '<tr><td colspan="7">No players registered.</td></tr>';
}

async function loadEvents() {
  const severity = document.getElementById("severityFilter").value;
  const data = await api(`/admin/security-events${severity ? `?severity=${encodeURIComponent(severity)}` : ""}`);
  document.getElementById("events").innerHTML = data.events.map((event) => `<tr><td>${dateText(event.timestamp)}</td><td>${text(event.event_type)}</td><td><span class="badge ${event.severity === "high" || event.severity === "critical" ? "bad" : event.severity === "medium" ? "warn" : "good"}">${text(event.severity)}</span></td><td>${text(event.user)}</td><td>${text(event.description)}</td></tr>`).join("") || '<tr><td colspan="5">No security events.</td></tr>';
}

async function loadMonitoring() {
  const data = await api("/admin/game-monitoring");
  document.getElementById("activeGames").textContent = data.active_games.length;
  document.getElementById("suspicionRate").textContent = `${data.average_suspicion_rate}%`;
  document.getElementById("detectionCount").textContent = data.detections;
  document.getElementById("activePlayerCount").textContent = data.active_player_count;
  document.getElementById("supportedGames").innerHTML = data.supported_games.map((game) => `<div class="list-row"><div><strong>${text(game.name)}</strong><div class="muted">${text(game.id)}</div></div><span class="badge good">${text(game.status)}</span></div>`).join("") || '<div class="empty">No supported games.</div>';
  document.getElementById("activeGamesList").innerHTML = data.active_games.map((game) => `<div class="list-row"><div><strong>${text(game.game_id)}</strong><div class="muted">Match ${text(game.match_id)} · Player ${text(game.player_id)}</div></div><span class="badge good">Connected</span></div>`).join("") || '<div class="empty">No active games.</div>';
}

document.getElementById("severityFilter").addEventListener("change", loadEvents);
document.getElementById("players").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (["view", "matches", "detections"].includes(action)) {
    const detail = await api(`/admin/players/${button.dataset.id}`);
    const content = action === "view" ? detail.user : action === "matches" ? detail.gameplay : detail.security.detections;
    window.alert(JSON.stringify(content, null, 2));
    return;
  }
  await api(`/admin/players/${button.dataset.id}/${action}`, { method: "POST" });
  await Promise.all([loadOverview(), loadPlayers(), loadEvents(), loadMonitoring()]);
});
document.getElementById("playerViewBtn").addEventListener("click", () => { window.location.href = "player.html"; });
document.getElementById("logoutBtn").addEventListener("click", async () => { await api("/auth/logout", { method: "POST" }); window.location.href = "login.html"; });
loadAdmin();
