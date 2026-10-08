function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function displayNumber(value) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? "N/A" : number.toFixed(3);
}

function displayDate(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "N/A" : date.toLocaleString();
}

function displayRiskScore(value) {
  const score = Number(value);
  return value == null || !Number.isFinite(score) ? "N/A" : `${score.toFixed(1)}/100`;
}

function renderGameplayAlerts(data) {
  const banner = document.getElementById("gameplayAlertBanner");
  const alertList = document.getElementById("gameplayAlerts");
  const incompleteNotice = document.getElementById("analysisIncompleteNotice");
  const alerts = Array.isArray(data.gameplay_alerts) ? data.gameplay_alerts.filter(Boolean) : [];
  const analyses = Array.isArray(data.analyses) ? data.analyses.filter(Boolean) : [];
  const pendingAlerts = alerts.filter((alert) => alert.review_status === "pending");
  const incompleteAnalyses = analyses.filter((analysis) => analysis.status !== "success");

  if (pendingAlerts.length) {
    const hasHigh = pendingAlerts.some((alert) => alert.severity === "high");
    banner.className = `gameplay-alert-banner ${hasHigh ? "high" : "medium"}`;
    banner.innerHTML = `<strong>GAMEPLAY ANOMALY DETECTED</strong><span>A potentially suspicious gameplay session requires admin review. ${pendingAlerts.length} pending alert${pendingAlerts.length === 1 ? "" : "s"}.</span>`;
  } else if (alerts.length) {
    banner.className = "gameplay-alert-banner reviewed";
    banner.textContent = "No pending gameplay alerts. Reviewed alerts remain listed below.";
  } else {
    banner.className = "gameplay-alert-banner clear";
    banner.textContent = "No suspicious gameplay alerts at this time.";
  }

  incompleteNotice.innerHTML = incompleteAnalyses.length
    ? `<div class="gameplay-incomplete-notice">Analysis incomplete — model results unavailable. ${incompleteAnalyses.length} session${incompleteAnalyses.length === 1 ? "" : "s"} need attention.</div>`
    : "";

  alertList.innerHTML = alerts.map((alert) => {
    const severity = ["high", "medium"].includes(alert.severity) ? alert.severity : "unknown";
    const player = alert.player_name || alert.player_id || "N/A";
    return `<article class="gameplay-alert-card ${severity}">
      <h3>${alert.demo ? "REAL-TIME CHEATING ALERT" : "Potentially suspicious gameplay session requires admin review"}</h3>
      ${alert.demo ? `<p>${escapeHtml(player)} — suspicious gameplay detected.</p>` : ""}
      <div class="gameplay-alert-fields">
        <span><strong>Player:</strong> ${escapeHtml(alert.demo ? alert.account_label || player : player)}</span>
        <span><strong>Session:</strong> ${escapeHtml(alert.session_id || "N/A")}</span>
        <span><strong>Risk Score:</strong> ${escapeHtml(displayRiskScore(alert.risk_score))}</span>
        <span><strong>Random Forest:</strong> ${escapeHtml(alert.random_forest || "Unavailable")}</span>
        <span><strong>Isolation Forest:</strong> ${escapeHtml(alert.isolation_forest || "Unavailable")}</span>
        <span><strong>Severity:</strong> ${escapeHtml(severity)}</span>
        <span><strong>Alert time:</strong> ${escapeHtml(displayDate(alert.created_at))}</span>
        <span><strong>Review status:</strong> ${escapeHtml(alert.review_status || "unknown")}</span>
      </div>
    </article>`;
  }).join("") || '<div class="empty">No gameplay alerts.</div>';
}

function renderDemoComparison(data) {
  const banner = document.getElementById("demoComparisonBanner");
  const comparison = document.getElementById("demoSessionComparison");
  const analyses = Array.isArray(data.analyses) ? data.analyses.filter(Boolean) : [];
  const alerts = Array.isArray(data.gameplay_alerts) ? data.gameplay_alerts.filter(Boolean) : [];
  const alertBySession = new Map(alerts.map((alert) => [alert.session_id, alert]));
  const demo = analyses.find((analysis) => analysis.demo === true);
  const normal = analyses.find((analysis) =>
    analysis.demo !== true && analysis.status === "success" && !alertBySession.has(analysis.session_id)
  );
  const demoAlert = demo ? alertBySession.get(demo.session_id) : null;

  if (!demo) {
    banner.className = "gameplay-alert-banner reviewed";
    banner.textContent = "Complete the development fixture to compare its actual model results.";
  } else if (demo.status !== "success") {
    banner.className = "gameplay-alert-banner reviewed";
    banner.textContent = "Analysis incomplete — model results unavailable.";
  } else if (demoAlert) {
    banner.className = `gameplay-alert-banner ${demoAlert.severity === "high" ? "high" : "medium"}`;
    banner.textContent = "GAMEPLAY ANOMALY DETECTED — This session has unusual gameplay behavior and requires admin review.";
  } else {
    banner.className = "gameplay-alert-banner clear";
    banner.textContent = "No alert triggered for this test. The models did not meet the configured alert conditions.";
  }

  const renderSession = (title, analysis, isDemo) => {
    if (!analysis) {
      return `<article class="demo-session-card"><h3>${title}</h3><p class="empty">No matching saved session is available yet.</p></article>`;
    }

    const result = analysis.result || {};
    const raw = analysis.raw_features || {};
    const normalized = analysis.features || {};
    const alert = alertBySession.get(analysis.session_id);
    const complete = analysis.status === "success";
    const player = isDemo
      ? "Development fixture (no player account)"
      : analysis.user_id || "N/A";
    const featureRows = ["accuracy", "fire_rate", "movement_speed", "aim_smoothness", "kdr"]
      .map((feature) => `<div><strong>${escapeHtml(feature)}</strong><span>${displayNumber(raw[feature])} raw / ${displayNumber(normalized[feature])} normalized</span></div>`)
      .join("");

    return `<article class="demo-session-card ${isDemo ? "demo" : "normal"}">
      <h3>${title}</h3>
      <div class="demo-session-meta"><span><strong>Player:</strong> ${escapeHtml(player)}</span><span><strong>Session:</strong> ${escapeHtml(analysis.session_id || "N/A")}</span><span><strong>Status:</strong> ${escapeHtml(analysis.status || "unknown")}</span></div>
      <div class="demo-feature-list">${featureRows}</div>
      <div class="demo-model-results">
        <span><strong>Random Forest:</strong> ${escapeHtml(complete ? result.random_forest || "Unavailable" : "Analysis incomplete")}</span>
        <span><strong>Isolation Forest:</strong> ${escapeHtml(complete ? result.isolation_forest || "Unavailable" : "Analysis incomplete")}</span>
        <span><strong>Risk:</strong> ${escapeHtml(complete ? displayRiskScore(analysis.risk_score ?? result.risk_score) : "N/A")}</span>
        <span><strong>Alert severity:</strong> ${escapeHtml(alert?.severity || "None")}</span>
        <span><strong>Review status:</strong> ${escapeHtml(alert?.review_status || "Not required")}</span>
      </div>
    </article>`;
  };

  comparison.innerHTML = renderSession("Normal-player session", normal, false)
    + renderSession("Cheater-like demo session", demo, true);
}

function renderDemoAccount(data) {
  const panel = document.getElementById("demoAccountPanel");
  const account = data.demo_account;
  if (!account) {
    panel.innerHTML = '<div class="empty">Demo account is not seeded.</div>';
    return;
  }

  const restricted = account.enforcement_state === "restricted";
  const detectionStatus = account.detection_status || "not_evaluated";
  const statusClass = detectionStatus === "success" ? (restricted ? "bad" : "good") : "gray";
  const canReview = account.review_status === "pending";
  const playerId = escapeHtml(account.player_id || "");
  panel.innerHTML = `<div class="demo-account-card">
    <div class="demo-account-heading"><strong>${escapeHtml(account.label || "DEMO CHEATER TEST ACCOUNT")}</strong><span class="badge ${statusClass}">${escapeHtml(restricted ? "restricted" : detectionStatus)}</span></div>
    <div class="demo-account-fields">
      <span><strong>Username:</strong> ${escapeHtml(account.username || "N/A")}</span>
      <span><strong>Account type:</strong> ${escapeHtml(account.account_type || "N/A")}</span>
      <span><strong>Current session:</strong> ${escapeHtml(account.session_id || "None")}</span>
      <span><strong>Gameplay detection:</strong> ${escapeHtml(detectionStatus)}</span>
      <span><strong>Risk score:</strong> ${escapeHtml(displayRiskScore(account.risk_score))}</span>
      <span><strong>Random Forest:</strong> ${escapeHtml(account.random_forest || "Unavailable")}</span>
      <span><strong>Isolation Forest:</strong> ${escapeHtml(account.isolation_forest || "Unavailable")}</span>
      <span><strong>Alert severity:</strong> ${escapeHtml(account.alert_severity || "None")}</span>
      <span><strong>Last evaluation:</strong> ${escapeHtml(displayDate(account.last_evaluation_at))}</span>
      <span><strong>Enforcement:</strong> ${escapeHtml(account.enforcement_action || "none")} (${escapeHtml(account.enforcement_state || "monitoring")})</span>
      <span><strong>Restricted until:</strong> ${escapeHtml(displayDate(account.restricted_until))}</span>
      <span><strong>Review status:</strong> ${escapeHtml(account.review_status || "unknown")}</span>
    </div>
    <div class="demo-account-actions">
      ${canReview ? `<button class="play-btn" type="button" data-demo-action="confirm-demo-alert" data-player-id="${playerId}">Mark alert reviewed</button>` : ""}
      ${restricted ? `<button class="play-btn" type="button" data-demo-action="clear-demo-restriction" data-player-id="${playerId}">Clear temporary restriction</button>` : ""}
    </div>
  </div>`;
}

let adminLoading = false;
let adminHasLoaded = false;
let adminLiveEvents = null;
let adminRefreshTimer = null;
let adminRefreshDebounce = null;

function connectAdminLiveEvents() {
  if (adminLiveEvents || !window.EventSource) return;
  adminLiveEvents = new EventSource(`${window.API_BASE}/live/events`, { withCredentials: true });
  adminLiveEvents.addEventListener("update", () => {
    clearTimeout(adminRefreshDebounce);
    adminRefreshDebounce = setTimeout(loadAdmin, 250);
  });
  adminLiveEvents.onerror = () => {
    const status = document.getElementById("adminLiveStatus");
    if (status) {
      status.className = "status-pill live-disconnected";
      status.innerHTML = '<span class="status-dot"></span>Reconnecting · refresh active';
    }
  };
}

async function loadAdmin() {
  if (adminLoading || document.visibilityState === "hidden") return;
  adminLoading = true;
  const liveStatus = document.getElementById("adminLiveStatus");
  try {
    const me = await api("/auth/me");
    if (me.user.role !== "admin") { window.location.href = "dashboard.html"; return; }
    connectAdminLiveEvents();
    document.getElementById("adminName").textContent = me.user.name;
    document.getElementById("adminEmail").textContent = me.user.email;
    const data = await api("/admin/overview");
    document.getElementById("playerCount").textContent = data.players.length;
    document.getElementById("matchCount").textContent = data.summary?.matches_analyzed ?? data.matches?.length ?? 0;
    document.getElementById("eventCount").textContent = data.events.length;
    document.getElementById("highCount").textContent = data.events.filter((event) => ["high", "critical"].includes(event.severity)).length;
    document.getElementById("loginCount").textContent = data.login_count ?? 0;
    document.getElementById("players").innerHTML = data.players.map((player) => `<tr><td><strong>${escapeHtml(player.name || "Player")}</strong>${player.demo ? '<small>DEMO TEST ACCOUNT</small>' : ""}<small>${escapeHtml(player.email || "")}</small></td><td>${escapeHtml(player.role || "player")}</td><td><span class="badge ${player.mfa_enabled ? "good" : "warn"}">${player.mfa_enabled ? "MFA enabled" : "Disabled"}</span></td><td>${escapeHtml(player.matches_played ?? 0)}</td><td>${escapeHtml(displayRiskScore(player.risk_score))}</td><td>${escapeHtml(player.last_login_ip || "No login recorded")}<small>${escapeHtml(displayDate(player.last_login))}</small></td><td>${escapeHtml(displayDate(player.created_at))}</td><td><button class="play-btn" data-action="revoke" data-id="${escapeHtml(player.id)}">Suspend</button> <button class="play-btn danger-btn" data-action="delete" data-id="${escapeHtml(player.id)}">Delete</button></td></tr>`).join("") || '<tr><td colspan="8">No players registered.</td></tr>';
    document.getElementById("events").innerHTML = data.events.map((event) => `<div class="list-row"><div><strong>${escapeHtml(event.type || "Security event")}</strong><small>${escapeHtml(event.description || displayDate(event.created_at))}</small></div><span class="badge ${["high", "critical"].includes(event.severity) ? "bad" : event.severity === "medium" ? "warn" : "good"}">${escapeHtml(event.severity || "low")}</span></div>`).join("") || '<div class="empty">No security events.</div>';
    document.getElementById("recentLogins").innerHTML = (data.recent_logins || []).map((entry) => `<tr><td>${escapeHtml(entry.player_name)}</td><td>${escapeHtml(entry.ip_address || "Unknown")}</td><td>${escapeHtml(displayDate(entry.timestamp))}</td><td>${escapeHtml(entry.authentication_method || "password+mfa")}</td></tr>`).join("") || '<tr><td colspan="4">No sign-ins recorded yet. New successful sign-ins will appear here.</td></tr>';
    // Show only the five active model inputs, with raw and normalized values side by side.
    const activeFeatures = ["accuracy", "fire_rate", "movement_speed", "aim_smoothness", "kdr"];
    const analyses = Array.isArray(data.analyses) ? data.analyses.filter(Boolean) : [];
    document.getElementById("analyses").innerHTML = analyses.map((analysis) => {
      const raw = analysis.raw_features || {};
      const normalized = analysis.features || {};
      const missing = Array.isArray(analysis.missing_features) ? analysis.missing_features : [];
      const status = analysis.status || "unknown";
      const badge = status === "success" ? "good" : "gray";
      const featureCells = activeFeatures.map((name) => `<td>${displayNumber(raw[name])} / ${displayNumber(normalized[name])}</td>`).join("");
      const rfResult = status === "success" ? analysis.random_forest || "Unavailable" : "Analysis incomplete";
      const ifResult = status === "success" ? analysis.isolation_forest || "Unavailable" : "Analysis incomplete";
      const riskScore = status === "success" ? displayRiskScore(analysis.risk_score) : "N/A";
      return `<tr><td>${escapeHtml(analysis.session_id || "N/A")}<small>${escapeHtml(analysis.user_id || "N/A")}</small></td><td>${escapeHtml(displayDate(analysis.created_at))}</td><td><span class="badge ${badge}">${escapeHtml(status)}</span><small>Missing: ${escapeHtml(missing.join(", ") || "None")}</small></td>${featureCells}<td>${escapeHtml(rfResult)}</td><td>${escapeHtml(ifResult)}</td><td>${escapeHtml(riskScore)}</td></tr>`;
    }).join("") || '<tr><td colspan="11">No analyzed sessions.</td></tr>';
    document.getElementById("allMatches").innerHTML = (data.matches || []).map((match) => `<tr><td>${escapeHtml(match.session_id || "N/A")}</td><td>${escapeHtml(match.player_name || match.player_id || "Unknown player")}</td><td>${escapeHtml(match.game || "FPS Microgame")}</td><td>${escapeHtml(displayDate(match.started_at))}</td><td>${escapeHtml(match.status || "unknown")}</td><td>${escapeHtml(displayRiskScore(match.risk_score))}</td></tr>`).join("") || '<tr><td colspan="6">No game sessions recorded.</td></tr>';
    renderGameplayAlerts(data);
    renderDemoComparison(data);
    renderDemoAccount(data);
    adminHasLoaded = true;
    if (liveStatus) {
      liveStatus.className = "status-pill live-connected";
      liveStatus.innerHTML = `<span class="status-dot"></span>Live · updated ${escapeHtml(new Date().toLocaleTimeString())}`;
    }
  } catch (error) {
    console.error("Admin live refresh failed", error);
    if (error?.status === 401 || error?.status === 403) {
      window.location.href = "login.html";
      return;
    }
    if (liveStatus) {
      liveStatus.className = "status-pill live-disconnected";
      liveStatus.innerHTML = '<span class="status-dot"></span>API or database unavailable';
    }
    ["playerCount", "matchCount", "eventCount", "highCount", "loginCount"].forEach((id) => {
      const metric = document.getElementById(id);
      if (metric && ["—", "Loading"].includes(metric.textContent.trim())) metric.textContent = "Unavailable";
    });
    const unavailableRows = [
      ["players", 8, "Player data unavailable. Check the Flask API and MongoDB."],
      ["recentLogins", 4, "Sign-in history unavailable."],
      ["analyses", 11, "Gameplay analysis unavailable."],
      ["allMatches", 6, "Match history unavailable."]
    ];
    unavailableRows.forEach(([id, columns, message]) => {
      const tableBody = document.getElementById(id);
      if (tableBody && !adminHasLoaded) {
        tableBody.innerHTML = `<tr><td colspan="${columns}">${escapeHtml(message)}</td></tr>`;
      }
    });
    ["events", "gameplayAlerts", "demoAccountPanel", "demoSessionComparison"].forEach((id) => {
      const section = document.getElementById(id);
      if (section && !adminHasLoaded) {
        section.textContent = "Data unavailable. Check the API and database connection.";
      }
    });
  } finally {
    adminLoading = false;
  }
}
const adminSectionLabels = {
  overview: "Admin overview",
  players: "Player accounts",
  security: "Security & access",
  gameplay: "Game monitoring"
};
const adminSectionDescriptions = {
  overview: "Live platform activity and security health.",
  players: "Manage player accounts and review individual risk.",
  security: "Review sign-ins, IP addresses, and security events.",
  gameplay: "Inspect match telemetry and model analysis."
};

function showAdminSection(sectionName, updateHash = false) {
  const section = adminSectionLabels[sectionName] ? sectionName : "overview";
  document.querySelectorAll("[data-admin-view]").forEach((view) => {
    const isActive = view.dataset.adminView === section;
    view.classList.toggle("active", isActive);
    view.setAttribute("aria-hidden", String(!isActive));
  });
  document.querySelectorAll("[data-admin-section]").forEach((button) => {
    const isActive = button.dataset.adminSection === section;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });
  const title = document.getElementById("adminPageTitle");
  if (title) title.textContent = adminSectionLabels[section];
  const subtitle = document.getElementById("adminPageSubtitle");
  if (subtitle) subtitle.textContent = adminSectionDescriptions[section];
  if (updateHash && window.location.hash !== `#${section}`) {
    window.history.replaceState(null, "", `#${section}`);
  }
}

document.getElementById("adminNavigation")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-admin-section]");
  if (button) showAdminSection(button.dataset.adminSection, true);
});
window.addEventListener("hashchange", () => showAdminSection(window.location.hash.slice(1)));
showAdminSection(window.location.hash.slice(1));

document.getElementById("players").addEventListener("click", async (event) => { const button = event.target.closest("button[data-action]"); if (!button) return; await api(`/admin/players/${button.dataset.id}/${button.dataset.action}`, { method: "POST" }); loadAdmin(); });
document.getElementById("playerViewBtn").addEventListener("click", () => { window.location.href = "dashboard.html"; });
document.getElementById("logoutBtn").addEventListener("click", async () => { await api("/auth/logout", { method: "POST" }); window.location.href = "login.html"; });
document.getElementById("refreshAdminBtn").addEventListener("click", loadAdmin);
document.getElementById("demoAccountPanel").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-demo-action]");
  if (!button) return;
  await api(`/admin/players/${button.dataset.playerId}/${button.dataset.demoAction}`, { method: "POST" });
  await loadAdmin();
});
loadAdmin();
// Keep a slower fallback refresh in case the event stream is interrupted.
adminRefreshTimer = setInterval(loadAdmin, 15000);
