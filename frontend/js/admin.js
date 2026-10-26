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

function hackerReason(profile) {
  return {
    aimbot: "Aimbot pattern: near-zero aim corrections with highly consistent target hits.",
    wallhack: "Wallhack pattern: enemy hits and tracking were recorded without line of sight.",
    speedhack: "Speedhack pattern: movement speed and teleport jumps exceeded game limits.",
    silent_aim: "Silent-aim pattern: hits registered while the crosshair was off target."
  }[profile] || "Cheat-specific gameplay pattern detected.";
}

function uniqueSessionRows(rows) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row?.session_id) return false;
    if (seen.has(row.session_id)) return false;
    seen.add(row.session_id);
    return true;
  });
}

let loginPage = 1;
let playersPage = 1;
const playersPageSize = 20;
let adminOverviewPlayers = [];

function renderPlayersLoading() {
  const body = document.getElementById("players");
  if (body) body.innerHTML = Array.from({ length: 5 }, () => '<tr class="loading-skeleton"><td colspan="8"><span></span></td></tr>').join("");
}

async function loadPlayers() {
  const body = document.getElementById("players");
  if (!body) return;
  body.setAttribute("aria-busy", "true");
  renderPlayersLoading();
  const search = document.getElementById("playerSearch")?.value.trim() || "";
  const params = new URLSearchParams({
    limit: String(playersPageSize),
    offset: String((playersPage - 1) * playersPageSize)
  });
  if (search) params.set("search", search);
  try {
    const data = await api(`/admin/players?${params.toString()}`);
    const players = Array.isArray(data.players) ? data.players : [];
    body.innerHTML = players.map((player) => {
      const isHacker = ["aimbot", "wallhack", "speedhack", "silent_aim"].includes(player.hacker_profile);
      const isNormalDemo = player.account_type === "demo_normal";
      const suspended = ["suspended", "banned"].includes(player.account_status);
      const actions = window.adminRole === "moderator"
        ? '<span class="muted">Read only</span>'
        : `<button class="play-btn" data-action="${suspended ? "restore" : "revoke"}" data-id="${escapeHtml(player.id)}" data-player-name="${escapeHtml(player.name || "Player")}">${suspended ? "Restore" : "Suspend"}</button> <button class="play-btn danger-btn" data-action="delete" data-id="${escapeHtml(player.id)}" data-player-name="${escapeHtml(player.name || "Player")}">Delete</button>`;
      const status = suspended
        ? `<span class="badge bad">${escapeHtml(player.account_status || "suspended")}</span>`
        : isHacker
          ? '<span class="badge warn">active</span>'
          : isNormalDemo
            ? '<span class="badge good">active</span>'
          : "";
      const marker = isHacker
        ? `<small class="hacker-player-label">HACKER DEMO · ${escapeHtml(player.hacker_profile)}</small>`
        : isNormalDemo ? '<small>NORMAL DEMO PLAYER</small>' : (player.demo ? '<small>DEMO TEST ACCOUNT</small>' : "");
      return `<tr class="${isHacker ? "hacker-player-row" : ""}"><td><strong>${escapeHtml(player.name || "Player")}</strong>${marker}<small>${escapeHtml(player.email || "")}</small></td><td>${escapeHtml(player.role || "player")}</td><td><span class="badge ${player.mfa_enabled ? "good" : "warn"}">${player.mfa_enabled ? "MFA enabled" : "Disabled"}</span>${status}</td><td>${escapeHtml(player.matches_played ?? 0)}</td><td>${escapeHtml(displayRiskScore(player.risk_score))}</td><td>${escapeHtml(player.last_login_ip || "No login recorded")}<small>${escapeHtml(displayDate(player.last_login))}</small></td><td>${escapeHtml(displayDate(player.created_at))}</td><td>${actions}</td></tr>`;
    }).join("") || '<tr><td colspan="8" class="empty-state">No genuine player accounts found yet.</td></tr>';
    const total = Number(data.total ?? data.total_players ?? data.count ?? players.length);
    const pageCount = Math.max(1, Math.ceil(total / playersPageSize));
    playersPage = Math.min(playersPage, pageCount);
    const pagination = document.getElementById("playersPagination");
    if (pagination) pagination.innerHTML = `<button class="ghost-btn" type="button" data-players-page="-1" ${playersPage <= 1 ? "disabled" : ""}>Previous</button><span>Page ${playersPage} of ${pageCount}</span><button class="ghost-btn" type="button" data-players-page="1" ${playersPage >= pageCount || players.length < playersPageSize ? "disabled" : ""}>Next</button>`;
  } catch (error) {
    body.innerHTML = `<tr><td colspan="8" class="empty-state"><strong>Player accounts unavailable</strong><span>${escapeHtml(error.message || "Player data could not be loaded.")}</span></td></tr>`;
    const pagination = document.getElementById("playersPagination");
    if (pagination) pagination.textContent = "";
  } finally {
    body.setAttribute("aria-busy", "false");
  }
}
function renderLoginAudit(rows) {
  const body = document.getElementById("recentLogins");
  const search = (document.getElementById("loginSearch")?.value || "").toLowerCase();
  const result = document.getElementById("loginResultFilter")?.value || "";
  const player = document.getElementById("loginPlayerFilter")?.value || "";
  const date = document.getElementById("loginDateFilter")?.value || "";
  const includeTest = document.getElementById("includeTestData")?.checked;
  const filtered = (rows || []).filter((row) => {
    const text = `${row.player_name || "Unknown account"} ${row.ip_address || ""} ${row.device || ""}`.toLowerCase();
    const rowDate = row.timestamp ? new Date(row.timestamp).toISOString().slice(0, 10) : "";
    const test = /demo|test|fixture/i.test(row.player_name || "");
    return (includeTest || !test) && (!search || text.includes(search)) && (!player || row.player_name === player) && (!result || row.result === result) && (!date || rowDate === date);
  });
  // Brute-force attempts against unknown accounts are useful audit data, but
  // rendering every retry as a separate row can bury successful sign-ins.
  // Group only same-source attempts that happened within a five-minute window.
  const compactRows = [];
  const unknownAttempts = new Map();
  filtered.forEach((row) => {
    if (row.result !== "Failed" || row.reason !== "unknown_account") {
      compactRows.push(row);
      return;
    }
    const time = new Date(row.timestamp).getTime();
    const source = `${row.ip_address || "unknown"}|${row.device || "unknown"}`;
    const bucket = Number.isFinite(time) ? Math.floor(time / 300000) : row.timestamp || "unknown";
    const key = `${source}|${bucket}`;
    const existing = unknownAttempts.get(key);
    if (existing) {
      existing.attempt_count += 1;
      if (time > new Date(existing.timestamp).getTime()) existing.timestamp = row.timestamp;
      return;
    }
    const grouped = { ...row, attempt_count: 1 };
    unknownAttempts.set(key, grouped);
    compactRows.push(grouped);
  });
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(compactRows.length / pageSize));
  loginPage = Math.min(loginPage, pageCount);
  const pageRows = compactRows.slice((loginPage - 1) * pageSize, loginPage * pageSize);
  body.innerHTML = pageRows.map((row) => `<tr>
    <td><strong>${escapeHtml(row.player_name || "Unknown account")}</strong>${row.attempt_count > 1 ? `<small>${row.attempt_count} attempts in a 5-minute window</small>` : ""}</td>
    <td><span class="badge ${row.result === "Success" ? "good" : "bad"} admin-login-result">${escapeHtml(row.result)} · ${escapeHtml(row.reason)}</span></td>
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
  const analyses = uniqueSessionRows(data.analyses);
  const seenSessions = new Set();
  const uniqueAlerts = alerts.filter((alert) => {
    const key = alert.session_id || `${alert.player_id || alert.player_name}:${alert.created_at || "unknown"}`;
    if (seenSessions.has(key)) return false;
    seenSessions.add(key);
    return true;
  });
  if (hackerDemoAwaitingBan) {
    uniqueAlerts
      .filter((alert) => alert.permanent_ban === true && alert.demo === true)
      .forEach((alert) => {
        const key = alert.session_id || `${alert.player_id || alert.player_name}:${alert.created_at || "unknown"}`;
        if (hackerDemoNotifiedBans.has(key)) return;
        hackerDemoNotifiedBans.add(key);
        const profile = alert.hacker_profile || "hacker";
        const player = alert.player_name || `Hacker ${profile}`;
        const risk = displayRiskScore(alert.risk_score);
        const reason = alert.detection_reason || hackerReason(profile);
        window.showAppToast(
          `Cheater auto-banned\n${player} (risk ${risk})\n${profile} · ${reason}`,
          "critical"
        );
      });
  }
  const pendingAlerts = uniqueAlerts.filter((alert) => alert.review_status === "pending");
  const incompleteAnalyses = analyses.filter((analysis) => analysis.status !== "success" && analysis.session_id);
  window.adminIncompleteSessions = [...new Set(incompleteAnalyses.map((analysis) => analysis.session_id))];
  const retryAllButton = document.getElementById("retryAnalysesBtn");
  if (retryAllButton) retryAllButton.title = window.adminIncompleteSessions.length
    ? `Retry ${window.adminIncompleteSessions.length} incomplete analysis session(s)`
    : "There are no incomplete analyses right now";

  if (pendingAlerts.length) {
    const hasHigh = pendingAlerts.some((alert) => alert.severity === "high");
    banner.className = `gameplay-alert-banner ${hasHigh ? "high" : "medium"}`;
    banner.innerHTML = `<strong>GAMEPLAY ANOMALY DETECTED</strong><span>A potentially suspicious gameplay session requires admin review. ${pendingAlerts.length} pending alert${pendingAlerts.length === 1 ? "" : "s"}.</span>`;
  } else if (uniqueAlerts.length) {
    banner.className = "gameplay-alert-banner reviewed";
    banner.textContent = "No pending gameplay alerts. Reviewed alerts remain listed below.";
  } else {
    banner.className = "gameplay-alert-banner clear";
    banner.textContent = "No suspicious gameplay alerts at this time.";
  }

  incompleteNotice.innerHTML = incompleteAnalyses.length
    ? `<div class="gameplay-incomplete-notice"><span>Analysis incomplete — ${escapeHtml(incompleteAnalyses[0].error || (incompleteAnalyses[0].missing_features?.length ? `missing ${incompleteAnalyses[0].missing_features.join(", ")}` : "the model did not return a result"))}. ${incompleteAnalyses.length} session${incompleteAnalyses.length === 1 ? "" : "s"} ${incompleteAnalyses.length === 1 ? "needs" : "need"} attention. Use Retry analyses above.</span></div>`
    : "";

  alertList.innerHTML = uniqueAlerts.map((alert) => {
    const hackerAlert = Boolean(
      alert.hacker_profile
      || /^Hacker (Aimbot|Wallhack|Speed|Silent Aim)$/i.test(alert.player_name || "")
    );
    const resolvedProfile = alert.hacker_profile || ({
      "hacker aimbot": "aimbot",
      "hacker wallhack": "wallhack",
      "hacker speed": "speedhack",
      "hacker silent aim": "silent_aim"
    }[(alert.player_name || "").toLowerCase()]);
    const permanentlyBanned = alert.permanent_ban === true || hackerAlert;
    const severity = permanentlyBanned ? "critical" : (["high", "medium"].includes(alert.severity) ? alert.severity : "unknown");
    const player = alert.player_name || alert.player_id || "N/A";
    return `<article class="gameplay-alert-card ${severity}">
      <h3>${permanentlyBanned ? "CHEATER AUTO-BANNED" : alert.demo ? "REAL-TIME CHEATING ALERT" : "Potentially suspicious gameplay session requires admin review"}</h3>
      ${hackerAlert || alert.demo ? `<p>${escapeHtml(player)} — ${escapeHtml(alert.detection_reason || (resolvedProfile ? hackerReason(resolvedProfile) : "suspicious gameplay detected."))}</p>` : ""}
      <div class="gameplay-alert-fields">
        <span><strong>Player:</strong> ${escapeHtml(player)}</span>
        <span><strong>Session:</strong> ${escapeHtml(alert.session_id || "N/A")}</span>
        <span><strong>Risk Score:</strong> ${escapeHtml(displayRiskScore(alert.risk_score))}</span>
        ${permanentlyBanned ? `<span class="permanent-ban-badge">PERMANENTLY BANNED</span>` : ""}
        ${resolvedProfile ? `<span><strong>Profile:</strong> ${escapeHtml(resolvedProfile)}</span>` : ""}
        ${(alert.detection_reason || resolvedProfile) ? `<span><strong>Why detected:</strong> ${escapeHtml(alert.detection_reason || hackerReason(resolvedProfile))}</span>` : ""}
        <span><strong>Random Forest:</strong> ${escapeHtml(alert.random_forest || "Unavailable")}</span>
        <span><strong>Isolation Forest:</strong> ${escapeHtml(alert.isolation_forest || "Unavailable")}</span>
        ${permanentlyBanned && alert.top_reasons?.length ? `<span><strong>Top reasons:</strong> ${escapeHtml(alert.top_reasons.join("; "))}</span>` : ""}
        <span><strong>Severity:</strong> ${escapeHtml(severity)}</span>
        <span><strong>Alert time:</strong> ${escapeHtml(displayDate(alert.created_at))}</span>
        <span><strong>${permanentlyBanned ? "Ban time" : "Review status"}:</strong> ${escapeHtml(permanentlyBanned ? displayDate(alert.banned_at) : alert.review_status || "unknown")}</span>
      </div>
      ${!hackerAlert && alert.review_status === "pending" && alert.session_id ? `<div class="gameplay-review-actions">
        ${["approve", "warn", ...(window.adminRole === "moderator" ? [] : ["suspend", "ban"])].map((action) => {
          const descriptions = {
            approve: "Mark reviewed without changing the player account.",
            warn: "Send a security warning the player can see.",
            suspend: "Block this player from signing in until restored.",
            ban: "Choose a 24-hour, 7-day, or permanent ban."
          };
          return `<button class="play-btn ${action === "ban" ? "danger-btn" : ""}" type="button" title="${descriptions[action]}" aria-label="${action[0].toUpperCase() + action.slice(1)} alert for ${escapeHtml(player)}. ${descriptions[action]}" data-review-action="${action}" data-session-id="${escapeHtml(alert.session_id)}">${action[0].toUpperCase() + action.slice(1)}</button>`;
        }).join("")}
      </div>` : ""}
    </article>`;
  }).join("") || '<div class="empty">No gameplay alerts.</div>';
}

function renderBannedAccounts(data) {
  const list = document.getElementById("bannedAccountsList");
  const count = document.getElementById("bannedAccountCount");
  if (!list || !count) return;
  const accounts = Array.isArray(data.banned_accounts)
    ? data.banned_accounts
    : (Array.isArray(data.hacker_accounts) ? data.hacker_accounts : [])
      .filter((account) => account.account_status === "banned" || account.revoked === true)
      .map((account) => ({
        ...account,
        status: ["banned", "suspended"].includes(account.account_status) ? account.account_status : "banned",
        reason: account.ban_reason || [],
      }));
  count.textContent = `${accounts.length} account${accounts.length === 1 ? "" : "s"}`;
  list.innerHTML = accounts.map((account) => {
    const reasons = Array.isArray(account.reason) ? account.reason.join("; ") : account.reason;
    return `<article class="list-row banned-account-row">
      <div class="banned-account-identity"><strong>${escapeHtml(account.name || "Player")}</strong><span>${escapeHtml(account.email || "")}</span><small>${escapeHtml(account.hacker_profile || "player")} · ${escapeHtml(displayDate(account.banned_at))}</small></div>
      <p class="banned-account-reason">${reasons ? escapeHtml(reasons) : "No reason recorded."}</p>
      <span class="badge bad">${escapeHtml((account.status || "banned").toUpperCase())}</span>
    </article>`;
  }).join("") || '<div class="empty">No banned or suspended accounts.</div>';
}

const expandedHonourPlayers = new Set();
let honourReportCache = [];

function renderHonourReport(rows) {
  const body = document.getElementById("honourReportRows");
  if (!body) return;
  honourReportCache = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  honourReportCache.forEach((row) => {
    const key = String(row.player_id || row.player_name || "unknown-player");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  body.innerHTML = [...groups.entries()].map(([key, playerRows]) => {
    const latest = playerRows[0];
    const totalChange = playerRows.reduce((total, row) => total + Number(row.honour_change || 0), 0);
    const isExpanded = expandedHonourPlayers.has(key);
    const changeLabel = `${totalChange > 0 ? "+" : ""}${totalChange}`;
    const changeTone = totalChange > 0 ? "good" : totalChange < 0 ? "warn" : "gray";
    const parsedScore = latest.current_score == null ? null : Number(latest.current_score);
    const score = Number.isFinite(parsedScore) ? Math.max(0, Math.min(100, parsedScore)) : null;
    const scoreTone = score === null ? "bad" : score >= 80 ? "good" : score >= 60 ? "warn" : score >= 40 ? "medium" : "bad";
    const scoreCell = score === null
      ? "—"
      : `<div class="honour-score-meter" data-level="${scoreTone}" role="meter" aria-label="${escapeHtml(latest.player_name || "Player")} Honour score" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}"><strong>${score}/100</strong><div class="honour-score-track"><span style="width:${score}%"></span></div><div class="honour-score-ticks" aria-hidden="true"><span>0</span><span>20</span><span>40</span><span>60</span><span>80</span><span>100</span></div></div>`;
    const disclosureIcon = isExpanded
      ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 12 5-5 5 5"/></svg>'
      : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg>';
    const summary = `<tr class="honour-player-summary">
      <td><div class="honour-player-cell"><button class="honour-group-toggle" type="button" data-honour-toggle="${escapeHtml(key)}" aria-expanded="${isExpanded}" aria-label="${isExpanded ? "Collapse" : "Expand"} Honour history for ${escapeHtml(latest.player_name || "player")}">${disclosureIcon}</button><strong>${escapeHtml(latest.player_name || "Unknown player")}</strong></div></td>
      <td>${playerRows.length} recorded update${playerRows.length === 1 ? "" : "s"}</td>
      <td>${escapeHtml(latest.session_id || "—")}</td>
      <td><span class="badge ${changeTone}">${escapeHtml(changeLabel)} Honour</span></td>
      <td>${scoreCell}</td>
      <td>${escapeHtml(latest.access_status || "Available")}</td>
      <td>${escapeHtml(displayDate(latest.created_at))}</td>
    </tr>`;
    if (!isExpanded) return summary;
    const details = playerRows.map((row) => {
      const change = Number(row.honour_change || 0);
      const rowChange = `${change > 0 ? "+" : ""}${change}`;
      const rowTone = change > 0 ? "good" : change < 0 ? "warn" : "gray";
      const before = row.honour_before == null ? "—" : row.honour_before;
      const after = row.honour_after == null ? "—" : row.honour_after;
      return `<tr class="honour-player-detail">
        <td></td><td>${escapeHtml(row.result || "Honour update")}</td>
        <td>${escapeHtml(row.session_id || "—")}</td>
        <td><span class="badge ${rowTone}">${escapeHtml(rowChange)} Honour</span></td>
        <td>${escapeHtml(String(before))} → ${escapeHtml(String(after))}</td>
        <td>${escapeHtml(row.access_status || "Available")}</td>
        <td>${escapeHtml(displayDate(row.created_at))}</td>
      </tr>`;
    }).join("");
    return summary + details;
  }).join("") || '<tr><td colspan="7">No Honour changes recorded yet.</td></tr>';
}

function renderDemoComparison(data) {
  const banner = document.getElementById("demoComparisonBanner");
  const comparison = document.getElementById("demoSessionComparison");
  const analyses = uniqueSessionRows(data.analyses);
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
    const matchedPlayer = (Array.isArray(data.players) ? data.players : [])
      .find((item) => item.id === analysis.user_id);
    const player = matchedPlayer
      ? `${matchedPlayer.name || matchedPlayer.email || "Player"}${matchedPlayer.hacker_profile ? ` · ${matchedPlayer.hacker_profile}` : ""} (${matchedPlayer.email || ""})`
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

function renderHackerAccounts(data) {
  const panel = document.getElementById("hackerAccountsPanel");
  if (!panel) return;
  const accounts = Array.isArray(data.hacker_accounts) ? data.hacker_accounts : [];
  const hackerAccounts = accounts.filter((account) => account.hacker_profile);
  const bannedHackerAccounts = hackerAccounts.filter((account) =>
    account.account_status === "banned" || account.revoked === true
  );
  if (hackerDemoAwaitingBan && hackerAccounts.length >= 4 && bannedHackerAccounts.length >= 4) {
    hackerDemoAwaitingBan = false;
    clearInterval(hackerDemoPollTimer);
    clearTimeout(hackerDemoCompletionTimer);
  }
  const normalPlayers = (Array.isArray(data.players) ? data.players : [])
    .filter((player) => player.account_type === "demo_normal");
  if (!accounts.length && !normalPlayers.length) {
    panel.innerHTML = '<div class="empty">No demo accounts yet. Run the full demo to add the normal players and hacker accounts.</div>';
    return;
  }
  const normalCards = normalPlayers.map((player) => `<article class="demo-account-card hacker-account-card">
    <div class="demo-account-heading"><strong>${escapeHtml(player.name || player.email || "Demo player")}</strong><span class="badge good">NORMAL PLAYER</span></div>
    <div class="demo-account-fields">
      <span><strong>Email:</strong> ${escapeHtml(player.email || "—")}</span>
      <span><strong>Matches:</strong> ${escapeHtml(String(player.matches_played || 0))}</span>
      <span><strong>MFA:</strong> ${player.mfa_enabled ? "enabled" : "disabled"}</span>
      <span><strong>Account status:</strong> ${escapeHtml(player.account_status || "active")}</span>
    </div>
  </article>`).join("");
  const hackerCards = accounts.map((account) => {
    const banned = account.account_status === "banned" || account.revoked;
    return `<article class="demo-account-card hacker-account-card">
      <div class="demo-account-heading"><strong>${escapeHtml(account.email || account.name)}</strong><span class="badge ${banned ? "bad" : "good"}">${banned ? "PERMANENTLY BANNED" : "READY"}</span></div>
      <div class="demo-account-fields">
        <span><strong>Profile:</strong> ${escapeHtml(account.hacker_profile || "unknown")}</span>
        <span><strong>Matches:</strong> ${escapeHtml(String(account.matches || 0))}</span>
        <span><strong>Latest match:</strong> ${escapeHtml(account.latest_session_status || "none")}</span>
        <span><strong>Account status:</strong> ${escapeHtml(account.account_status || "active")}</span>
      </div>
    </article>`;
  }).join("");
  panel.innerHTML = `<div class="hacker-account-grid">${normalCards}${hackerCards}</div>`;
}

let adminLoading = false;
let adminRefreshQueued = false;
let adminHasLoaded = false;
let adminLiveEvents = null;
let adminRefreshTimer = null;
let adminRefreshDebounce = null;
let hackerDemoPollTimer = null;
let hackerDemoCompletionTimer = null;
let hackerDemoAwaitingBan = false;
const hackerDemoNotifiedBans = new Set();

function connectAdminLiveEvents() {
  if (adminLiveEvents || !window.EventSource) return;
  adminLiveEvents = new EventSource(`${window.API_BASE}/live/events`, { withCredentials: true });
  adminLiveEvents.onopen = () => {
    const status = document.getElementById("adminLiveStatus");
    if (status) {
      status.className = "status-pill live-connected";
      status.innerHTML = '<span class="status-dot"></span>Live · connected';
    }
  };
  adminLiveEvents.addEventListener("ready", () => {
    const status = document.getElementById("adminLiveStatus");
    if (status) {
      status.className = "status-pill live-connected";
      status.innerHTML = '<span class="status-dot"></span>Live · ready';
    }
  });
  adminLiveEvents.addEventListener("update", (event) => {
    try {
      const update = JSON.parse(event.data || "{}");
      if (update.type === "match_abandoned") {
        window.showAppToast?.(`${update.player_name || "A player"} left an unfinished match. Honour: ${update.honour_score ?? "—"}/100. Matchmaking remains available.`, "warning");
      }
    } catch (_) {}
    clearTimeout(adminRefreshDebounce);
    adminRefreshDebounce = setTimeout(() => {
      loadAdmin(true);
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

async function loadAdmin(force = false) {
  if (document.visibilityState === "hidden") return;
  if (adminLoading) {
    if (force) adminRefreshQueued = true;
    return;
  }
  adminLoading = true;
  const liveStatus = document.getElementById("adminLiveStatus");
  try {
    const me = await api("/auth/me");
    if (!["admin", "moderator", "super_admin"].includes(me.user.role)) { window.location.href = "player.html"; return; }
    window.adminRole = me.user.role;
    connectAdminLiveEvents();
    document.getElementById("adminName").textContent = me.user.name;
    document.getElementById("adminEmail").textContent = me.user.email;
    const data = await api("/admin/overview");
    const demoControls = document.getElementById("hackerDemoControls");
    if (demoControls) demoControls.hidden = data.demo_environment !== true;
    adminOverviewPlayers = Array.isArray(data.players) ? data.players : [];
    document.getElementById("playerCount").textContent = adminOverviewPlayers.length;
    const events = data.events || data.recent_events || [];
    const matches = data.matches || [];
    const recentLogins = data.recent_logins || [];
    document.getElementById("matchCount").textContent = data.summary?.matches_analyzed ?? data.stats?.matches_analyzed ?? matches.length;
    document.getElementById("eventCount").textContent = data.stats?.security_events ?? events.length;
    document.getElementById("highCount").textContent = data.stats?.high_severity_events ?? events.filter((event) => ["high", "critical"].includes(event.severity)).length;
    renderHonourReport(data.honour_report);
    await loadPlayers();
    document.getElementById("events").innerHTML = events.map((event) => {
      const eventType = String(event.type || "Security event").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
      const severity = event.severity || "low";
      const tone = ["high", "critical"].includes(severity) ? "bad" : severity === "medium" ? "warn" : "good";
      return `<article class="admin-event-row"><div class="admin-event-copy"><strong>${escapeHtml(eventType)}</strong><small>${escapeHtml(event.description || "Recorded security activity")}</small></div><div class="admin-event-meta"><time>${escapeHtml(displayDate(event.created_at || event.timestamp))}</time><span class="badge ${tone}">${escapeHtml(severity)}</span></div></article>`;
    }).join("") || '<div class="empty">No security events.</div>';
    const loginKeys = new Set();
    window.adminLoginRows = recentLogins.map((row) => {
      const player = adminOverviewPlayers.find((item) => item.id === row.player_id || item.id === row.user_id);
      return { ...row, player_name: row.player_name && row.player_name !== "Unknown player" ? row.player_name : (player?.name || "") };
    }).filter((row) => {
      if (!row.player_name && row.result !== "Failed") return false;
      const key = [row.player_id || row.user_id, row.timestamp, row.result, row.reason, row.ip_address].join("|");
      if (loginKeys.has(key)) return false;
      loginKeys.add(key);
      return true;
    });
    const playerFilter = document.getElementById("loginPlayerFilter");
    if (playerFilter) {
      const selected = playerFilter.value;
      playerFilter.innerHTML = '<option value="">All players</option>' + [...new Set(window.adminLoginRows.map((row) => row.player_name).filter((name) => name && name !== "Unknown player"))].sort().map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
      playerFilter.value = selected;
    }
    renderLoginAudit(window.adminLoginRows);
    // Show only the five active model inputs, with raw and normalized values side by side.
    const activeFeatures = ["accuracy", "fire_rate", "movement_speed", "aim_smoothness", "kdr"];
    const analyses = uniqueSessionRows(data.analyses);
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
    document.getElementById("allMatches").innerHTML = matches.map((match) => {
      const score = match.risk_score == null ? (match.status === "completed" ? "Analyzing…" : "Not evaluated") : displayRiskScore(match.risk_score);
      return `<tr><td>${escapeHtml(match.session_id || "N/A")}</td><td>${escapeHtml(match.player_name || match.player_id || "Unknown player")}</td><td>${escapeHtml(match.game || "FPS Microgame")}</td><td>${escapeHtml(displayDate(match.started_at))}</td><td>${escapeHtml(match.status || "unknown")}</td><td>${escapeHtml(score)}</td></tr>`;
    }).join("") || '<tr><td colspan="6">No game sessions recorded.</td></tr>';
    renderGameplayAlerts(data);
    renderBannedAccounts(data);
    renderDemoComparison(data);
    renderHackerAccounts(data);
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
    ["playerCount", "matchCount", "eventCount", "highCount"].forEach((id) => {
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
    ["events", "gameplayAlerts", "bannedAccountsList", "demoAccountPanel", "demoSessionComparison"].forEach((id) => {
      const section = document.getElementById(id);
      if (section && !adminHasLoaded) {
        section.textContent = "Data unavailable. Check the API and database connection.";
      }
    });
  } finally {
    adminLoading = false;
    if (adminRefreshQueued) {
      adminRefreshQueued = false;
      setTimeout(() => loadAdmin(true), 0);
    }
  }
}
const adminSectionLabels = {
  overview: "Admin overview",
  players: "Player accounts",
  security: "Security & access",
  gameplay: "Game monitoring",
  support: "Customer support",
};
const adminSectionDescriptions = {
  overview: "Live platform activity and security health.",
  players: "Manage player accounts and review individual risk.",
  security: "Review sign-ins, IP addresses, and security events.",
  gameplay: "Inspect match telemetry and model analysis.",
  support: "Review player messages and respond to support requests.",
};

async function loadSupportInbox() {
  const inbox = document.getElementById("supportTicketInbox");
  if (!inbox) return;
  try {
    const { tickets = [] } = await api("/admin/support/tickets");
    inbox.innerHTML = tickets.map((ticket) => {
      const resolved = ticket.status === "resolved";
      const latestReply = ticket.admin_reply
        ? `<div class="admin-support-reply"><strong>Latest reply</strong><p>${escapeHtml(ticket.admin_reply)}</p></div>`
        : "";
      const replyControls = resolved
        ? '<p class="muted">This request is resolved.</p>'
        : `<label>Reply to player<textarea rows="3" maxlength="3000" data-ticket-reply="${escapeHtml(ticket.id)}" placeholder="Write a new reply…"></textarea></label><div class="admin-support-actions"><button class="play-btn" type="button" data-ticket-action="reply" data-ticket-id="${escapeHtml(ticket.id)}">Send reply</button><button class="ghost-btn" type="button" data-ticket-action="resolve" data-ticket-id="${escapeHtml(ticket.id)}">Mark resolved</button></div>`;
      return `<article class="admin-support-ticket"><header><div><strong>${escapeHtml(ticket.player_name)}</strong><small>${escapeHtml(ticket.player_email)} · ${escapeHtml(ticket.category)} · ${escapeHtml(displayDate(ticket.created_at))}</small></div><span class="badge ${resolved ? "good" : ticket.status === "answered" ? "warn" : "gray"}">${escapeHtml(ticket.status)}</span></header><p>${escapeHtml(ticket.message)}</p>${ticket.attachment ? `<button class="play-btn" type="button" data-ticket-action="proof" data-ticket-id="${escapeHtml(ticket.id)}">View image proof · ${escapeHtml(ticket.attachment.name)}</button>` : ""}${latestReply}${replyControls}</article>`;
    }).join("") || '<div class="empty">No support messages in the queue.</div>';
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
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
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
document.getElementById("refreshSupportInbox")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Refreshing…";
  try { await loadSupportInbox(); }
  finally { button.disabled = false; button.textContent = "Refresh"; }
});
document.getElementById("supportTicketInbox")?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-ticket-action]");
  if (!button) return;
  const id = button.dataset.ticketId;
  button.disabled = true;
  try {
    if (button.dataset.ticketAction === "proof") {
      const proof = await api(`/admin/support/tickets/${encodeURIComponent(id)}/attachment`);
      document.getElementById("supportProofImage").src = proof.data_url;
      document.getElementById("supportProofDialog").showModal();
    } else if (button.dataset.ticketAction === "reply") {
      const reply = document.querySelector(`[data-ticket-reply="${CSS.escape(id)}"]`)?.value || "";
      await api(`/admin/support/tickets/${encodeURIComponent(id)}/reply`, { method: "POST", body: JSON.stringify({ reply }) });
      await loadSupportInbox();
    } else if (button.dataset.ticketAction === "resolve") {
      await api(`/admin/support/tickets/${encodeURIComponent(id)}/resolve`, { method: "POST" });
      await loadSupportInbox();
    }
  } catch (error) {
    window.showAppAlert(error.message, { title: "Support inbox", tone: "warning" });
  } finally {
    button.disabled = false;
  }
});
document.getElementById("closeSupportProof")?.addEventListener("click", () => document.getElementById("supportProofDialog")?.close());
document.getElementById("supportProofDialog")?.addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });

document.getElementById("players").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const playerName = button.dataset.playerName || "this player";
  if (action === "revoke" && !await window.showAppConfirm(`Suspend ${playerName}?`, { title: "Suspend player", confirmText: "Suspend", tone: "warning" })) return;
  if (action === "delete") {
    const confirmed = await window.showAppConfirm(`Delete ${playerName}? This action cannot be undone.`, { title: "Delete player", confirmText: "Delete", tone: "error", requireName: playerName });
    if (!confirmed) return;
  }
  button.disabled = true;
  try {
    await api(`/admin/players/${button.dataset.id}/${action}`, { method: "POST" });
    window.showAppToast(`${playerName} ${action === "delete" ? "deleted" : action === "restore" ? "restored" : "suspended"}.`, "success");
    await loadAdmin();
  } catch (error) {
    window.showAppToast(error.message || "The admin action failed.", "error");
  } finally {
    button.disabled = false;
  }
});
document.getElementById("playerSearch")?.addEventListener("input", () => {
  playersPage = 1;
  loadPlayers();
});
document.getElementById("playersPagination")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-players-page]");
  if (!button || button.disabled) return;
  playersPage += Number(button.dataset.playersPage);
  loadPlayers();
});
document.getElementById("playerViewBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const identity = await api("/auth/me");
    if (identity.user?.role === "player") {
      window.location.href = "player.html";
      return;
    }
    await api("/auth/logout", { method: "POST" });
    window.location.href = "login.html?next=player.html";
  } catch (error) {
    button.disabled = false;
    window.showAppAlert(
      error.message || "The player game could not be opened. Please sign out and log in with a player account.",
      { title: "Player view unavailable", tone: "warning" }
    );
  }
});
document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST" });
    window.location.href = "login.html";
  } catch (error) {
    window.showAppAlert(error.message || "The server could not end this session. Check the backend connection and try again.", { title: "Could not sign out", tone: "error" });
  }
});
document.getElementById("refreshAdminBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Refreshing…";
  try { await loadAdmin(true); }
  finally { button.disabled = false; button.textContent = "Refresh"; }
});
document.getElementById("retryAnalysesBtn")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const sessions = window.adminIncompleteSessions || [];
  if (!sessions.length) {
    window.showAppToast("There are no incomplete analyses to retry.", "info");
    return;
  }
  button.disabled = true;
  button.textContent = "Retrying…";
  try {
    const results = await Promise.allSettled(sessions.map((sessionId) => api(`/admin/gameplay/analyses/${encodeURIComponent(sessionId)}/retry`, { method: "POST" })));
    await loadAdmin(true);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed) window.showAppAlert(`${failed} of ${sessions.length} analyses could not be retried.`, { title: "Some retries failed", tone: "warning" });
    else window.showAppToast(`Retry requested for ${sessions.length} incomplete analysis session(s).`, "success");
  } catch (error) {
    window.showAppAlert(error.message || "Retry failed.", { title: "Analysis retry failed", tone: "error" });
  } finally {
    button.disabled = false;
    button.textContent = "Retry analyses";
  }
});
document.getElementById("refreshPlayersBtn")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Refreshing…";
  try { await loadPlayers(); }
  finally { button.disabled = false; button.textContent = "Refresh"; }
});
document.getElementById("refreshAnalysisBtn")?.addEventListener("click", (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Refreshing…";
  loadAdmin(true).finally(() => { button.disabled = false; button.textContent = "Refresh"; });
});
document.getElementById("hackerAccountsPanel")?.addEventListener("click", async (event) => {
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
      await loadAdmin(true);
    } catch (error) {
      retry.disabled = false;
      window.showAppAlert(error.message || "Retry failed.", { title: "Analysis retry failed", tone: "error" });
    } finally {
      if (retry.isConnected) retry.disabled = false;
    }
    return;
  }
  const button = event.target.closest("button[data-review-action]");
  if (!button) return;
  pendingReview = button;
  document.getElementById("reviewNote").value = "";
  const action = button.dataset.reviewAction;
  const banDuration = document.getElementById("banDuration");
  const banDurationLabel = document.getElementById("banDurationLabel");
  banDuration.hidden = action !== "ban";
  banDurationLabel.hidden = action !== "ban";
  if (action === "ban") banDuration.value = "24h";
  const noteError = document.getElementById("reviewNoteError");
  noteError.hidden = true;
  document.getElementById("reviewNote").removeAttribute("aria-invalid");
  document.getElementById("reviewNotePrompt").textContent = action === "warn"
    ? "This note will be shown to the player as a security warning."
    : action === "ban"
      ? "Choose how long to block this account and add a required note."
      : `Add a required note for the ${action} action.`;
  document.getElementById("reviewNoteDialog").showModal();
  document.getElementById("reviewNote").focus();
});
document.getElementById("reviewNoteForm")?.addEventListener("submit", async (event) => {
  if (event.submitter?.id !== "saveReviewNote" || !pendingReview) return;
  event.preventDefault();
  const note = document.getElementById("reviewNote").value.trim();
  if (!note) {
    const noteField = document.getElementById("reviewNote");
    noteField.setAttribute("aria-invalid", "true");
    document.getElementById("reviewNoteError").hidden = false;
    noteField.focus();
    return;
  }
  document.getElementById("reviewNoteError").hidden = true;
  document.getElementById("reviewNote").removeAttribute("aria-invalid");
  pendingReview.disabled = true;
  try {
    const action = pendingReview.dataset.reviewAction;
    await api(`/admin/gameplay/alerts/${encodeURIComponent(pendingReview.dataset.sessionId)}/review`, {
      method: "POST",
      body: JSON.stringify({ action, note, ...(action === "ban" ? { ban_duration: document.getElementById("banDuration").value } : {}) })
    });
    document.getElementById("reviewNoteDialog").close();
    await loadAdmin(true);
  } catch (error) {
    pendingReview.disabled = false;
    window.showAppAlert(error.message || "Review action failed.", { title: "Could not save review", tone: "error" });
  } finally {
    if (pendingReview?.isConnected) pendingReview.disabled = false;
    pendingReview = null;
  }
});
document.getElementById("reviewNoteDialog")?.addEventListener("close", () => {
  document.getElementById("reviewNoteError").hidden = true;
  document.getElementById("reviewNote").removeAttribute("aria-invalid");
  if (pendingReview?.isConnected) pendingReview.disabled = false;
  pendingReview = null;
});
document.getElementById("cancelReviewNote")?.addEventListener("click", async (event) => {
  event.preventDefault();
  const discard = await window.showAppConfirm("Cancel this review and discard the note?", {
    title: "Discard review action?",
    confirmText: "Discard",
    tone: "warning"
  });
  if (discard) document.getElementById("reviewNoteDialog").close();
});
document.getElementById("analyses")?.addEventListener("click", async (event) => {
  const retry = event.target.closest("button[data-retry-analysis]");
  if (!retry) return;
  retry.disabled = true;
  try {
    await api(`/admin/gameplay/analyses/${encodeURIComponent(retry.dataset.retryAnalysis)}/retry`, { method: "POST" });
    await loadAdmin(true);
  } catch (error) {
    retry.disabled = false;
    window.showAppAlert(error.message || "Retry failed.", { title: "Analysis retry failed", tone: "error" });
  } finally {
    if (retry.isConnected) retry.disabled = false;
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
document.getElementById("refreshLogins")?.addEventListener("click", () => loadAdmin(true));
document.getElementById("refreshHonourReport")?.addEventListener("click", () => loadAdmin(true));
document.getElementById("honourReportRows")?.addEventListener("click", (event) => {
  const toggle = event.target.closest("button[data-honour-toggle]");
  if (!toggle) return;
  const playerId = toggle.dataset.honourToggle;
  if (expandedHonourPlayers.has(playerId)) expandedHonourPlayers.delete(playerId);
  else expandedHonourPlayers.add(playerId);
  renderHonourReport(honourReportCache);
});
document.getElementById("runHackerDemoBtn")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const confirmed = await window.showAppConfirm("Prepare the two normal players and four hacker simulations? The normal players stay active. You will get a separate alert when all four hackers are detected and banned.", {
    title: "Run full demo?",
    confirmText: "Run demo",
    tone: "warning"
  });
  if (!confirmed) return;
  button.disabled = true;
  button.textContent = "Preparing demo…";
  let demoStep = "connecting to the demo API";
  try {
    demoStep = "adding the two normal player accounts";
    button.textContent = "Adding normal players…";
    await api("/admin/gameplay/seed-normal-demo-players", { method: "POST" });
    demoStep = "preparing the four hacker accounts";
    button.textContent = "Preparing hacker accounts…";
    await api("/admin/gameplay/seed-hacker-demo-accounts", { method: "POST" });
    demoStep = "clearing the previous hacker run";
    button.textContent = "Resetting previous run…";
    await api("/admin/gameplay/reset-hacker-demo", { method: "POST" });
    demoStep = "adding comparison matches";
    button.textContent = "Adding comparison matches…";
    await api("/admin/gameplay/seed-demo", { method: "POST" });
    demoStep = "starting the four hacker simulations";
    button.textContent = "Starting hacker simulations…";
    hackerDemoNotifiedBans.clear();
    hackerDemoAwaitingBan = true;
    await api("/admin/gameplay/run-hacker-demo", { method: "POST" });
    window.showAppToast("Demo started: the four hacker simulations are running. Waiting for detection and bans…", "info");
    await loadAdmin(true);
    clearInterval(hackerDemoPollTimer);
    hackerDemoPollTimer = setInterval(() => loadAdmin(true), 2000);
    clearTimeout(hackerDemoCompletionTimer);
    hackerDemoCompletionTimer = window.setTimeout(() => {
      clearInterval(hackerDemoPollTimer);
      if (hackerDemoAwaitingBan) {
        hackerDemoAwaitingBan = false;
        window.showAppAlert(
          "The simulations started, but all four hacker accounts were not banned within 45 seconds. Refresh the dashboard and check the backend logs.",
          { title: "Demo still running", tone: "warning" }
        );
      }
    }, 45000);
  } catch (error) {
    hackerDemoAwaitingBan = false;
    clearInterval(hackerDemoPollTimer);
    clearTimeout(hackerDemoCompletionTimer);
    const oldBackend = error.status === 404;
    const message = oldBackend
      ? `The backend returned 404 while ${demoStep}. Stop and restart Flask with python app.py from the backend folder, then hard-refresh this page (Ctrl+F5) and try again.`
      : `${demoStep.charAt(0).toUpperCase()}${demoStep.slice(1)} failed: ${error.message || "Request failed."}`;
    window.showAppAlert(message, { title: oldBackend ? "Restart the backend" : "Full demo failed", tone: "error" });
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = "Run full demo";
    }
  }
});
document.getElementById("resetHackerDemoBtn")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const confirmed = await window.showAppConfirm("Unban the four demo hackers and delete their demo telemetry and alerts?", {
    title: "Reset hacker demo?",
    confirmText: "Reset demo",
    tone: "warning"
  });
  if (!confirmed) return;
  button.disabled = true;
  button.textContent = "Resetting…";
  try {
    const result = await api("/admin/gameplay/reset-hacker-demo", { method: "POST" });
    window.showAppToast(`Reset ${result.reset_accounts || 0} demo hacker accounts.`, "success");
    await loadAdmin(true);
  } catch (error) {
    window.showAppAlert(error.message || "The hacker demo could not be reset.", { title: "Reset failed", tone: "error" });
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = "Reset demo hackers";
    }
  }
});
loadAdmin();
// Keep a slower fallback refresh in case the event stream is interrupted.
adminRefreshTimer = setInterval(() => {
  loadAdmin();
  if (document.querySelector('[data-admin-view="support"].active')) loadSupportInbox();
}, 15000);
