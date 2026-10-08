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

const avatarGlyphs = { initial: "", shield: "⬡", target: "◎", bolt: "ϟ" };
let playerDashboardLoading = false;
let appearanceControlsBound = false;
let currentAppearance = { avatar: "initial", banner: "midnight", avatar_image: null, banner_image: null };
let appearanceDirty = false;
let renderPlayerAppearance = () => {};
let playerLiveEvents = null;
let playerRefreshTimer = null;

function connectPlayerLiveEvents() {
  if (playerLiveEvents || !window.EventSource) return;
  playerLiveEvents = new EventSource(`${window.API_BASE}/live/events`, { withCredentials: true });
  playerLiveEvents.addEventListener("update", () => loadPlayerDashboard());
  playerLiveEvents.onopen = () => {
    const status = document.getElementById("playerLiveStatus");
    if (status) status.textContent = "Live · connected";
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
    const [matchesData, detectionsData, securityData, profileData] = await Promise.all([
      loadSection("matches", "/player/matches"),
      loadSection("detections", "/player/detections"),
      loadSection("account security", "/player/security"),
      loadSection("profile", "/player/profile")
    ]);

    const matches = Array.isArray(matchesData?.matches) ? matchesData.matches : [];
    const detections = Array.isArray(detectionsData?.detections) ? detectionsData.detections : [];
    const history = Array.isArray(securityData?.login_history) ? securityData.login_history : [];
    const activeSessions = Array.isArray(securityData?.active_sessions) ? securityData.active_sessions : [];
    const risk = securityData?.risk_score;

    const insightText = document.getElementById("overviewInsightText");
    const trendValue = document.getElementById("overviewTrendValue");
    const trendChart = document.getElementById("overviewRiskTrend");
    if (insightText) {
      const completed = matches.filter((match) => String(match.status).toLowerCase() === "completed").length;
      insightText.textContent = matchesData
        ? `${matches.length} match${matches.length === 1 ? "" : "es"} tracked · ${completed} completed · ${detections.length} security event${detections.length === 1 ? "" : "s"} recorded.`
        : "Match activity will appear here once your dashboard can reach the server.";
    }
    if (trendChart) {
      const scoredMatches = matches.filter((match) => match.risk_score != null && Number.isFinite(Number(match.risk_score))).slice(0, 6).reverse();
      if (!matchesData) {
        trendChart.innerHTML = '<span class="overview-trend-empty">Match data unavailable</span>';
      } else if (!scoredMatches.length) {
        trendChart.innerHTML = '<span class="overview-trend-empty">Complete a reviewed match to see your trend</span>';
      } else {
        trendChart.innerHTML = scoredMatches.map((match) => {
          const score = Math.max(0, Math.min(100, Number(match.risk_score)));
          const level = score >= 70 ? "high" : score >= 35 ? "medium" : "low";
          return `<span class="overview-trend-bar" data-level="${level}" style="--bar-height:${Math.max(8, score)}%" title="Match ${playerText(match.match_id || "—")}: ${score.toFixed(1)} / 100 risk" aria-hidden="true"></span>`;
        }).join("");
      }
    }
    if (trendValue) {
      const latestScoredMatch = matches.find((match) => match.risk_score != null && Number.isFinite(Number(match.risk_score)));
      trendValue.textContent = latestScoredMatch ? `${Number(latestScoredMatch.risk_score).toFixed(1)} / 100` : risk != null ? `${Number(risk).toFixed(1)} / 100` : "Waiting for analysis";
    }

    document.getElementById("matchesCount").textContent = matchesData ? matches.length : "Unavailable";
    document.getElementById("mfaStatus").textContent = securityData ? securityData.mfa_status === "enabled" ? "Enabled" : "Disabled" : "Unavailable";
    document.getElementById("accountStatus").textContent = securityData ? securityData.account_status === "active" ? "Protected" : "Suspended" : "Unavailable";
    document.getElementById("accountStatus").classList.toggle("success-text", securityData?.account_status === "active");
    document.getElementById("riskScore").textContent = securityData ? playerRisk(risk) : "Unavailable";
    document.getElementById("lastLoginIp").textContent = securityData ? history[0]?.ip_address || "Not recorded" : "Unavailable";

    const matchesList = document.getElementById("matchesList");
    if (matchesList) {
      matchesList.innerHTML = !matchesData
        ? '<div class="match-empty"><strong>Match history unavailable</strong><span>The match service could not be reached. Retry after the API and database are available.</span></div>'
        : matches.map(matchCard).join("") || '<div class="match-empty"><strong>No matches yet</strong><span>Play the FPS Microgame to create your first match record.</span></div>';
    }

    const overviewMatches = document.getElementById("overviewMatchList");
    if (overviewMatches) {
      overviewMatches.innerHTML = !matchesData
        ? '<div class="match-empty"><strong>Match history unavailable</strong><span>Could not load match data from the server.</span></div>'
        : matches.slice(0, 3).map((match) => `<div class="overview-match-row"><div><strong>Match ${playerText(match.match_id || "—")}</strong><small>${playerText(playerDate(match.date))} · ${playerText(match.status || "unknown")}</small></div><strong>${playerText(playerRisk(match.risk_score))}</strong></div>`).join("") || '<div class="match-empty"><strong>No match history</strong><span>Your FPS Microgame sessions will appear here.</span></div>';
    }

    const detectionsList = document.getElementById("detectionsList");
    if (detectionsList) {
      detectionsList.innerHTML = detections.map((detection) => {
        const severity = String(detection.severity || "low").toLowerCase();
        const badge = ["high", "critical"].includes(severity) ? "bad" : severity === "medium" ? "warn" : "good";
        return `<article class="detection-card">
          <div class="detection-card-header"><h3>${playerText(detection.type || "Gameplay event")}</h3><span class="badge ${badge}">${playerText(severity)}</span></div>
          <p>${playerText(detection.description || "Security event recorded.")}</p>
          <div class="detection-meta"><span>${playerText(playerDate(detection.timestamp))}</span><strong>Risk ${playerText(playerRisk(detection.risk_score ?? detection.confidence))}</strong></div>
        </article>`;
      }).join("") || (!detectionsData
        ? '<div class="detection-empty"><strong>Detections unavailable</strong><span>Could not load security events from the server.</span></div>'
        : '<div class="detection-empty"><strong>No detections recorded</strong><span>Security analysis appears here after a match is completed.</span></div>');
    }

    const overviewDetections = document.getElementById("overviewDetectionList");
    if (overviewDetections) {
      overviewDetections.innerHTML = !detectionsData
        ? '<div class="detection-empty"><strong>Security review unavailable</strong><span>Could not load security events from the server.</span></div>'
        : detections.slice(0, 2).map((detection) => `<div class="overview-detection-row"><strong>${playerText(detection.type || "Gameplay event")}</strong><small>${playerText(playerDate(detection.timestamp))} · ${playerText(detection.severity || "low")}</small><p>${playerText(detection.description || "Security event recorded.")}</p></div>`).join("") || '<div class="detection-empty"><strong>No security events</strong><span>Completed match reviews will appear here.</span></div>';
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
    const detectionList = document.getElementById("detectionsList");
    if (detectionList) detectionList.innerHTML = '<div class="detection-empty"><strong>Security events unavailable</strong><span>Reconnect to the API and database to load detections.</span></div>';
    const overviewMatches = document.getElementById("overviewMatchList");
    if (overviewMatches) overviewMatches.innerHTML = '<div class="match-empty"><strong>Match history unavailable</strong><span>Reconnect to the API and database to load saved matches.</span></div>';
    const overviewDetections = document.getElementById("overviewDetectionList");
    if (overviewDetections) overviewDetections.innerHTML = '<div class="detection-empty"><strong>Security review unavailable</strong><span>Reconnect to the API and database to load security events.</span></div>';
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
    try { await api("/auth/logout", { method: "POST" }); } catch (error) { console.error(error); }
    window.location.href = "login.html";
  });
}

const fpsMicrogameBtn = document.getElementById("fpsMicrogameBtn");
if (fpsMicrogameBtn) fpsMicrogameBtn.addEventListener("click", () => { window.location.href = "game.html"; });

loadPlayerDashboard();
playerRefreshTimer = setInterval(loadPlayerDashboard, 15000);
