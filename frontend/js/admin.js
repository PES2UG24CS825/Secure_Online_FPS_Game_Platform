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

let loginPage = 1;
function renderLoginAudit(rows) {
  const body = document.getElementById("recentLogins");
  const search = (document.getElementById("loginSearch")?.value || "").toLowerCase();
  const result = document.getElementById("loginResultFilter")?.value || "";
  const player = document.getElementById("loginPlayerFilter")?.value || "";
  const date = document.getElementById("loginDateFilter")?.value || "";
  const includeTest = document.getElementById("includeTestData")?.checked;
  const filtered = (rows || []).filter((row) => {
    const text = `${row.player_name} ${row.ip_address} ${row.device}`.toLowerCase();
    const rowDate = row.timestamp ? new Date(row.timestamp).toISOString().slice(0, 10) : "";
    const test = /demo|test|fixture/i.test(row.player_name || "");
    return (includeTest || !test) && (!search || text.includes(search)) && (!player || row.player_name === player) && (!result || row.result === result) && (!date || rowDate === date);
  });
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  loginPage = Math.min(loginPage, pageCount);
  const pageRows = filtered.slice((loginPage - 1) * pageSize, loginPage * pageSize);
  body.innerHTML = pageRows.map((row) => `<tr>
    <td><strong>${escapeHtml(row.player_name)}</strong><small>${escapeHtml(row.player_id || row.reason || "")}</small></td>
    <td><span class="badge ${row.result === "Success" ? "good" : "bad"}">${escapeHtml(row.result)} · ${escapeHtml(row.reason)}</span></td>
    <td title="${escapeHtml(row.device)}">${escapeHtml(row.device)}</td>
    <td>${escapeHtml(row.location)}</td><td>${escapeHtml(row.ip_address)}</td>
    <td>${escapeHtml(displayRiskScore(row.risk_score))}</td><td>${escapeHtml(displayDate(row.timestamp))}</td>
  </tr>`).join("") || '<tr><td colspan="7">No sign-in attempts match these filters.</td></tr>';
  const pagination = document.getElementById("loginPagination");
  if (pagination) pagination.innerHTML = `<button class="ghost-btn" type="button" data-login-page="-1" ${loginPage <= 1 ? "disabled" : ""}>Previous</button><span>Page ${loginPage} of ${pageCount}</span><button class="ghost-btn" type="button" data-login-page="1" ${loginPage >= pageCount ? "disabled" : ""}>Next</button>`;
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
    ? `<div class="gameplay-incomplete-notice">Analysis incomplete — ${escapeHtml(incompleteAnalyses[0].error || (incompleteAnalyses[0].missing_features?.length ? `missing ${incompleteAnalyses[0].missing_features.join(", ")}` : "the model did not return a result"))}. ${incompleteAnalyses.length} session${incompleteAnalyses.length === 1 ? "" : "s"} ${incompleteAnalyses.length === 1 ? "needs" : "need"} attention. <button class="play-btn" type="button" data-retry-analysis="${escapeHtml(incompleteAnalyses[0].session_id || "")}">Retry analysis</button></div>`
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
      ${alert.review_status === "pending" ? `<div class="gameplay-review-actions">
        ${["approve", "warn", "suspend", "ban", "escalate"].map((action) => `<button class="play-btn ${action === "ban" ? "danger-btn" : ""}" type="button" data-review-action="${action}" data-session-id="${escapeHtml(alert.session_id || "")}">${action[0].toUpperCase() + action.slice(1)}</button>`).join("")}
      </div>` : ""}
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
    adminRefreshDebounce = setTimeout(() => {
      loadAdmin();
      if (document.querySelector('[data-admin-view="support"].active')) loadSupportInbox();
    }, 250);
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
    if (!["admin", "moderator", "super_admin"].includes(me.user.role)) { window.location.href = "dashboard.html"; return; }
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
    window.adminLoginRows = data.recent_logins || [];
    const playerFilter = document.getElementById("loginPlayerFilter");
    if (playerFilter) {
      const selected = playerFilter.value;
      playerFilter.innerHTML = '<option value="">All players</option>' + [...new Set(window.adminLoginRows.map((row) => row.player_name))].sort().map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
      playerFilter.value = selected;
    }
    renderLoginAudit(window.adminLoginRows);
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
      const retry = `<button class="play-btn" type="button" data-retry-analysis="${escapeHtml(analysis.session_id || "")}">Retry</button>`;
      const rfResult = status === "success" ? `${escapeHtml(analysis.random_forest || "Unavailable")} · ${escapeHtml(displayNumber(analysis.random_forest_probability))}` : `Analyzing… ${retry}`;
      const ifResult = status === "success" ? `${escapeHtml(analysis.isolation_forest || "Unavailable")} · ${escapeHtml(displayNumber(analysis.isolation_forest_anomaly_score))}` : `Analyzing… ${retry}`;
      const riskScore = status === "success" && analysis.risk_score != null ? `<span class="risk-badge ${Number(analysis.risk_score) >= 75 ? "high" : Number(analysis.risk_score) >= 50 ? "medium" : "low"}">${escapeHtml(displayRiskScore(analysis.risk_score))}</span>` : (analysis.error ? escapeHtml(analysis.error) : `Analyzing… ${retry}`);
      return `<tr><td>${escapeHtml(analysis.session_id || "N/A")}<small>${escapeHtml(analysis.user_id || "N/A")}</small></td><td>${escapeHtml(displayDate(analysis.created_at))}</td><td><span class="badge ${badge}">${escapeHtml(status)}</span><small>Missing: ${escapeHtml(missing.join(", ") || "None")}</small></td>${featureCells}<td>${rfResult}</td><td>${ifResult}</td><td>${riskScore}</td></tr>`;
    }).join("") || '<tr><td colspan="11">No analyzed sessions.</td></tr>';
    document.getElementById("allMatches").innerHTML = (data.matches || []).map((match) => {
      const score = match.risk_score == null ? (match.status === "completed" ? "Analyzing…" : "Not evaluated") : displayRiskScore(match.risk_score);
      return `<tr><td>${escapeHtml(match.session_id || "N/A")}</td><td>${escapeHtml(match.player_name || match.player_id || "Unknown player")}</td><td>${escapeHtml(match.game || "FPS Microgame")}</td><td>${escapeHtml(displayDate(match.started_at))}</td><td>${escapeHtml(match.status || "unknown")}</td><td>${escapeHtml(score)}</td></tr>`;
    }).join("") || '<tr><td colspan="6">No game sessions recorded.</td></tr>';
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
  gameplay: "Game monitoring",
  support: "Player support inbox"
};
const adminSectionDescriptions = {
  overview: "Live platform activity and security health.",
  players: "Manage player accounts and review individual risk.",
  security: "Review sign-ins, IP addresses, and security events.",
  gameplay: "Inspect match telemetry and model analysis.",
  support: "Review player messages and respond to support requests."
};

async function loadSupportInbox() {
  const inbox = document.getElementById("supportTicketInbox");
  if (!inbox) return;
  try {
    const data = await api("/admin/support/tickets");
    const tickets = data.tickets || [];
    inbox.innerHTML = tickets.map((ticket) => `<article class="admin-support-ticket" data-ticket-id="${escapeHtml(ticket.id)}"><header><div><strong>${escapeHtml(ticket.player_name)}</strong><small>${escapeHtml(ticket.player_email)} · ${escapeHtml(ticket.category)} · ${escapeHtml(displayDate(ticket.created_at))}</small></div><span class="badge ${ticket.status === "resolved" ? "good" : ticket.status === "answered" ? "warn" : "gray"}">${escapeHtml(ticket.status)}</span></header><p>${escapeHtml(ticket.message)}</p>${ticket.attachment ? `<button class="play-btn" type="button" data-ticket-action="proof" data-ticket-id="${escapeHtml(ticket.id)}">View image proof · ${escapeHtml(ticket.attachment.name)}</button>` : ""}${ticket.admin_reply ? `<div class="admin-support-reply"><strong>Latest reply</strong><p>${escapeHtml(ticket.admin_reply)}</p></div>` : ""}<label>Reply to player<textarea rows="3" maxlength="3000" data-ticket-reply="${escapeHtml(ticket.id)}" placeholder="Write a helpful reply…">${escapeHtml(ticket.admin_reply || "")}</textarea></label><div class="admin-support-actions"><button class="play-btn" type="button" data-ticket-action="reply" data-ticket-id="${escapeHtml(ticket.id)}">Send reply</button>${ticket.status !== "resolved" ? `<button class="ghost-btn" type="button" data-ticket-action="resolve" data-ticket-id="${escapeHtml(ticket.id)}">Mark resolved</button>` : ""}</div></article>`).join("") || '<div class="empty">No support messages in the queue.</div>';
  } catch (error) {
    inbox.textContent = error.message || "Support inbox could not be loaded.";
  }
}

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
  if (section === "support") loadSupportInbox();
}

document.getElementById("adminNavigation")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-admin-section]");
  if (button) showAdminSection(button.dataset.adminSection, true);
});
window.addEventListener("hashchange", () => showAdminSection(window.location.hash.slice(1)));
showAdminSection(window.location.hash.slice(1));
document.getElementById("refreshSupportInbox")?.addEventListener("click", loadSupportInbox);
document.getElementById("supportTicketInbox")?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-ticket-action]");
  if (!button) return;
  const id = button.dataset.ticketId;
  button.disabled = true;
  try {
    if (button.dataset.ticketAction === "proof") {
      const proof = await api(`/admin/support/tickets/${id}/attachment`);
      const dialog = document.getElementById("supportProofDialog");
      document.getElementById("supportProofImage").src = proof.data_url;
      dialog.showModal();
    } else if (button.dataset.ticketAction === "reply") {
      const reply = document.querySelector(`[data-ticket-reply="${CSS.escape(id)}"]`)?.value || "";
      await api(`/admin/support/tickets/${id}/reply`, { method: "POST", body: JSON.stringify({ reply }) });
      await loadSupportInbox();
    } else if (button.dataset.ticketAction === "resolve") {
      await api(`/admin/support/tickets/${id}/resolve`, { method: "POST" });
      await loadSupportInbox();
    }
  } catch (error) {
    window.showAppAlert(error.message, { title: "Support inbox", tone: "warning" });
  } finally {
    button.disabled = false;
  }
});
document.getElementById("closeSupportProof")?.addEventListener("click", () => document.getElementById("supportProofDialog")?.close());
document.getElementById("supportProofDialog")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

document.getElementById("players").addEventListener("click", async (event) => { const button = event.target.closest("button[data-action]"); if (!button) return; await api(`/admin/players/${button.dataset.id}/${button.dataset.action}`, { method: "POST" }); loadAdmin(); });
document.getElementById("playerViewBtn").addEventListener("click", () => { window.location.href = "dashboard.html"; });
document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST" });
    window.location.href = "login.html";
  } catch (error) {
    window.showAppAlert(error.message || "The server could not end this session. Check the backend connection and try again.", { title: "Could not sign out", tone: "error" });
  }
});
document.getElementById("refreshAdminBtn").addEventListener("click", loadAdmin);
document.getElementById("demoAccountPanel").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-demo-action]");
  if (!button) return;
  await api(`/admin/players/${button.dataset.playerId}/${button.dataset.demoAction}`, { method: "POST" });
  await loadAdmin();
});
let pendingReview = null;
document.getElementById("gameplayAlerts")?.addEventListener("click", async (event) => {
  const retry = event.target.closest("button[data-retry-analysis]");
  if (retry) {
    retry.disabled = true;
    try {
      await api(`/admin/gameplay/analyses/${encodeURIComponent(retry.dataset.retryAnalysis)}/retry`, { method: "POST" });
      await loadAdmin();
    } catch (error) {
      retry.disabled = false;
      window.showAppAlert(error.message || "Retry failed.", { title: "Analysis retry failed", tone: "error" });
    }
    return;
  }
  const button = event.target.closest("button[data-review-action]");
  if (!button) return;
  pendingReview = button;
  document.getElementById("reviewNote").value = "";
  document.getElementById("reviewNotePrompt").textContent = `Add a required note for the ${button.dataset.reviewAction} action.`;
  document.getElementById("reviewNoteDialog").showModal();
  document.getElementById("reviewNote").focus();
});
document.getElementById("reviewNoteForm")?.addEventListener("submit", async (event) => {
  if (event.submitter?.id !== "saveReviewNote" || !pendingReview) return;
  event.preventDefault();
  const note = document.getElementById("reviewNote").value.trim();
  if (!note) {
    document.getElementById("reviewNote").focus();
    return;
  }
  pendingReview.disabled = true;
  try {
    await api(`/admin/gameplay/alerts/${encodeURIComponent(pendingReview.dataset.sessionId)}/review`, {
      method: "POST",
      body: JSON.stringify({ action: pendingReview.dataset.reviewAction, note })
    });
    document.getElementById("reviewNoteDialog").close();
    await loadAdmin();
  } catch (error) {
    pendingReview.disabled = false;
    window.showAppAlert(error.message || "Review action failed.", { title: "Could not save review", tone: "error" });
  } finally {
    pendingReview = null;
  }
});
document.getElementById("analysisIncompleteNotice")?.addEventListener("click", async (event) => {
  const retry = event.target.closest("button[data-retry-analysis]");
  if (!retry) return;
  retry.disabled = true;
  try {
    await api(`/admin/gameplay/analyses/${encodeURIComponent(retry.dataset.retryAnalysis)}/retry`, { method: "POST" });
    await loadAdmin();
  } catch (error) {
    retry.disabled = false;
    window.showAppAlert(error.message || "Retry failed.", { title: "Analysis retry failed", tone: "error" });
  }
});
document.getElementById("analyses")?.addEventListener("click", async (event) => {
  const retry = event.target.closest("button[data-retry-analysis]");
  if (!retry) return;
  retry.disabled = true;
  try {
    await api(`/admin/gameplay/analyses/${encodeURIComponent(retry.dataset.retryAnalysis)}/retry`, { method: "POST" });
    await loadAdmin();
  } catch (error) {
    retry.disabled = false;
    window.showAppAlert(error.message || "Retry failed.", { title: "Analysis retry failed", tone: "error" });
  }
});
["loginSearch", "loginPlayerFilter", "loginResultFilter", "loginDateFilter", "includeTestData"].forEach((id) => {
  document.getElementById(id)?.addEventListener("input", () => {
    loginPage = 1;
    renderLoginAudit(window.adminLoginRows || []);
  });
});
document.getElementById("loginPagination")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-login-page]");
  if (!button) return;
  loginPage += Number(button.dataset.loginPage);
  renderLoginAudit(window.adminLoginRows || []);
});
document.getElementById("refreshLogins")?.addEventListener("click", loadAdmin);
document.getElementById("seedDemoBtn")?.addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try {
    await api("/admin/gameplay/seed-demo", { method: "POST" });
    await loadAdmin();
  } catch (error) {
    window.showAppAlert(error.message || "Demo data could not be seeded.", { title: "Seed demo data failed", tone: "error" });
  } finally {
    event.currentTarget.disabled = false;
  }
});
loadAdmin();
// Keep a slower fallback refresh in case the event stream is interrupted.
adminRefreshTimer = setInterval(() => {
  loadAdmin();
  if (document.querySelector('[data-admin-view="support"].active')) loadSupportInbox();
}, 15000);
