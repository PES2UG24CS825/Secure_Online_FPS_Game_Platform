async function loadAdmin() {
  try {
    const me = await api("/auth/me");
    if (me.user.role !== "admin") { window.location.href = "dashboard.html"; return; }
    document.getElementById("adminName").textContent = me.user.name;
    document.getElementById("adminEmail").textContent = me.user.email;
    const data = await api("/admin/overview");
    document.getElementById("playerCount").textContent = data.players.length;
    document.getElementById("eventCount").textContent = data.events.length;
    document.getElementById("highCount").textContent = data.events.filter((event) => event.severity === "high").length;
    document.getElementById("loginCount").textContent = data.login_count;
    document.getElementById("players").innerHTML = data.players.map((player) => `<tr><td><strong>${player.name}</strong><small>${player.email}</small></td><td>${player.role}</td><td><span class="badge good">${player.mfa_enabled ? "MFA enabled" : "Disabled"}</span></td><td>${player.created_at.slice(0, 10)}</td><td><button class="play-btn" data-action="revoke" data-id="${player.id}">Revoke</button> <button class="play-btn danger-btn" data-action="delete" data-id="${player.id}">Delete</button></td></tr>`).join("") || '<tr><td colspan="5">No players registered.</td></tr>';
    document.getElementById("events").innerHTML = data.events.map((event) => `<div class="list-row"><span>${event.type}</span><span class="badge ${event.severity === "high" ? "bad" : "warn"}">${event.severity}</span></div>`).join("") || '<div class="empty">No security events.</div>';
  } catch (error) { window.location.href = "login.html"; }
}
document.getElementById("players").addEventListener("click", async (event) => { const button = event.target.closest("button[data-action]"); if (!button) return; await api(`/admin/players/${button.dataset.id}/${button.dataset.action}`, { method: "POST" }); loadAdmin(); });
document.getElementById("playerViewBtn").addEventListener("click", () => { window.location.href = "dashboard.html"; });
document.getElementById("logoutBtn").addEventListener("click", async () => { await api("/auth/logout", { method: "POST" }); window.location.href = "login.html"; });
loadAdmin();