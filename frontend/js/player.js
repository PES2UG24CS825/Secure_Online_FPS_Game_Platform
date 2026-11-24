const playerText = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

function escapeHtml(value) {
  return playerText(value);
}
window.escapeHtml = escapeHtml;

const playerDate = (value, includeTime = false) => {
  if (!value) return "—";
  const date = new Date(typeof value === 'string' && value.includes('T') && !/(Z|[+-]\d{2}:\d{2})$/.test(value) ? `${value}Z` : value);
  if (Number.isNaN(date.getTime())) return "—";
  const options = { year: 'numeric', month: 'short', day: 'numeric' };
  if (includeTime) Object.assign(options, { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleString(undefined, options);
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
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = pad(date.getDate());
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${day} ${month} ${year}, ${hours}:${minutes}:${seconds}`;
};



let playerDashboardLoading = false;
let appearanceControlsBound = false;
let avatarOptions = [];
let savedPortrait = null;
let appearanceSaving = false;
let currentAppearance = { avatar: null, banner: "sakura", avatar_image: null, banner_image: null };
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
  const score = match.risk_score == null ? null : Number(match.risk_score);
  const reportedSeverity = String(match.alert_severity || "").toLowerCase();
  const severity = ["critical", "high", "medium", "low"].includes(reportedSeverity)
    ? reportedSeverity
    : score == null ? "unknown" : score >= 75 ? "high" : score >= 50 ? "medium" : "low";
  const honourReward = match.honour_awarded == null ? "" : ` and +${Number(match.honour_awarded)} Honour`;
  const rewardTransaction = match.reward_credit?.transaction;
  const rewardNotice = rewardTransaction
    ? `Server reward: +${Number(rewardTransaction.xp || 0)} XP and +${Number(rewardTransaction.coins || 0)} coins${honourReward}.`
    : `Match reward is pending${honourReward}.`;
  const title = document.getElementById("matchReviewTitle");
  const message = document.getElementById("matchReviewMessage");
  const countdown = document.getElementById("matchReviewCountdown");
  const icon = document.getElementById("matchReviewIcon");
  toast.dataset.severity = severity;
  if (icon) icon.textContent = ["critical", "high", "medium"].includes(severity) ? "!" : severity === "unknown" ? "i" : "✓";
  if (title) title.textContent = ["critical", "high", "medium"].includes(severity)
    ? `${severity.toUpperCase()} GAMEPLAY SIGNAL`
    : severity === "unknown" ? "MATCH REVIEW INCOMPLETE" : "MATCH COMPLETE";
  if (message) {
    const review = ["critical", "high", "medium"].includes(severity)
      ? `The match review detected a ${severity} signal${score == null ? "." : ` with a risk score of ${score.toFixed(1)} / 100.`}`
      : severity === "unknown"
        ? "Your match was saved. Security analysis is incomplete because more gameplay data is needed."
        : `No elevated gameplay signal was reported${score == null ? "." : `. Match risk score: ${score.toFixed(1)} / 100.`}`;
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
  playerLiveEvents.addEventListener("update", event => {
    loadPlayerDashboard();
    try {
      const update = JSON.parse(event.data);
      if ((update.type === "analysis_complete" || update.type === "reward_credit") && typeof loadRewards === "function") {
        loadRewards();
      }
    } catch {
      // The dashboard refresh above still runs for updates without a payload.
    }
  });
  playerLiveEvents.onopen = () => {
    window.refreshPlayerNotifications?.();
    const status = document.getElementById("playerLiveStatus");
    if (status) status.textContent = `Live · updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  };
  playerLiveEvents.onerror = () => {
    const status = document.getElementById("playerLiveStatus");
    if (status) status.textContent = "Reconnecting · refresh active";
  };
}

window.addEventListener("pagehide", () => {
  if (playerLiveEvents) {
    playerLiveEvents.close();
    playerLiveEvents = null;
  }
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted && !playerLiveEvents) {
    connectPlayerLiveEvents();
  }
});

function matchCard(match) {
  const value = (field) => match[field] == null ? "—" : Number(match[field]);
  const state = String(match.status || "unknown").toLowerCase();
  const badge = state === "terminated_banned" ? "bad" : state === "completed" ? "good" : state === "active" ? "warn" : "gray";
  const duration = match.duration == null ? "—" : `${Math.max(0, Number(match.duration))}s`;
  const accuracyStr = match.accuracy == null ? "—" : `${Number(match.accuracy).toFixed(1)}%`;
  const reward = match.reward_credit?.transaction || null;
  const rewardStatus = String(match.reward_credit?.status || "pending");
  const rewardText = reward
    ? `Rewards: +${Number(reward.xp || 0)} XP · +${Number(reward.coins || 0)} Coins`
    : rewardStatus === "credited" ? "Rewards: credited" : "Rewards: pending";
  const analysisStatus = String(match.analysis_status || "pending").replaceAll("_", " ");
  return `<article class="match-card" data-session-id="${escapeHtml(match.session_id || match.id || match.match_id)}">
    <div class="match-card-head"><div><span class="match-card-kicker">${escapeHtml(match.game || "CyberStrike 3D")}${match.demo_test ? ` · ${playerText(match.hacker_profile || "hacker demo")}` : ""}</span><h3>Match ${playerText(match.match_id || "—")}</h3><div class="match-card-date">${playerText(playerDate(match.date))}</div></div><div style="display:flex; align-items:center; gap:8px;"><button type="button" class="match-drilldown-btn ghost-btn" data-session-id="${escapeHtml(match.session_id || match.id || match.match_id)}" style="background:transparent; border:1px solid var(--player-border,#38bdf8); border-radius:4px; padding:3px 8px; color:var(--player-blue,#38bdf8); cursor:pointer; font-size:11px;">Details</button><span class="badge ${badge}">${playerText(state === "terminated_banned" ? "PERMANENTLY BANNED" : state)}</span></div></div>
    <div class="match-stat-grid"><div class="match-stat"><span>Kills</span><strong>${value("kills")}</strong></div><div class="match-stat"><span>Deaths</span><strong>${value("deaths")}</strong></div><div class="match-stat"><span>K/D</span><strong>${match.kd == null ? "—" : Number(match.kd).toFixed(2)}</strong></div><div class="match-stat"><span>Total Shots Fired</span><strong>${value("shots_fired")}</strong></div><div class="match-stat"><span>Successful Hits</span><strong>${value("shots_hit")}</strong></div><div class="match-stat"><span>Accuracy</span><strong>${accuracyStr}</strong></div><div class="match-stat"><span>Duration</span><strong>${duration}</strong></div><div class="match-stat"><span>Analysis</span><strong>${playerText(analysisStatus)}</strong></div></div>
    <div class="match-risk"><span>Security risk score</span><strong>${playerText(playerRisk(match.risk_score))} ${match.risk_category ? `<span class="badge ${match.risk_category === 'Normal' ? 'good' : match.risk_category === 'Monitoring' ? 'warn' : 'bad'}">${escapeHtml(match.risk_category)}</span>` : ''}</strong></div>
    <div class="match-features-strip" style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; padding-top:10px; border-top:1px solid rgba(148,163,184,0.18); font-size:11px;">
      <span style="background:rgba(14,165,233,0.1); color:#0284c7; padding:4px 10px; border-radius:6px; font-weight:600;">🛡️ Fair Play Verified</span>
      <span style="background:rgba(245,158,11,0.1); color:#d97706; padding:4px 10px; border-radius:6px; font-weight:600;">⭐ ${escapeHtml(rewardText)}</span>
    </div>
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
      window.location.replace("login.html?next=game.html");
      return;
    }
    connectPlayerLiveEvents();

    const user = me.user;
    const name = user.name || "Player";
    const sideName = document.getElementById("sideName");
    const sideEmail = document.getElementById("sideEmail");
    const avatar = document.getElementById("avatar");
    const miniProfile = avatar?.closest(".mini-profile");
    const handle = document.getElementById("profileUsername");
    handle.hidden = !user.username;
    handle.textContent = user.username ? "@" + user.username : "";
    if (sideName) sideName.textContent = user.username ? "@" + user.username : name;
    if (sideEmail) sideEmail.textContent = user.email || "";
    if (miniProfile) miniProfile.title = [name, user.email].filter(Boolean).join(" · ");
    if (avatar) {
      avatar.textContent = name.charAt(0).toUpperCase();
      avatar.setAttribute("aria-label", `Player account: ${[name, user.email].filter(Boolean).join(", ")}`);
      avatar.title = miniProfile?.title || name;
    }

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
    const [matchesData, securityData, profileData, statsData, rewardsData] = await Promise.all([
      loadSection("matches", "/player/matches"),
      loadSection("account security", "/player/security"),
      loadSection("profile", "/player/profile"),
      loadSection("stats", "/player/stats"),
      loadSection("rewards", "/player/rewards")
    ]);

    const matches = Array.isArray(matchesData?.matches) ? matchesData.matches : [];
    const completedMatches = matches;
    latestPlayerMatchId = completedMatches[0]?.id || "";
    const history = Array.isArray(securityData?.login_history) ? securityData.login_history : [];
    const activeSessions = Array.isArray(securityData?.active_sessions) ? securityData.active_sessions : [];
    if (securityData) {
      const honourScore = Number(securityData.honour_score ?? 100);
      if (honourScore < 80) {
        const noticeKey = `securefps_honour_warning:${user.email || "account"}:${honourScore}`;
        if (localStorage.getItem(noticeKey) !== "shown") {
          const message = `Honour is ${honourScore}/100. You can keep playing; unfinished matches reduce Honour by 5.`;
          window.showAppToast?.(message, "warning");
          localStorage.setItem(noticeKey, "shown");
        }
      }
    }
    const latestScoredMatch = completedMatches.find((match) => match.risk_score != null && Number.isFinite(Number(match.risk_score)));
    const risk = latestScoredMatch ? Number(latestScoredMatch.risk_score) : securityData?.risk_score;

    const trendChart = document.getElementById("overviewRiskTrend");
    if (trendChart) {
      const scoredMatches = completedMatches.filter((match) => match.risk_score != null && Number.isFinite(Number(match.risk_score))).slice(0, 9).reverse();
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
          <text class="chart-zone-label" x="4" y="23">100</text>
          <text class="chart-zone-label" x="4" y="69">50</text>
          <text class="chart-zone-label" x="4" y="115">0</text>
          <polygon class="chart-area" points="${areaPath}"></polygon>
          <polyline points="${path}"></polyline>
          ${points.map((point) => `<circle class="${point === last ? "latest" : ""}" cx="${point.x}" cy="${point.y}" r="${point === last ? 4.5 : 3.5}" tabindex="0" data-match="${playerText(point.match.match_id || "Match")}" data-score="${point.score.toFixed(1)}"></circle>`).join("")}
        </svg><div class="risk-chart-tooltip" hidden></div>`;
        const tooltip = trendChart.querySelector(".risk-chart-tooltip");
        trendChart.querySelectorAll("circle").forEach((point) => {
          const showTooltip = () => {
            if (!tooltip) return;
            tooltip.textContent = `${point.dataset.match} · Risk score ${point.dataset.score} / 100`;
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

    const analyzedMatches = completedMatches.filter((match) => match.risk_score != null && Number.isFinite(Number(match.risk_score)));
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
    if (topFactor) topFactor.textContent = latestScoredMatch?.human_evaluation?.explanation
      ? `Server assessment: ${latestScoredMatch.human_evaluation.explanation}`
      : "Server assessment: awaiting completed match analysis";

    const matchesCountEl = document.getElementById("matchesCount");
    if (matchesCountEl) matchesCountEl.textContent = matchesData ? Number(matchesData.total_matches ?? completedMatches.length) : "Unavailable";
    const matchesSummary = document.getElementById("matchesSummary");
    if (matchesSummary) matchesSummary.textContent = matchesData
      ? `${analyzedMatches.length} analyzed · ${Math.max(0, completedMatches.length - analyzedMatches.length)} awaiting review`
      : "Match history unavailable";

    // Populate Combat Career Lifetime Overview Statistics
    const sumRecorded = (key) => {
      const values = completedMatches.map(match => match[key]).filter(value => value != null && Number.isFinite(Number(value)));
      if (values.length) return values.reduce((sum, value) => sum + Number(value), 0);
      return matchesData && Number(matchesData.total_matches) === 0 ? 0 : null;
    };
    const totalKills = statsData?.kills ?? sumRecorded("kills");
    const totalDeaths = statsData?.deaths ?? sumRecorded("deaths");
    const careerKd = totalKills == null || totalDeaths == null
      ? null : Number(totalDeaths) > 0 ? Number(totalKills) / Number(totalDeaths) : Number(totalKills);
    const shotValues = completedMatches.map(match => match.shots_fired).filter(value => value != null);
    const hitValues = completedMatches.map(match => match.shots_hit).filter(value => value != null);
    const totalShots = statsData?.shots_fired ?? (shotValues.length ? shotValues.reduce((sum, value) => sum + Number(value), 0) : null);
    const totalHits = statsData?.shots_hit ?? (hitValues.length ? hitValues.reduce((sum, value) => sum + Number(value), 0) : null);
    const careerAcc = totalShots != null && totalHits != null && Number(totalShots) > 0
      ? (Number(totalHits) / Number(totalShots)) * 100
      : null;
    const totalMatchesCount = statsData?.total_matches ?? Number(matchesData?.total_matches ?? completedMatches.length);

    const careerKillsEl = document.getElementById("careerTotalKills");
    if (careerKillsEl) careerKillsEl.textContent = totalKills == null ? "—" : Number(totalKills).toLocaleString();

    const careerDeathsEl = document.getElementById("careerTotalDeaths");
    if (careerDeathsEl) careerDeathsEl.textContent = totalDeaths == null ? "—" : Number(totalDeaths).toLocaleString();

    const careerKdEl = document.getElementById("careerKd");
    if (careerKdEl) careerKdEl.textContent = careerKd == null ? "—" : Number(careerKd).toFixed(2);

    const careerAccEl = document.getElementById("careerAccuracy");
    if (careerAccEl) careerAccEl.textContent = careerAcc == null ? "—" : `${careerAcc.toFixed(1)}%`;

    const careerShotsEl = document.getElementById("careerShotsSummary");
    if (careerShotsEl) careerShotsEl.textContent = careerAcc == null
      ? "Shot totals unavailable or zero"
      : `${totalHits.toLocaleString()} / ${totalShots.toLocaleString()} recorded hits / shots`;
    const careerShotsCountEl = document.getElementById("careerTotalShots");
    if (careerShotsCountEl) careerShotsCountEl.textContent = totalShots == null ? "—" : Number(totalShots).toLocaleString();
    const careerHitsCountEl = document.getElementById("careerTotalHits");
    if (careerHitsCountEl) careerHitsCountEl.textContent = totalHits == null ? "—" : Number(totalHits).toLocaleString();
    const coverageText = (coverage, value) => value == null || coverage === "unavailable"
      ? "Unavailable"
      : coverage === "partial" ? "Partial — some match history unavailable" : "Complete match history";
    const shotsCoverageEl = document.getElementById("careerShotsCoverage");
    if (shotsCoverageEl) shotsCoverageEl.textContent = coverageText(statsData?.shots_fired_coverage, totalShots);
    const hitsCoverageEl = document.getElementById("careerHitsCoverage");
    if (hitsCoverageEl) hitsCoverageEl.textContent = coverageText(statsData?.shots_hit_coverage, totalHits);

    const careerMatchesEl = document.getElementById("careerMatches");
    if (careerMatchesEl) careerMatchesEl.textContent = totalMatchesCount;

    const careerWinRateEl = document.getElementById("careerWinRate");
    if (careerWinRateEl) careerWinRateEl.textContent = statsData?.verified_matches
      ? `${statsData.wins}W · ${statsData.losses}L · ${statsData.draws}D · ${statsData.win_rate}% win rate`
      : "No verified multiplayer results";
    const careerAssistsEl = document.getElementById("careerAssists");
    if (careerAssistsEl) careerAssistsEl.textContent = statsData?.assists ?? "—";
    const careerHeadshotsEl = document.getElementById("careerHeadshots");
    if (careerHeadshotsEl) careerHeadshotsEl.textContent = statsData?.headshots ?? "—";
    const headshotCoverageEl = document.getElementById("careerHeadshotsCoverage");
    if (headshotCoverageEl) {
      const coverage = statsData?.headshots_coverage;
      headshotCoverageEl.textContent = coverage === "complete" ? "Complete history"
        : coverage === "partial" ? "Partial history" : "Unavailable";
    }
    const careerHeadshotRateEl = document.getElementById("careerHeadshotRate");
    if (careerHeadshotRateEl) careerHeadshotRateEl.textContent = statsData?.headshot_percentage == null
      ? "Verified matches" : `${statsData.headshot_percentage}% of verified hits`;
    const playtimeMinutes = Math.floor((statsData?.total_playtime_seconds ?? 0) / 60);
    const careerPlaytimeEl = document.getElementById("careerPlaytime");
    if (careerPlaytimeEl) careerPlaytimeEl.textContent = statsData ? `${Math.floor(playtimeMinutes / 60)}h ${playtimeMinutes % 60}m` : "—";
    const mfaStatusEl = document.getElementById("mfaStatus");
    if (mfaStatusEl) mfaStatusEl.textContent = securityData ? securityData.mfa_status === "enabled" ? "On" : "Off" : "Unavailable";
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
    const lastLoginIpEl = document.getElementById("lastLoginIp");
    if (lastLoginIpEl) lastLoginIpEl.textContent = securityData ? history[0]?.ip_address || "Not recorded" : "Unavailable";

    const matchesList = document.getElementById("matchesList");
    if (matchesList) {
      matchesList.innerHTML = !matchesData
        ? '<div class="match-empty"><strong>Match history unavailable</strong><span>The match service could not be reached. Retry after the API and database are available.</span></div>'
        : completedMatches.slice(0, 10).map(matchCard).join("") || '<div class="match-empty"><strong>No completed matches yet</strong><span>Finish a match to see your results and security review here.</span><a class="play-btn" href="#games" data-section="games">Play FPS Microgame</a></div>';
    }

    const recentRows = document.getElementById("overviewRecentRows");
    if (recentRows) recentRows.innerHTML = !matchesData
      ? '<tr><td colspan="7">Match history unavailable.</td></tr>'
      : completedMatches.slice(0, 3).map((match) => `<tr data-session-id="${playerText(match.session_id || match.id || match.match_id)}"><td><strong>${playerText(match.match_id || "—")}</strong></td><td>${playerText(overviewDate(match.date))}</td><td>${match.kills ?? "—"} / ${match.deaths ?? "—"}</td><td>${match.accuracy == null ? "—" : `${Number(match.accuracy).toFixed(0)}%`}</td><td>${match.headshot_ratio == null ? "—" : `${(Number(match.headshot_ratio) * 100).toFixed(0)}%`}</td><td>${overviewRiskBadge(match)}</td><td><button type="button" class="match-drilldown-btn ghost-btn" data-session-id="${playerText(match.session_id || match.id || match.match_id)}" style="background:transparent; border:none; color:var(--player-blue,#38bdf8); cursor:pointer; font-weight:600;">Details</button></td></tr>`).join("") || '<tr><td colspan="7">No completed matches yet. <a href="#games" data-section="games">Play now</a></td></tr>';
    const returnedFromGame = sessionStorage.getItem("securefps_game_completed") === "1";
    if (returnedFromGame) {
      sessionStorage.removeItem("securefps_game_completed");
      const previousMatch = sessionStorage.getItem("securefps_match_before_game") || "";
      sessionStorage.removeItem("securefps_match_before_game");
      const completedMatch = completedMatches[0];
      if (completedMatch && completedMatch.id !== previousMatch) {
        showMatchReview(completedMatch);
        const honourScore = Number(securityData?.honour_score ?? 100);
        const honourAwarded = Number(completedMatch.honour_awarded ?? 0);
        const honourMessage = honourAwarded > 0
          ? `Honour increased by ${honourAwarded} to ${honourScore}/100.`
          : `Match complete. Honour score: ${honourScore}/100.`;
        window.showAppToast?.(honourMessage, "success");
      }
    }
    const abandonNotice = sessionStorage.getItem("securefps_abandon_notice");
    if (abandonNotice) {
      sessionStorage.removeItem("securefps_abandon_notice");
      window.showAppToast?.(abandonNotice, "warning");
    }

    // Banned & Suspended overlay check (Items 4, 14)
    const effectiveStatus = profileData?.account_status || securityData?.account_status || "active";
    const bannedOverlay = document.getElementById("bannedScreenOverlay");
    if (bannedOverlay) {
      if (effectiveStatus === "banned" || effectiveStatus === "suspended") {
        bannedOverlay.hidden = false;
        const reasonText = document.getElementById("bannedReasonText");
        if (reasonText) {
          reasonText.textContent = profileData?.ban_reason || securityData?.ban_reason || "Account restricted due to fair-play security violation.";
        }

      } else {
        bannedOverlay.hidden = true;
      }
    }

    loadBanAppealStatus();
    // Notification center data load
    window.refreshPlayerNotifications?.();

    const securityStatus = document.getElementById("securityStatus");
    if (securityStatus && securityData) {
      const loginHistoryOpen = document.getElementById("playerLoginHistory")?.open || false;
      const warnings = securityData.security_warnings || [];
      securityStatus.innerHTML = `
        <div class="account-security-facts">
          <article class="security-card"><div class="security-card-label">Account status</div><strong>${playerText(accountStatusLabels[securityData.account_status] || "Unavailable")}</strong></article>
          <article class="security-card"><div class="security-card-label">Authenticator</div><strong>${securityData.mfa_status === "enabled" ? "Enabled" : "Disabled"}</strong></article>
          <article class="security-card"><div class="security-card-label">Verified recovery address</div><strong>${playerText(securityData.recovery_email || "Unavailable")}</strong></article>
          <article class="security-card"><div class="security-card-label">Last successful sign-in</div><strong>${playerText(playerDate(securityData.last_login, true))}</strong></article>
        </div>
        ${warnings.length ? `<section class="security-history security-warnings"><h3>Account warnings</h3>${warnings.map(warning => `<p><strong>${playerText(playerDate(warning.created_at, true))}</strong> · ${playerText(warning.note)}</p>`).join("")}</section>` : ""}
        <details class="security-history" id="playerLoginHistory"><summary>Sign-in history (${history.length})</summary>
          <div class="overview-table-wrap"><table class="overview-recent-table">
            <thead><tr><th>Time</th><th>Browser / OS</th><th>IP address</th><th>Result</th></tr></thead>
            <tbody>${history.map(entry => `<tr><td>${playerText(playerDate(entry.timestamp, true))}</td><td>${playerText(entry.browser || "Unknown")} / ${playerText(entry.os || "Unknown")}</td><td>${playerText(entry.ip_address || "Unknown")}</td><td>${entry.success === false ? "Failed" : "Successful"}</td></tr>`).join("") || '<tr><td colspan="4">No sign-ins recorded.</td></tr>'}</tbody>
          </table></div>
        </details>`;
      document.getElementById("playerLoginHistory").open = loginHistoryOpen;
    }
    if (securityStatus && !securityData) securityStatus.textContent = "Account security unavailable.";

    const sessionRows = document.getElementById("activeSessionsRows");
    if (sessionRows) sessionRows.innerHTML = securityData ? activeSessions.map(device => `
      <tr><td>${playerText(device.device || "Unknown device")}</td><td>${playerText(device.ip_address || "Unknown")}</td>
      <td>${playerText(playerDate(device.last_activity, true))}</td>
      <td>${device.is_current ? "This device" : `<button type="button" class="ghost-btn" data-revoke-device="${playerText(device.id)}">Sign out</button>`}</td></tr>
    `).join("") || '<tr><td colspan="4">No active sessions.</td></tr>' : '<tr><td colspan="4">Sessions unavailable.</td></tr>';

    document.getElementById("profileContent").textContent = profileData?.created_at ? `Member since ${playerDate(profileData.created_at)}` : "";
    document.getElementById("profileLevel").textContent = rewardsData ? `Level ${rewardsData.level}` : "Level unavailable";
    document.getElementById("profileXp").textContent = rewardsData ? `${Number(rewardsData.xp).toLocaleString()} XP` : "—";
    const profileProgress = document.getElementById("profileXpProgress");
    profileProgress.hidden = !rewardsData;
    profileProgress.max = rewardsData?.xp_per_level || 250;
    profileProgress.value = rewardsData ? rewardsData.xp % profileProgress.max : 0;
    document.getElementById("profileXpRemaining").textContent = rewardsData
      ? `${(profileProgress.max - profileProgress.value).toLocaleString()} XP to level ${rewardsData.level + 1}` : "";
    const previousLevel = profileProgress.dataset.level;
    if (rewardsData && previousLevel && Number(previousLevel) < rewardsData.level) {
      window.showAppToast?.(`Rewards level ${rewardsData.level} reached.`, "success");
    }
    if (rewardsData) profileProgress.dataset.level = rewardsData.level;

    if (profileData) avatarOptions = profileData.avatar_options || [];
    if (profileData && !appearanceDirty && !appearanceSaving) {
      savedPortrait = profileData.avatar;
      const savedBanner = profileData?.profile_customization?.banner;
      const customAvatar = savedPortrait?.key === "custom" ? savedPortrait.src : null;
      const customBanner = profileData?.profile_customization?.banner_url || profileData?.profile_customization?.banner_image || null;
      currentAppearance = {
        avatar: savedPortrait?.key,
        banner: savedBanner || "default-banner",
        avatar_image: customAvatar,
        banner_image: customBanner
      };
    }
    const profileDisplayName = document.getElementById("profileDisplayName");
    const profileDisplayEmail = document.getElementById("profileDisplayEmail");
    renderPlayerAppearance = () => {
      const banner = document.getElementById("profileBanner");
      banner.dataset.banner = currentAppearance.banner;
      banner.style.backgroundImage = currentAppearance.banner_image
        ? `url(${JSON.stringify(currentAppearance.banner_image)})` : "";
      const selected = savedPortrait?.key === currentAppearance.avatar
        ? savedPortrait : avatarOptions.find(option => option.key === currentAppearance.avatar);
      window.profileAvatars.show(selected, name);
      document.querySelectorAll("#bannerOptions [data-banner]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.banner === currentAppearance.banner)));
    };
    if (profileDisplayName) profileDisplayName.textContent = name;
    if (profileDisplayEmail) profileDisplayEmail.textContent = user.email || "";
    renderPlayerAppearance();

    const bannerContainer = document.getElementById("bannerOptions");
    const avatarContainer = document.getElementById("avatarOptions");
    const banners = [
      { key: "sakura", name: "Cosmic Sakura" },
      { key: "frontline", name: "Sakura Frontline" },
      { key: "dawn", name: "Sakura Dawn" },
      { key: "neon", name: "Neon Sakura" }
    ];

    if (avatarContainer && profileData) {
      const freeAvatarKeys = new Set(["chibi-male-1", "chibi-male-2", "chibi-female-1", "chibi-female-2"]);
      const freeOptions = avatarOptions.filter(option => freeAvatarKeys.has(option.key));
      const ownedOptions = avatarOptions.filter(option => !freeAvatarKeys.has(option.key) && option.key !== "custom");
      window.profileAvatars.renderPicker(avatarContainer, freeOptions, currentAppearance.avatar);
      const ownedGallery = document.getElementById("ownedAppearanceGallery");
      const ownedContainer = document.getElementById("ownedAvatarOptions");
      if (ownedGallery && ownedContainer) {
        ownedGallery.hidden = ownedOptions.length === 0;
        if (ownedOptions.length) window.profileAvatars.renderPicker(ownedContainer, ownedOptions, currentAppearance.avatar);
      }
    }
    if (bannerContainer) {
      bannerContainer.innerHTML = banners.map(b => `
        <button class="appearance-option banner-option" type="button" data-banner="${b.key}" aria-label="${b.name}" title="${b.name}" aria-pressed="${String(b.key === currentAppearance.banner)}"></button>
      `).join("");
    }

    if (!appearanceControlsBound) {
      appearanceControlsBound = true;
      document.getElementById("bannerOptions")?.addEventListener("click", (event) => {
        const option = event.target.closest("[data-banner]");
        if (!option || appearanceSaving) return;
        currentAppearance.banner = option.dataset.banner;
        currentAppearance.banner_image = null;
        appearanceDirty = true;
        renderPlayerAppearance();
      });
      document.getElementById("avatarOptions")?.addEventListener("click", (event) => {
        const option = event.target.closest("[data-avatar]");
        if (!option || appearanceSaving) return;
        currentAppearance.avatar = option.dataset.avatar;
        currentAppearance.avatar_image = currentAppearance.avatar === "custom" && savedPortrait?.key === "custom" ? savedPortrait.src : null;
        appearanceDirty = true;
        renderPlayerAppearance();
      });
      document.getElementById("ownedAvatarOptions")?.addEventListener("click", (event) => {
        const option = event.target.closest("[data-avatar]");
        if (!option || appearanceSaving) return;
        currentAppearance.avatar = option.dataset.avatar;
        currentAppearance.avatar_image = null;
        appearanceDirty = true;
        renderPlayerAppearance();
      });
      document.getElementById("restoreAppearance")?.addEventListener("click", () => {
        if (appearanceSaving) return;
        currentAppearance.avatar = "chibi-male-1";
        currentAppearance.banner = "sakura";
        currentAppearance.avatar_image = null;
        currentAppearance.banner_image = null;
        appearanceDirty = true;
        renderPlayerAppearance();
      });
      document.getElementById("saveAppearance")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const status = document.getElementById("appearanceStatus");
      if (!currentAppearance.avatar) return;
      appearanceSaving = true;
      button.disabled = true;
      if (status) status.textContent = "Saving…";
      try {
        const saved = await api("/player/profile/customization", { method: "PUT", body: JSON.stringify({
          ...currentAppearance,
          avatar_image: currentAppearance.avatar_image?.startsWith("data:") ? currentAppearance.avatar_image : null,
          banner_image: currentAppearance.banner_image?.startsWith("data:") ? currentAppearance.banner_image : null,
        }) });
        savedPortrait = saved.avatar;
        appearanceDirty = false;
        renderPlayerAppearance();
        if (status) status.textContent = "Appearance saved.";
        loadLeaderboard();
      } catch (saveError) {
        console.error("Could not save profile appearance", saveError);
        if (status) status.textContent = saveError.status === 401 ? "Sign in again to save." : saveError.message || "Could not save appearance.";
      } finally {
        appearanceSaving = false;
        button.disabled = false;
      }
      });
    }
    if (failedSections.length) {
      const notice = document.getElementById("dashboardNotice");
      if (notice) {
        notice.hidden = false;
        notice.textContent = `Player API request failed: ${failedSections.join("; ")}.`;
        notice.classList.remove("security-warning-notice");
      }
      const liveStatus = document.getElementById("playerLiveStatus");
      if (liveStatus) liveStatus.textContent = "Connection issue";
    } else {
      const notice = document.getElementById("dashboardNotice");
      const latestWarning = securityData?.security_warnings?.[0];
      if (notice && latestWarning && latestWarning.note && !latestWarning.note.toLowerCase().includes("noob")) {
        notice.hidden = false;
        notice.textContent = `Security Notice: ${latestWarning.note}`;
        notice.classList.add("security-warning-notice");
      } else if (notice) {
        notice.hidden = true;
        notice.classList.remove("security-warning-notice");
      }
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
    if (securityStatus) securityStatus.innerHTML = '<div class="match-empty"><strong>Account security unavailable</strong><span>Reconnect to the API and database to load account security.</span><button class="play-btn" style="margin-top:10px;padding:6px 14px;border-radius:6px;" onclick="loadPlayerDashboard()">Retry Connection</button></div>';
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

const cyberstrikeBtn = document.getElementById("cyberstrikeBtn");
if (cyberstrikeBtn) cyberstrikeBtn.addEventListener("click", () => {
  sessionStorage.setItem("securefps_match_before_game", latestPlayerMatchId);
  const sideNameEl = document.getElementById("sideName");
  if (sideNameEl && sideNameEl.textContent) {
    sessionStorage.setItem("securefps_player_name", sideNameEl.textContent.trim());
  }
  window.location.href = "public/games/three-fps/index.html";
});

// =========================================================================
// ACCOUNT SECURITY INTERACTIVE CONTROLS
// =========================================================================

const changePasswordForm = document.getElementById("changePasswordForm");
if (changePasswordForm) {
  changePasswordForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cur = document.getElementById("currentPasswordInput")?.value || "";
    const next = document.getElementById("newPasswordInput")?.value || "";
    const confirm = document.getElementById("confirmNewPasswordInput")?.value || "";
    const msg = document.getElementById("changePasswordMsg");

    if (next !== confirm) {
      if (msg) {
        msg.hidden = false;
        msg.style.color = "#EF4444";
        msg.textContent = "New passwords do not match.";
      }
      return;
    }

    try {
      const res = await api("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ current_password: cur, new_password: next, confirm_password: confirm })
      });
      if (msg) {
        msg.hidden = false;
        msg.style.color = "#10B981";
        msg.textContent = res.message || "Password changed successfully!";
      }
      changePasswordForm.reset();
      window.refreshPlayerNotifications?.();
      window.showAppToast?.("Password changed successfully! Other sessions terminated.", "success");
    } catch (err) {
      if (msg) {
        msg.hidden = false;
        msg.style.color = "#EF4444";
        msg.textContent = err.message || "Could not change password.";
      }
    }
  });
}

const generateRecoveryCodesBtn = document.getElementById("generateRecoveryCodesBtn");
const generateRecoveryCodesForm = document.getElementById("generateRecoveryCodesForm");
if (generateRecoveryCodesForm && generateRecoveryCodesBtn) {
  generateRecoveryCodesForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (generateRecoveryCodesBtn.disabled) return;
    const password = document.getElementById("recoveryCurrentPassword").value;
    generateRecoveryCodesForm.reset();
    generateRecoveryCodesBtn.disabled = true;

    const msg = document.getElementById("recoveryCodesMsg");

    try {
      const res = await api("/auth/recovery-codes/generate", {
        method: "POST",
        body: JSON.stringify({ password })
      });
      if (Array.isArray(res.recovery_codes)) {
        const url = URL.createObjectURL(new Blob([res.recovery_codes.join("\n") + "\n"], { type: "text/plain" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "securefps-recovery-codes.txt";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        msg.hidden = false;
        msg.textContent = "New recovery codes downloaded. Store the file securely.";
        window.refreshPlayerNotifications?.();
      }
    } catch (err) {
      if (msg) {
        msg.hidden = false;
        msg.style.color = "#EF4444";
        msg.textContent = err.message || "Could not generate recovery codes.";
      }
    } finally {
      generateRecoveryCodesBtn.disabled = false;
    }
  });
}

document.getElementById("refreshSessionsBtn")?.addEventListener("click", loadPlayerDashboard);
document.getElementById("activeSessionsRows")?.addEventListener("click", async event => {
  const button = event.target.closest("[data-revoke-device]");
  if (!button || !await window.showAppConfirm("Sign out this device?")) return;
  button.disabled = true;
  const status = document.getElementById("revokeSessionsMsg");
  try {
    await api(`/player/sessions/${encodeURIComponent(button.dataset.revokeDevice)}/revoke`, { method: "POST" });
    status.textContent = "Device signed out.";
    loadPlayerDashboard();
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
  status.hidden = false;
});

const revokeOtherSessionsBtn = document.getElementById("revokeOtherSessionsBtn");
if (revokeOtherSessionsBtn) {
  revokeOtherSessionsBtn.addEventListener("click", async () => {
    if (!await window.showAppConfirm("Are you sure you want to log out all other devices and browser sessions?")) return;

    const msg = document.getElementById("revokeSessionsMsg");
    try {
      const res = await api("/player/sessions/revoke-others", { method: "POST" });
      if (msg) {
        msg.hidden = false;
        msg.style.color = "#10B981";
        msg.textContent = res.message || "All other browser sessions revoked successfully.";
      }
      window.showAppToast?.("All other sessions revoked.", "success");
      loadPlayerDashboard();
    } catch (err) {
      if (msg) {
        msg.hidden = false;
        msg.style.color = "#EF4444";
        msg.textContent = err.message || "Could not revoke other sessions.";
      }
    }
  });
}

// =========================================================================
// BAN APPEAL SYSTEM (Items 4, 14)
// =========================================================================

async function loadBanAppealStatus() {
  const statusBox = document.getElementById("banAppealStatusBox");
  const form = document.getElementById("banAppealForm");
  if (!statusBox || !form) return;

  try {
    const res = await api("/player/appeal");
    if (res?.appeal) {
      statusBox.hidden = false;
      const app = res.appeal;
      const badgeColor = app.status === "approved" ? "#10b981" : app.status === "rejected" ? "#ef4444" : "#f59e0b";
      statusBox.innerHTML = `
        <div style="font-size: 13px; line-height: 1.5;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>Appeal Review State:</strong>
            <span style="display:inline-block; padding: 2px 8px; border-radius: 4px; background: ${badgeColor}; color: #fff; font-weight: 700; text-transform: uppercase; font-size: 11px;">${escapeHtml(app.status)}</span>
          </div>
          <p style="margin: 6px 0 0 0; color: var(--player-muted, #94a3b8);">Submitted on: ${escapeHtml(overviewDate(app.created_at))}</p>
          <p style="margin: 4px 0 0 0;"><strong>Your Statement:</strong> ${escapeHtml(app.appeal_text)}</p>
          ${app.admin_note ? `<div style="margin-top: 8px; padding: 8px 12px; background: rgba(0,0,0,0.1); border-left: 3px solid #38bdf8; border-radius: 4px;"><strong>Admin Response:</strong> ${escapeHtml(app.admin_note)}</div>` : ''}
        </div>
      `;
      const profileStatus = document.getElementById("appealStatusContent");
      if (profileStatus) profileStatus.innerHTML = statusBox.innerHTML;
      form.hidden = true;
    } else {
      statusBox.hidden = true;
      form.hidden = false;
    }
  } catch (err) {
    statusBox.hidden = true;
    form.hidden = false;
  }
}

const banAppealForm = document.getElementById("banAppealForm");
if (banAppealForm) {
  banAppealForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const reasonInput = document.getElementById("appealTextInput");
    const msg = document.getElementById("appealStatusNotice");
    const reason = reasonInput?.value?.trim() || "";

    if (Array.from(reason).length < 15) {
      if (msg) {
        msg.hidden = false;
        msg.style.color = "#ef4444";
        msg.textContent = "Please provide at least 15 characters explaining your appeal.";
      }
      return;
    }

    const submitButton = banAppealForm.querySelector('[type=submit]');
    if (submitButton.disabled) return;
    submitButton.disabled = true;
    try {
      const res = await api("/player/appeal", {
        method: "POST",
        body: JSON.stringify({ appeal_text: reason })
      });
      if (msg) {
        msg.hidden = false;
        msg.style.color = "#10b981";
        msg.textContent = res.message || "Appeal submitted for security administrator review.";
      }
      banAppealForm.reset();
      await loadBanAppealStatus();
    } catch (err) {
      if (msg) {
        msg.hidden = false;
        msg.style.color = "#ef4444";
        msg.textContent = err.message || "Could not submit appeal.";
      }
    } finally {
      submitButton.disabled = false;
    }
  });
}

// =========================================================================
// NOTIFICATION CENTER (Item 14)
// =========================================================================

// =========================================================================
// MATCH DETAIL DRILL-DOWN (Item 14)
// =========================================================================

let matchDetailVersion = 0;
async function openMatchDetail(sessionId) {
  const modal = document.getElementById("matchDetailModal");
  const title = document.getElementById("modalMatchTitle");
  const content = document.getElementById("matchDetailContent");
  if (!modal || !content || !sessionId) return;
  const version = ++matchDetailVersion;

  if (title) title.textContent = `Match Detail: ${sessionId || "Drill-Down"}`;
  content.innerHTML = '<p role="status">Loading match details…</p>';
  if (typeof modal.showModal === "function") {
    if (!modal.open) modal.showModal();
  } else {
    modal.setAttribute("open", "");
  }

  try {
    const data = await api(`/player/matches/${encodeURIComponent(sessionId)}`);
    if (version !== matchDetailVersion || !modal.open) return;
    const feats = data.features || {};
    const timeline = data.timeline || [];
    const combatCount = (value) => value == null ? "—" : Number(value).toLocaleString();

    const shotsFired = data.shots_fired != null ? Number(data.shots_fired) : 0;
    const shotsHit = data.shots_hit != null ? Number(data.shots_hit) : 0;
    const headshots = data.headshots != null ? Number(data.headshots) : (feats.headshot_ratio != null && shotsHit ? Math.round(Number(feats.headshot_ratio) * shotsHit) : 0);
    const headshotRatio = data.headshot_ratio != null ? Number(data.headshot_ratio) : (shotsHit > 0 ? (headshots / shotsHit) : 0);
    const bodyHits = data.body_hits != null ? Number(data.body_hits) : Math.max(0, shotsHit - headshots);
    const missedShots = data.missed_shots != null ? Number(data.missed_shots) : Math.max(0, shotsFired - shotsHit);
    const headshotPercentStr = shotsHit > 0 ? (headshotRatio * 100).toFixed(1) + '%' : '0.0%';

    content.innerHTML = `
      <div class="match-features-grid">
        <div class="feat-stat-box"><strong>${combatCount(data.kills)} / ${combatCount(data.deaths)}</strong><small>Kills / Deaths</small></div>
        <div class="feat-stat-box"><strong>${data.kdr == null ? '—' : Number(data.kdr).toFixed(2)}</strong><small>K/D Ratio</small></div>
        <div class="feat-stat-box"><strong>${combatCount(shotsFired)}</strong><small>Total Shots Fired</small></div>
        <div class="feat-stat-box"><strong>${combatCount(shotsHit)}</strong><small>Successful Hits</small></div>
        <div class="feat-stat-box"><strong>${data.accuracy != null ? Number(data.accuracy).toFixed(1) + '%' : '—'}</strong><small>Accuracy Rate</small></div>
        <div class="feat-stat-box"><strong>${data.duration_seconds != null ? data.duration_seconds + 's' : '—'}</strong><small>Duration</small></div>
      </div>

      <h4 style="margin: 14px 0 8px 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--player-muted, #94a3b8);">Combat Ballistics & Headshot Details</h4>
      <div class="match-features-grid">
        <div class="feat-stat-box"><strong>${combatCount(shotsFired)}</strong><small>Total Shots</small></div>
        <div class="feat-stat-box"><strong>${combatCount(shotsHit)}</strong><small>Shots on Target</small></div>
        <div class="feat-stat-box"><strong style="color: #38BDF8;">${combatCount(headshots)}</strong><small>Headshot Hits</small></div>
        <div class="feat-stat-box"><strong style="color: #F59E0B;">${headshotPercentStr}</strong><small>Headshot % of Hits</small></div>
        <div class="feat-stat-box"><strong>${combatCount(bodyHits)}</strong><small>Body / Torso Hits</small></div>
        <div class="feat-stat-box"><strong>${combatCount(missedShots)}</strong><small>Missed Shots</small></div>
      </div>

      <h4 style="margin: 14px 0 8px 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--player-muted, #94a3b8);">Match Combat Timeline</h4>
      <div class="match-timeline" tabindex="0" aria-label="Match combat timeline">
        ${timeline.length ? timeline.map(ev => `
          <div style="display:flex; justify-content:space-between; font-size: 12px; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.05);">
            <span>${ev.type === 'kill' ? '🎯 Eliminated ' + escapeHtml(ev.enemy_id) + ' (' + escapeHtml(ev.body_part) + ')' : '💀 Defeated by ' + escapeHtml(ev.killer_id)}</span>
            <small style="color:var(--player-muted, #94a3b8);">${ev.time ? Number(ev.time).toFixed(1) + 's' : ''}</small>
          </div>
        `).join('') : '<div style="font-size:12px; color:var(--player-muted, #94a3b8); text-align:center; padding: 8px;">No kill/death combat events recorded.</div>'}
      </div>
    `;
  } catch (err) {
    if (version !== matchDetailVersion || !modal.open) return;
    content.innerHTML = `<div role="alert" class="ui-error">Could not load match details: ${escapeHtml(err.message)}</div>`;
  }
}

const closeMatchDetailBtn = document.getElementById("closeMatchDetailBtn");
const matchDetailModal = document.getElementById("matchDetailModal");
if (closeMatchDetailBtn && matchDetailModal) {
  closeMatchDetailBtn.addEventListener("click", () => {
    if (typeof matchDetailModal.close === "function") matchDetailModal.close();
    else matchDetailModal.removeAttribute("open");
  });
  matchDetailModal.addEventListener("click", (e) => {
    if (e.target === matchDetailModal) {
      if (typeof matchDetailModal.close === "function") matchDetailModal.close();
      else matchDetailModal.removeAttribute("open");
    }
  });
}

document.addEventListener("click", (e) => {
  const drillBtn = e.target.closest(".match-drilldown-btn");
  if (drillBtn) {
    e.preventDefault();
    const sid = drillBtn.dataset.sessionId;
    if (sid) openMatchDetail(sid);
  }
});

// =========================================================================
// GDPR DATA EXPORT & SELF-SERVICE DELETION (Item 14)
// =========================================================================

const exportPlayerDataBtn = document.getElementById("downloadMyDataBtn");
if (exportPlayerDataBtn) {
  exportPlayerDataBtn.addEventListener("click", () => {
    window.location.href = `${window.API_BASE}/player/export-data`;
  });
}

const deleteAccountModal = document.getElementById("deleteAccountModal");
const closeDeleteModalBtn = document.getElementById("closeDeleteModalBtn");
const cancelDeleteAccountBtn = document.getElementById("cancelDeleteAccountBtn");
const confirmDeleteAccountBtn = document.getElementById("confirmDeleteAccountBtn");
const deleteAccountPassword = document.getElementById("deleteAccountPassword");
const deleteAccountError = document.getElementById("deleteAccountError");

const closeDeleteModal = () => {
  if (deleteAccountModal) {
    if (deleteAccountModal.open) deleteAccountModal.close();
  }
  if (deleteAccountPassword) deleteAccountPassword.value = "";
  if (deleteAccountError) {
    deleteAccountError.hidden = true;
    deleteAccountError.textContent = "";
  }
};

const selfDeleteAccountBtn = document.getElementById("selfDeleteAccountBtn");
if (selfDeleteAccountBtn) {
  selfDeleteAccountBtn.addEventListener("click", () => {
    if (deleteAccountModal) {
      if (!deleteAccountModal.open) deleteAccountModal.showModal();
      if (deleteAccountPassword) deleteAccountPassword.focus();
    }
  });
}

if (closeDeleteModalBtn) closeDeleteModalBtn.addEventListener("click", closeDeleteModal);
if (cancelDeleteAccountBtn) cancelDeleteAccountBtn.addEventListener("click", closeDeleteModal);
if (deleteAccountModal) {
  deleteAccountModal.addEventListener("close", closeDeleteModal);
  deleteAccountModal.addEventListener("click", (e) => {
    if (e.target === deleteAccountModal) closeDeleteModal();
  });
}

if (confirmDeleteAccountBtn) {
  confirmDeleteAccountBtn.addEventListener("click", async () => {
    const password = deleteAccountPassword ? deleteAccountPassword.value : "";
    if (!password) {
      if (deleteAccountError) {
        deleteAccountError.hidden = false;
        deleteAccountError.textContent = "Please enter your password to confirm deletion.";
      }
      return;
    }

    confirmDeleteAccountBtn.disabled = true;
    confirmDeleteAccountBtn.textContent = "Erasing account…";

    try {
      const res = await api("/player/account/delete", {
        method: "POST",
        body: JSON.stringify({ password })
      });
      closeDeleteModal();
      await window.showAppAlert(res.message || "Account successfully deleted.");
      setTimeout(() => {
        window.location.href = "login.html";
      }, 500);
    } catch (err) {
      if (deleteAccountError) {
        deleteAccountError.hidden = false;
        deleteAccountError.textContent = err.message || "Could not delete account.";
      }
      confirmDeleteAccountBtn.disabled = false;
      confirmDeleteAccountBtn.textContent = "Permanently Erase My Account";
    }
  });
}

// =========================================================================
// GAME HUB QUICK-LAUNCH (Item 14)
// =========================================================================

document.querySelectorAll(".quick-launch-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode || "freeroam";
    sessionStorage.setItem("securefps_match_before_game", latestPlayerMatchId);
    const sideNameEl = document.getElementById("sideName");
    if (sideNameEl && sideNameEl.textContent) {
      sessionStorage.setItem("securefps_player_name", sideNameEl.textContent.trim());
    }
    window.location.href = `public/games/three-fps/index.html?mode=${encodeURIComponent(mode)}`;
  });
});

// =========================================================================
// VISIBILITY-AWARE POLLING (Item 13)
// =========================================================================

function initPlayerPolling() {
  if (playerRefreshTimer) clearInterval(playerRefreshTimer);

  const startPolling = () => {
    if (!playerRefreshTimer) {
      playerRefreshTimer = setInterval(() => {
        if (!document.hidden) {
          loadPlayerDashboard();
        }
      }, 15000);
    }
  };

  const stopPolling = () => {
    if (playerRefreshTimer) {
      clearInterval(playerRefreshTimer);
      playerRefreshTimer = null;
    }
  };

  let lastDashboardLoadTimestamp = Date.now();

  const throttledLoad = () => {
    if (Date.now() - lastDashboardLoadTimestamp < 20000) return;
    lastDashboardLoadTimestamp = Date.now();
    loadPlayerDashboard();
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
    } else {
      throttledLoad();
      startPolling();
    }
  });

  window.addEventListener("focus", () => {
    if (!document.hidden) {
      throttledLoad();
    }
  });

  startPolling();
}

loadPlayerDashboard();
initPlayerPolling();

const collapseSidebar = document.getElementById("collapseSidebarBtn");
document.querySelectorAll("#playerNavigation a:not([aria-label])").forEach(link => {
  link.setAttribute("aria-label", link.querySelector(".nav-label").textContent.trim());
});
if (collapseSidebar) {
  const applySidebarState = (collapsed) => {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    collapseSidebar.setAttribute("aria-expanded", String(!collapsed));
    collapseSidebar.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    collapseSidebar.innerHTML = collapsed
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m13 5 7 7-7 7m8-7H4"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m11 5-7 7 7 7m-8-7h16"/></svg>';
  };
  const savedCollapsed = localStorage.getItem("securefps-sidebar-collapsed") === "true";
  applySidebarState(savedCollapsed);
  collapseSidebar.addEventListener("click", () => {
    const collapsed = !document.body.classList.contains("sidebar-collapsed");
    applySidebarState(collapsed);
    localStorage.setItem("securefps-sidebar-collapsed", String(collapsed));
  });
}
