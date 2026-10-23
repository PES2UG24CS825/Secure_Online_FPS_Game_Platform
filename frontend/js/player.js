const playerText = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

const playerDate = (value) => {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString();
};

const playerRisk = (value) => {
  const score = Number(value);
  return value == null || !Number.isFinite(score) ? "Pending" : `${score.toFixed(1)} / 100`;
};

const overviewRiskBadge = (match) => {
  const score = match.risk_score == null ? null : Number(match.risk_score);
  if (score == null || !Number.isFinite(score)) return '<span class="overview-risk-badge pending">Analyzing…</span>';
  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  return `<span class="overview-risk-badge ${level}">${Math.round(score)} ${level[0].toUpperCase()}${level.slice(1)}</span>`;
};

const overviewDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

function getRiskBreakdown(score) {
  const values = {
    "Aim behavior": Math.min(100, Math.round(score * 1.8)),
    "Reaction time": Math.min(100, Math.round(score * 1.05)),
    Movement: Math.min(100, Math.round(score * 0.7)),
    "Input patterns": Math.min(100, Math.round(score * 0.5)),
    "Account / IP": Math.min(100, Math.round(score * 0.2))
  };
  return values;
}

function updateRiskBreakdown(score) {
  const values = getRiskBreakdown(score);
  const elementIds = {
    "Aim behavior": "riskAim",
    "Reaction time": "riskReaction",
    Movement: "riskMovement",
    "Input patterns": "riskInput",
    "Account / IP": "riskAccount"
  };
  Object.entries(values).forEach(([name, value]) => {
    const key = elementIds[name];
    const fill = document.getElementById(`${key}Fill`);
    const label = document.getElementById(`${key}Value`);
    if (fill) {
      fill.style.width = `${value}%`;
      fill.style.background = value >= 70 ? "#B91C1C" : value >= 40 ? "#B45309" : "#0f766e";
    }
    if (label) label.textContent = String(value);
  });
  const topFactor = Object.entries(values).sort((left, right) => right[1] - left[1])[0];
  return topFactor && topFactor[1] >= 30 ? `${topFactor[0]} (${topFactor[1]})` : "None";
}

const avatarGlyphs = { initial: "", shield: "⬡", target: "◎", bolt: "ϟ" };
let playerDashboardLoading = false;
let appearanceControlsBound = false;
let currentAppearance = { avatar: "initial", banner: "midnight", avatar_image: null, banner_image: null };
let appearanceDirty = false;
let renderPlayerAppearance = () => {};
let playerLiveEvents = null;
let playerRefreshTimer = null;
let latestPlayerMatchId = "";
let matchReviewTimer = null;
let matchReviewCountdownTimer = null;

function showMatchReview(match) {
  const toast = document.getElementById("matchReviewToast");
  const backdrop = document.getElementById("matchReviewBackdrop");
  if (!toast) return;
  const severity = String(match.alert_severity || "").toLowerCase();
  const score = match.risk_score == null ? null : Number(match.risk_score);
  const rewardNotice = "Match reward: +20 coins and +50 XP.";
  const title = document.getElementById("matchReviewTitle");
  const message = document.getElementById("matchReviewMessage");
  const countdown = document.getElementById("matchReviewCountdown");
  if (title) title.textContent = severity ? `${severity.toUpperCase()} GAMEPLAY SIGNAL` : "MATCH COMPLETE";
  if (message) {
    const review = severity
      ? `The match review detected a ${severity} signal${score == null ? "." : ` with a risk score of ${score.toFixed(1)} / 100.`}`
      : score == null
        ? "Your match was saved. Security analysis is incomplete because more gameplay data is needed."
        : `No elevated gameplay signal was reported. Match risk score: ${score.toFixed(1)} / 100.`;
    message.textContent = `${review} ${rewardNotice}`;
  }
  toast.hidden = false;
  if (backdrop) backdrop.hidden = false;
  let seconds = 10;
  if (countdown) countdown.textContent = String(seconds);
  clearTimeout(matchReviewTimer);
  clearInterval(matchReviewCountdownTimer);
  matchReviewCountdownTimer = setInterval(() => {
    seconds -= 1;
    if (countdown) countdown.textContent = String(Math.max(0, seconds));
  }, 1000);
  matchReviewTimer = setTimeout(() => {
    toast.hidden = true;
    if (backdrop) backdrop.hidden = true;
    clearInterval(matchReviewCountdownTimer);
  }, 10000);
}

document.getElementById("matchReviewClose")?.addEventListener("click", () => {
  document.getElementById("matchReviewToast").hidden = true;
  const backdrop = document.getElementById("matchReviewBackdrop");
  if (backdrop) backdrop.hidden = true;
  clearTimeout(matchReviewTimer);
  clearInterval(matchReviewCountdownTimer);
});
document.getElementById("matchReviewBackdrop")?.addEventListener("click", () => {
  document.getElementById("matchReviewClose")?.click();
});

function connectPlayerLiveEvents() {
  if (playerLiveEvents || !window.EventSource) return;
  playerLiveEvents = new EventSource(`${window.API_BASE}/live/events`, { withCredentials: true });
  playerLiveEvents.addEventListener("update", () => loadPlayerDashboard());
  playerLiveEvents.onopen = () => {
    const status = document.getElementById("playerLiveStatus");
    if (status) status.textContent = `Live · updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  };
  playerLiveEvents.onerror = () => {
    const status = document.getElementById("playerLiveStatus");
    if (status) status.textContent = "Reconnecting · refresh active";
  };
}

function matchCard(match) {
  const value = (field) => match[field] == null ? "—" : Number(match[field]);
  const state = String(match.status || "unknown").toLowerCase();
  const badge = state === "completed" ? "good" : state === "active" ? "warn" : "gray";
  const duration = match.duration == null ? "—" : `${Math.max(0, Number(match.duration))}s`;
  const accuracy = match.accuracy == null ? "—" : `${Number(match.accuracy).toFixed(1)}%`;
  const analysisStatus = String(match.analysis_status || "pending").replaceAll("_", " ");
  const analysisNote = match.risk_score != null ? "" : match.missing_features?.length
    ? `<p class="match-analysis-note">Analysis needs gameplay data: ${playerText(match.missing_features.join(", "))}.</p>`
    : match.analysis_error ? `<p class="match-analysis-note">Analysis could not finish: ${playerText(match.analysis_error)}</p>`
    : state === "active" ? '<p class="match-analysis-note">Risk review starts when this match is completed.</p>'
    : '<p class="match-analysis-note">Risk review is pending for this match.</p>';
  return `<article class="match-card">
    <div class="match-card-head"><div><span class="match-card-kicker">FPS Microgame</span><h3>Match ${playerText(match.match_id || "—")}</h3><div class="match-card-date">${playerText(playerDate(match.date))}</div></div><span class="badge ${badge}">${playerText(state)}</span></div>
    <div class="match-stat-grid"><div class="match-stat"><span>Kills</span><strong>${value("kills")}</strong></div><div class="match-stat"><span>Deaths</span><strong>${value("deaths")}</strong></div><div class="match-stat"><span>K/D</span><strong>${match.kd == null ? "—" : Number(match.kd).toFixed(2)}</strong></div><div class="match-stat"><span>Duration</span><strong>${duration}</strong></div><div class="match-stat"><span>Accuracy</span><strong>${accuracy}</strong></div><div class="match-stat"><span>Analysis</span><strong>${playerText(analysisStatus)}</strong></div></div>
    <div class="match-risk"><span>Security risk score</span><strong>${playerText(playerRisk(match.risk_score))}</strong></div>${analysisNote}
  </article>`;
}

async function prepareProfileImage(file, kind) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a JPG, PNG, or WebP image.");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("Choose an image smaller than 10 MB.");
  const bitmap = await createImageBitmap(file);
  const maxWidth = kind === "banner" ? 1440 : 512;
  const maxHeight = kind === "banner" ? 460 : 512;
  const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.86, 0.76, 0.66, 0.56]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length < 680_000) return dataUrl;
  }
  throw new Error("This image could not be compressed enough. Try a smaller image.");
}

async function loadPlayerDashboard() {
  if (playerDashboardLoading || document.visibilityState === "hidden") return;
  playerDashboardLoading = true;
  try {
    const me = await api("/auth/me");
    if (!me?.user || me.user.role !== "player") {
      window.location.replace("login.html");
      return;
    }
    connectPlayerLiveEvents();

    const user = me.user;
    const name = user.name || "Player";
    const welcome = document.getElementById("welcome");
    const sideName = document.getElementById("sideName");
    const sideEmail = document.getElementById("sideEmail");
    const avatar = document.getElementById("avatar");
    if (welcome) welcome.textContent = `Welcome back, ${name}`;
    if (sideName) sideName.textContent = name;
    if (sideEmail) sideEmail.textContent = user.email || "";
    if (avatar) avatar.textContent = name.charAt(0).toUpperCase();

    const failedSections = [];
    const loadSection = async (name, path) => {
      try {
        return await api(path);
      } catch (sectionError) {
        console.error(`Player dashboard section failed: ${name}`, sectionError);
        failedSections.push(`${name} (${sectionError.status || "network"}: ${sectionError.message || "request failed"})`);
        return null;
      }
    };
    const [matchesData, securityData, profileData] = await Promise.all([
      loadSection("matches", "/player/matches"),
      loadSection("account security", "/player/security"),
      loadSection("profile", "/player/profile")
    ]);

    const matches = Array.isArray(matchesData?.matches) ? matchesData.matches : [];
    latestPlayerMatchId = matches[0]?.id || "";
    const history = Array.isArray(securityData?.login_history) ? securityData.login_history : [];
    const activeSessions = Array.isArray(securityData?.active_sessions) ? securityData.active_sessions : [];
    const latestScoredMatch = matches.find((match) => match.risk_score != null && Number.isFinite(Number(match.risk_score)));
    const risk = latestScoredMatch ? Number(latestScoredMatch.risk_score) : securityData?.risk_score;

    const trendChart = document.getElementById("overviewRiskTrend");
    if (trendChart) {
      const scoredMatches = matches.filter((match) => match.risk_score != null && Number.isFinite(Number(match.risk_score))).slice(0, 9).reverse();
      if (!matchesData) {
        trendChart.innerHTML = '<span class="overview-trend-empty">Match data unavailable</span>';
      } else if (!scoredMatches.length) {
        trendChart.innerHTML = '<span class="overview-trend-empty">Complete a reviewed match to see your trend</span>';
      } else {
        const points = scoredMatches.map((match, index) => {
          const score = Math.max(0, Math.min(100, Number(match.risk_score)));
          const x = scoredMatches.length === 1 ? 150 : 28 + index * (244 / (scoredMatches.length - 1));
          const y = 112 - (score / 100) * 92;
          return { x, y, score, match };
        });
        const path = points.map((point) => `${point.x},${point.y}`).join(" ");
        const last = points[points.length - 1];
        const areaPath = `${points[0].x},112 ${path} ${last.x},112`;
        trendChart.innerHTML = `<svg viewBox="0 0 300 132" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="riskAreaGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#6D28D9" stop-opacity=".28"></stop>
              <stop offset="1" stop-color="#6D28D9" stop-opacity=".02"></stop>
            </linearGradient>
            <filter id="riskGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="1.5" result="blur"></feGaussianBlur>
              <feMerge><feMergeNode in="blur"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge>
            </filter>
          </defs>
          <line class="chart-grid" x1="28" y1="20" x2="272" y2="20"></line>
          <line class="chart-grid" x1="28" y1="66" x2="272" y2="66"></line>
          <line class="chart-grid" x1="28" y1="112" x2="272" y2="112"></line>
          <text class="chart-zone-label" x="4" y="23">HIGH</text>
          <text class="chart-zone-label" x="4" y="69">MID</text>
          <text class="chart-zone-label" x="4" y="115">LOW</text>
          <polygon class="chart-area" points="${areaPath}"></polygon>
          <polyline points="${path}"></polyline>
          ${points.map((point) => `<circle class="${point === last ? "latest" : ""}" cx="${point.x}" cy="${point.y}" r="${point === last ? 4.5 : 3.5}" tabindex="0" data-match="${playerText(point.match.match_id || "Match")}" data-score="${point.score.toFixed(1)}"></circle>`).join("")}
        </svg><div class="risk-chart-tooltip" hidden></div>`;
        const tooltip = trendChart.querySelector(".risk-chart-tooltip");
        trendChart.querySelectorAll("circle").forEach((point) => {
          const showTooltip = () => {
            if (!tooltip) return;
            tooltip.innerHTML = `<strong>${point.dataset.match}</strong><br>Risk score: ${point.dataset.score} / 100`;
            const chartRect = trendChart.getBoundingClientRect();
            const svgRect = trendChart.querySelector("svg").getBoundingClientRect();
            tooltip.style.left = `${(Number(point.getAttribute("cx")) / 300) * svgRect.width + svgRect.left - chartRect.left}px`;
            tooltip.style.top = `${(Number(point.getAttribute("cy")) / 132) * svgRect.height + svgRect.top - chartRect.top}px`;
            tooltip.hidden = false;
          };
          point.addEventListener("mouseenter", showTooltip);
          point.addEventListener("focus", showTooltip);
          point.addEventListener("mouseleave", () => { if (tooltip) tooltip.hidden = true; });
          point.addEventListener("blur", () => { if (tooltip) tooltip.hidden = true; });
        });
      }
    }

    const analyzedMatches = matches.filter((match) => match.risk_score != null && Number.isFinite(Number(match.risk_score)));
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    const analyzedThisWeek = analyzedMatches.filter((match) => {
      const date = new Date(match.date);
      return !Number.isNaN(date.getTime()) && date >= weekStart;
    });
    const cleanMatches = analyzedThisWeek.filter((match) => Number(match.risk_score) < 40);
    const cleanRate = analyzedThisWeek.length ? Math.round((cleanMatches.length / analyzedThisWeek.length) * 100) : null;
    const todayKey = new Date().toDateString();
    const matchesAnalyzedToday = analyzedMatches.filter((match) => {
      const date = new Date(match.date);
      return !Number.isNaN(date.getTime()) && date.toDateString() === todayKey;
    }).length;
    const cleanRateNode = document.getElementById("cleanMatchesPercent");
    const matchesTodayNode = document.getElementById("matchesToday");
    const rankNode = document.getElementById("playerRank");
    if (cleanRateNode) cleanRateNode.textContent = cleanRate == null ? "—" : `${cleanRate}%`;
    if (matchesTodayNode) matchesTodayNode.textContent = matchesAnalyzedToday.toLocaleString();
    if (rankNode) rankNode.textContent = "—";
    const scoreNode = document.getElementById("riskScore");
    const gauge = document.getElementById("riskGauge");
    const levelNode = document.getElementById("riskLevel");
    const trendCaption = document.getElementById("riskTrendCaption");
    const topFactor = document.getElementById("riskTopFactor");
    if (scoreNode) scoreNode.textContent = risk == null ? "—" : `${Math.round(Number(risk))}`;
    if (gauge) {
      const score = risk == null ? 0 : Math.max(0, Math.min(100, Number(risk)));
      gauge.style.setProperty("--risk-angle", `${score * 3.6}deg`);
      gauge.style.setProperty("--risk-color", score >= 70 ? "#B91C1C" : score >= 40 ? "#B45309" : "#15803D");
      gauge.setAttribute("aria-label", risk == null ? "Risk score pending" : `Risk score ${score.toFixed(1)} out of 100`);
    }
    if (levelNode) {
      const level = risk == null ? "waiting" : Number(risk) >= 70 ? "high" : Number(risk) >= 40 ? "medium" : "low";
      levelNode.textContent = level.toUpperCase();
      levelNode.style.background = level === "high" ? "#f5dcde" : level === "medium" ? "#f6ebd8" : "#dcefe2";
      levelNode.style.color = level === "high" ? "#B91C1C" : level === "medium" ? "#B45309" : "#15803D";
    }
    if (trendCaption) {
      const previousScores = analyzedMatches.slice(1, 6).map((match) => Number(match.risk_score));
      const currentScore = latestScoredMatch ? Number(latestScoredMatch.risk_score) : null;
      const delta = currentScore != null && previousScores.length
        ? Math.round(currentScore - previousScores.reduce((sum, value) => sum + value, 0) / previousScores.length)
        : null;
      trendCaption.textContent = delta == null ? "Latest completed match analysis" : `${delta <= 0 ? "Down" : "Up"} ${Math.abs(delta)} pts vs. last ${previousScores.length} matches`;
    }
    const breakdownScore = risk == null ? 0 : Math.max(0, Math.min(100, Number(risk)));
    const strongestFactor = updateRiskBreakdown(breakdownScore);
    if (topFactor) topFactor.textContent = `Top factor: ${strongestFactor}`;

    document.getElementById("matchesCount").textContent = matchesData ? Number(matchesData.total_matches ?? matches.length) : "Unavailable";
    const matchesSummary = document.getElementById("matchesSummary");
    if (matchesSummary) matchesSummary.textContent = `${analyzedMatches.length} analyzed · ${Math.max(0, matches.length - analyzedMatches.length)} pending`;
    document.getElementById("mfaStatus").textContent = securityData ? securityData.mfa_status === "enabled" ? "On" : "Off" : "Unavailable";
    const accountStatus = securityData?.account_status;
    const accountStatusLabels = {
      active: "Active",
      suspended: "Suspended",
      banned: "Banned",
      restricted: "Restricted"
    };
    const accountStatusNode = document.getElementById("accountStatus");
    accountStatusNode.textContent = accountStatusLabels[accountStatus] || "Unavailable";
    accountStatusNode.classList.toggle("success-text", accountStatus === "active");
    if (risk == null && !securityData) {
      if (scoreNode) scoreNode.textContent = "—";
    }
    document.getElementById("lastLoginIp").textContent = securityData ? history[0]?.ip_address || "Not recorded" : "Unavailable";

    const matchesList = document.getElementById("matchesList");
    if (matchesList) {
      matchesList.innerHTML = !matchesData
        ? '<div class="match-empty"><strong>Match history unavailable</strong><span>The match service could not be reached. Retry after the API and database are available.</span></div>'
        : matches.slice(0, 10).map(matchCard).join("") || '<div class="match-empty"><strong>No matches yet</strong><span>Play the FPS Microgame to create your first match record.</span></div>';
    }

    const recentRows = document.getElementById("overviewRecentRows");
    if (recentRows) recentRows.innerHTML = !matchesData
      ? '<tr><td colspan="7">Match history unavailable.</td></tr>'
      : matches.slice(0, 3).map((match) => `<tr><td><strong>${playerText(match.match_id || "—")}</strong></td><td>${playerText(overviewDate(match.date))}</td><td>${match.kills ?? "—"} / ${match.deaths ?? "—"}</td><td>${match.accuracy == null ? "—" : `${Number(match.accuracy).toFixed(0)}%`}</td><td>${match.headshot_ratio == null ? "—" : `${(Number(match.headshot_ratio) * 100).toFixed(0)}%`}</td><td>${overviewRiskBadge(match)}</td><td><a href="#matches" data-section="matches">Details</a></td></tr>`).join("") || '<tr><td colspan="7">Your first match will appear here.</td></tr>';
    const returnedFromGame = sessionStorage.getItem("securefps_game_completed") === "1";
    if (returnedFromGame) {
      sessionStorage.removeItem("securefps_game_completed");
      const previousMatch = sessionStorage.getItem("securefps_match_before_game") || "";
      sessionStorage.removeItem("securefps_match_before_game");
      const completedMatch = matches.find((match) => String(match.status).toLowerCase() === "completed");
      if (completedMatch && completedMatch.id !== previousMatch) showMatchReview(completedMatch);
    }

    const securityStatus = document.getElementById("securityStatus");
    if (securityStatus && securityData) {
      const ipRows = history.map((entry) => `<tr><td>${playerText(entry.ip_address || "Unknown")}</td><td>${playerText(playerDate(entry.timestamp))}</td><td>${playerText(entry.authentication_method || "Password + MFA")}</td><td><span class="badge ${entry.success === false ? "bad" : "good"}">${entry.success === false ? "Failed" : "Success"}</span></td></tr>`).join("");
      securityStatus.innerHTML = `
        <article class="security-card"><div class="security-card-label">MFA / 2FA</div><div class="security-card-value">${securityData.mfa_status === "enabled" ? "Enabled" : "Disabled"}</div><div class="security-card-meta">Authenticator protection</div></article>
        <article class="security-card"><div class="security-card-label">Active sessions</div><div class="security-card-value">${activeSessions.length}</div><div class="security-card-meta">Devices currently signed in</div></article>
        <article class="security-card"><div class="security-card-label">Last login</div><div class="security-card-value security-card-value-small">${playerText(playerDate(securityData.last_login))}</div><div class="security-card-meta">Most recent successful sign in</div></article>
        <article class="security-card"><div class="security-card-label">Latest login IP</div><div class="security-card-value">${playerText(history[0]?.ip_address || "Not recorded")}</div><div class="security-card-meta">Address observed by the server</div></article>
        <section class="security-history"><h3>Login IP address history</h3><p class="page-description">Successful sign-ins are recorded after password and MFA verification.</p><div class="admin-table-wrap"><table><thead><tr><th>IP address</th><th>Signed in</th><th>Authentication</th><th>Result</th></tr></thead><tbody>${ipRows || '<tr><td colspan="4">No sign-in history recorded yet.</td></tr>'}</tbody></table></div></section>
        <section class="security-history"><h3>Active sign-in locations</h3><div class="admin-table-wrap"><table><thead><tr><th>IP address</th><th>Device</th><th>Last activity</th></tr></thead><tbody>${activeSessions.map((item) => `<tr><td>${playerText(item.ip_address || "Unknown")}</td><td>${playerText(item.device || "Unknown device")}</td><td>${playerText(playerDate(item.last_activity))}</td></tr>`).join("") || '<tr><td colspan="3">No active session records.</td></tr>'}</tbody></table></div></section>`;
    }
    if (securityStatus && !securityData) securityStatus.innerHTML = '<div class="match-empty"><strong>Account security unavailable</strong><span>The security service could not be reached.</span></div>';

    const profileContent = document.getElementById("profileContent");
    if (profileContent) {
      profileContent.innerHTML = `
        <div class="profile-row"><span>Username</span><strong>${playerText(profileData ? name : "Unavailable")}</strong></div>
        <div class="profile-row"><span>Email</span><strong>${playerText(profileData ? user.email || "" : "Unavailable")}</strong></div>
        <div class="profile-row"><span>Role</span><strong>${playerText(profileData ? user.role : "Unavailable")}</strong></div>
        <div class="profile-row"><span>Created</span><strong>${playerText(profileData ? playerDate(user.created_at) : "Unavailable")}</strong></div>`;
    }

    if (!appearanceDirty) {
      currentAppearance = {
        avatar: profileData?.profile_customization?.avatar || "initial",
        banner: profileData?.profile_customization?.banner || "midnight",
        avatar_image: profileData?.profile_customization?.avatar_image || null,
        banner_image: profileData?.profile_customization?.banner_image || null
      };
    }
    const profileBanner = document.getElementById("profileBanner");
    const profileAvatar = document.getElementById("profileAvatar");
    const profileDisplayName = document.getElementById("profileDisplayName");
    const profileDisplayEmail = document.getElementById("profileDisplayEmail");
    renderPlayerAppearance = () => {
      if (profileBanner) profileBanner.dataset.banner = currentAppearance.banner;
      if (profileBanner) profileBanner.style.backgroundImage = currentAppearance.banner_image
        ? `linear-gradient(0deg, rgba(5, 13, 24, .08), rgba(5, 13, 24, .08)), url("${currentAppearance.banner_image}")`
        : "";
      const glyph = currentAppearance.avatar_image ? "" : currentAppearance.avatar === "initial" ? name.charAt(0).toUpperCase() : avatarGlyphs[currentAppearance.avatar];
      if (profileAvatar) profileAvatar.textContent = currentAppearance.avatar_image ? "" : glyph || name.charAt(0).toUpperCase();
      if (avatar) avatar.textContent = currentAppearance.avatar_image ? "" : glyph || name.charAt(0).toUpperCase();
      for (const avatarElement of [profileAvatar, avatar]) {
        if (!avatarElement) continue;
        avatarElement.style.backgroundImage = currentAppearance.avatar_image ? `url("${currentAppearance.avatar_image}")` : "";
        avatarElement.classList.toggle("has-profile-image", Boolean(currentAppearance.avatar_image));
      }
      document.querySelectorAll("#bannerOptions [data-banner]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.banner === currentAppearance.banner)));
      document.querySelectorAll("#avatarOptions [data-avatar]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.avatar === currentAppearance.avatar)));
    };
    if (profileDisplayName) profileDisplayName.textContent = name;
    if (profileDisplayEmail) profileDisplayEmail.textContent = user.email || "";
    renderPlayerAppearance();

    if (!appearanceControlsBound) {
      appearanceControlsBound = true;
      document.getElementById("bannerOptions")?.addEventListener("click", (event) => {
        const option = event.target.closest("[data-banner]");
        if (!option) return;
        currentAppearance.banner = option.dataset.banner;
        currentAppearance.banner_image = null;
        appearanceDirty = true;
        renderPlayerAppearance();
      });
      document.getElementById("avatarOptions")?.addEventListener("click", (event) => {
        const option = event.target.closest("[data-avatar]");
        if (!option) return;
        currentAppearance.avatar = option.dataset.avatar;
        currentAppearance.avatar_image = null;
        appearanceDirty = true;
        renderPlayerAppearance();
      });
      document.getElementById("bannerUpload")?.addEventListener("change", async (event) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        if (!file) return;
        const status = document.getElementById("appearanceStatus");
        try {
          currentAppearance.banner_image = await prepareProfileImage(file, "banner");
          currentAppearance.banner = "custom";
          appearanceDirty = true;
          renderPlayerAppearance();
          if (status) status.textContent = "Banner preview ready. Save appearance to apply it.";
        } catch (uploadError) {
          if (status) status.textContent = uploadError.message;
        } finally {
          input.value = "";
        }
      });
      document.getElementById("avatarUpload")?.addEventListener("change", async (event) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        if (!file) return;
        const status = document.getElementById("appearanceStatus");
        try {
          currentAppearance.avatar_image = await prepareProfileImage(file, "avatar");
          currentAppearance.avatar = "custom";
          appearanceDirty = true;
          renderPlayerAppearance();
          if (status) status.textContent = "Profile photo preview ready. Save appearance to apply it.";
        } catch (uploadError) {
          if (status) status.textContent = uploadError.message;
        } finally {
          input.value = "";
        }
      });
      document.getElementById("saveAppearance")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const status = document.getElementById("appearanceStatus");
      button.disabled = true;
      if (status) status.textContent = "Saving…";
      try {
        await api("/player/profile/customization", { method: "PUT", body: JSON.stringify(currentAppearance) });
        appearanceDirty = false;
        if (status) status.textContent = "Appearance saved.";
      } catch (saveError) {
        console.error("Could not save profile appearance", saveError);
        if (status) status.textContent = saveError.status === 401 ? "Sign in again to save." : saveError.message || "Could not save appearance.";
      } finally {
        button.disabled = false;
      }
      });
    }
    if (failedSections.length) {
      const notice = document.getElementById("dashboardNotice");
      if (notice) {
        notice.hidden = false;
        notice.textContent = `Player API request failed: ${failedSections.join("; ")}.`;
      }
      const liveStatus = document.getElementById("playerLiveStatus");
      if (liveStatus) liveStatus.textContent = "Connection issue";
    } else {
      const notice = document.getElementById("dashboardNotice");
      if (notice) notice.hidden = true;
      const liveStatus = document.getElementById("playerLiveStatus");
      if (liveStatus) liveStatus.textContent = `Live · updated ${new Date().toLocaleTimeString()}`;
    }
  } catch (error) {
    console.error("Player dashboard failed", error);
    if (error?.status === 401 || error?.status === 403 || error?.message?.toLowerCase().includes("authentication")) {
      window.location.replace("login.html");
      return;
    }
    const notice = document.getElementById("dashboardNotice");
    if (notice) {
      notice.hidden = false;
      notice.textContent = "Dashboard data could not be loaded. Check that the Flask API and MongoDB are running, then refresh.";
    }
    ["matchesCount", "mfaStatus", "accountStatus", "riskScore", "lastLoginIp"].forEach((id) => {
      const element = document.getElementById(id);
      if (element && ["Loading", "Pending", "—"].includes(element.textContent.trim())) element.textContent = "Unavailable";
    });
    const matchList = document.getElementById("matchesList");
    if (matchList) matchList.innerHTML = '<div class="match-empty"><strong>Match history unavailable</strong><span>Reconnect to the API and database to load saved matches.</span></div>';
    const overviewMatches = document.getElementById("overviewMatchList");
    if (overviewMatches) overviewMatches.innerHTML = '<div class="match-empty"><strong>Match history unavailable</strong><span>Reconnect to the API and database to load saved matches.</span></div>';
    const securityStatus = document.getElementById("securityStatus");
    if (securityStatus) securityStatus.innerHTML = '<div class="match-empty"><strong>Account security unavailable</strong><span>Reconnect to the API and database to load account security.</span></div>';
    const profileContent = document.getElementById("profileContent");
    if (profileContent) profileContent.innerHTML = '<div class="profile-row"><span>Profile</span><strong>Unavailable</strong></div>';
    const liveStatus = document.getElementById("playerLiveStatus");
    if (liveStatus) liveStatus.textContent = "Connection issue";
  } finally {
    playerDashboardLoading = false;
  }
}

const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch (error) {
      window.showAppAlert(error.message || "The server could not end this session. Check the backend connection and try again.", { title: "Could not sign out", tone: "error" });
      return;
    }
    window.location.href = "login.html";
  });
}

const fpsMicrogameBtn = document.getElementById("fpsMicrogameBtn");
if (fpsMicrogameBtn) fpsMicrogameBtn.addEventListener("click", () => {
  sessionStorage.setItem("securefps_match_before_game", latestPlayerMatchId);
  window.location.href = "game.html";
});

loadPlayerDashboard();
playerRefreshTimer = setInterval(loadPlayerDashboard, 15000);
