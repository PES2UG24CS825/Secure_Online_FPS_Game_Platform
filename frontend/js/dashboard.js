async function loadDashboard() {
  try {
    const me = await api("/auth/me");
    const user = me.user;
    document.getElementById("welcome").textContent = `Welcome back, ${user.name}`;
    document.getElementById("sideName").textContent = user.name;
    document.getElementById("sideEmail").textContent = user.email;
    document.getElementById("avatar").textContent = user.name.charAt(0).toUpperCase();

    const data = await api("/dashboard");
    document.getElementById("matches").textContent = data.stats.matches_analyzed;
    document.getElementById("alerts").textContent = data.stats.alerts;

    const detections = document.getElementById("detectionsList");
    detections.innerHTML = data.recent_detections.length
      ? data.recent_detections.map(d => {
          const bad = d.rf === "cheater" || d.if === "anomaly";
          const score = d.risk_score == null ? "—" : `${Math.round(d.risk_score * 100)}%`;
          return `<div class="list-row">
            <div><strong>RF:</strong> ${d.rf ?? "not loaded"} &nbsp; <strong>IF:</strong> ${d.if ?? "not loaded"}</div>
            <span class="badge ${bad ? "bad" : "good"}">${bad ? "Review" : "Normal"} · ${score}</span>
          </div>`;
        }).join("")
      : '<div class="empty">No gameplay detections yet.</div>';

    const alerts = document.getElementById("alertsList");
    alerts.innerHTML = data.alerts.length
      ? data.alerts.map(a => `<div class="list-row"><div>${a.type.replaceAll("_", " ")}</div><span class="badge ${a.severity === "high" ? "bad" : "warn"}">${a.severity}</span></div>`).join("")
      : '<div class="empty">No security alerts.</div>';

  } catch (error) {
    window.location.href = "login.html";
  }
}

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" });
  window.location.href = "login.html";
});

document.querySelectorAll(".play-btn[data-game]").forEach(button => {
  button.addEventListener("click", () => {
    const game = button.dataset.game;
    alert(`Unity WebGL integration point: ${game}. Replace this with your Unity build URL.`);
  });
});

document.getElementById("detectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const features = Object.fromEntries(form.entries());
  const resultBox = document.getElementById("detectResult");

  try {
    const result = await api("/detect", {
      method: "POST",
      body: JSON.stringify({ features })
    });

    resultBox.classList.remove("hidden");
    resultBox.innerHTML = `
      <strong>Detection result</strong><br>
      Random Forest: <b>${result.random_forest ?? "model not loaded"}</b><br>
      Isolation Forest: <b>${result.isolation_forest ?? "model not loaded"}</b><br>
      Risk score: <b>${result.risk_score == null ? "—" : Math.round(result.risk_score * 100) + "%"}</b>
    `;
    await loadDashboard();
  } catch (error) {
    resultBox.classList.remove("hidden");
    resultBox.textContent = error.message;
  }
});

loadDashboard();
