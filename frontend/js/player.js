async function loadPlayerDashboard() {
  try {
    const me = await api("/auth/me");
    if (!me || !me.user || me.user.role !== "player") {
      window.location.replace("login.html");
      return;
    }

    const user = me.user;
    const welcome = document.getElementById("welcome");
    const sideName = document.getElementById("sideName");
    const sideEmail = document.getElementById("sideEmail");
    const avatar = document.getElementById("avatar");

    if (welcome) welcome.textContent = `Welcome back, ${user.name}`;
    if (sideName) sideName.textContent = user.name;
    if (sideEmail) sideEmail.textContent = user.email;
    if (avatar) avatar.textContent = user.name.charAt(0).toUpperCase();

    const [dashboardData, matchesData, detectionsData, securityData] = await Promise.all([
      api("/dashboard").catch(() => ({ stats: { matches_analyzed: 0, security_alerts: 0, recent_detections: 0, recent_security_activity: 0 }, recent_detections: [], alerts: [], matches: [] })),
      api("/player/matches").catch(() => ({ matches: [] })),
      api("/player/detections").catch(() => ({ detections: [] })),
      api("/player/security").catch(() => ({ mfa_status: "disabled", active_sessions: [], login_history: [], last_login: null, password_status: "Protected", account_status: "active" }))
    ]);

    const matchesCount = document.getElementById("matchesCount");
    const alertsCount = document.getElementById("alertsCount");
    const mfaStatus = document.getElementById("mfaStatus");
    const accountStatus = document.getElementById("accountStatus");
    const riskScore = document.getElementById("riskScore");

    if (matchesCount) matchesCount.textContent = dashboardData?.stats?.matches_analyzed ?? matchesData.matches?.length ?? 0;
    if (alertsCount) alertsCount.textContent = dashboardData?.stats?.security_alerts ?? 0;
    if (mfaStatus) mfaStatus.textContent = securityData?.mfa_status === "enabled" ? "Enabled" : "Disabled";
    if (accountStatus) {
      accountStatus.textContent = securityData?.account_status === "active" ? "Protected" : securityData?.account_status || "Protected";
      accountStatus.classList.toggle("success-text", (securityData?.account_status || "active") === "active");
    }
    if (riskScore) riskScore.textContent = `${dashboardData?.stats?.risk_score ?? 0}%`;

    const detectionsList = document.getElementById("detectionsList");
    const sourceDetections = detectionsData.detections ?? dashboardData.recent_detections ?? [];
    if (detectionsList) {
      if (sourceDetections.length > 0) {
        detectionsList.innerHTML = sourceDetections.map((d) => {
          const severity = d.severity || "low";
          const score = Number(d.risk_score ?? d.confidence_score ?? d.confidence ?? 0);
          return `
            <div class="list-row">
              <div>
                <strong>${d.detection_type || "Gameplay anomaly"}</strong>
                <div class="muted">${d.description || "Detection recorded."}</div>
              </div>
              <span class="badge ${severity === "high" || severity === "critical" ? "bad" : severity === "medium" ? "warn" : "good"}">${severity} · ${Math.round(score * (score <= 1 ? 100 : 1))}% risk</span>
            </div>
          `;
        }).join("");
      } else {
        detectionsList.innerHTML = '<div class="empty">No suspicious gameplay detected.</div>';
      }
    }

    const matchesList = document.getElementById("matchesList");
    if (matchesList) {
      if ((matchesData.matches || []).length > 0) {
        matchesList.innerHTML = matchesData.matches.map((match) => `
            <div class="list-row"><div><strong>Match ${match.match_id || "unknown"}</strong><div class="muted">${match.date ? new Date(match.date).toLocaleString() : "Recent match"} · ${match.duration ?? 0}s</div><div class="muted">Kills ${match.kills ?? 0} · Deaths ${match.deaths ?? 0} · K/D ${match.kd ?? 0} · Accuracy ${match.accuracy ?? 0}% · Headshots ${match.headshots ?? 0}</div></div><span class="badge ${match.status === "completed" ? "good" : "warn"}">${match.status || "completed"} · risk ${match.risk_score ?? 0}</span></div>
        `).join("");
      } else {
        matchesList.innerHTML = '<div class="empty">No matches analyzed yet.</div>';
      }
    }

    const securityStatus = document.getElementById("securityStatus");
    if (securityStatus) {
      const history = securityData.login_history || [];
      const activeSessions = securityData.active_sessions || [];
      securityStatus.innerHTML = `
        <div class="list-row"><div><strong>MFA / 2FA</strong><div class="muted">${securityData.mfa_status === "enabled" ? "Enabled" : "Disabled"}</div></div><span class="badge ${securityData.mfa_status === "enabled" ? "good" : "warn"}">${securityData.mfa_status === "enabled" ? "Active" : "Off"}</span></div>
        <div class="list-row"><div><strong>Active sessions</strong><div class="muted">${activeSessions.length} active session(s)</div></div><span class="badge good">${activeSessions.length}</span></div>
        <div class="list-row"><div><strong>Last login</strong><div class="muted">${securityData.last_login ? new Date(securityData.last_login).toLocaleString() : "No login recorded"}</div></div><span class="badge good">Recorded</span></div>
        <div class="list-row"><div><strong>Password status</strong><div class="muted">${securityData.password_status || "Protected"}</div></div><span class="badge good">Protected</span></div>
        <div class="list-row"><div><strong>Account status</strong><div class="muted">${securityData.account_status || "active"}</div></div><span class="badge good">${(securityData.account_status || "active").toUpperCase()}</span></div>
        <div class="list-row"><div><strong>Login activity</strong><div class="muted">${history.length} login events</div></div><button id="logoutOthersBtn" class="ghost-btn" type="button">Logout other sessions</button></div>
        <div id="loginHistoryRows">${history.length ? history.map((entry) => `<div class="list-row"><div><strong>${entry.authentication_method || "MFA"}</strong><div class="muted">${entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "Unknown time"} · ${entry.ip_address || "Unknown IP"}</div></div><span class="badge ${entry.success === false ? "bad" : "good"}">${entry.success === false ? "Failed" : "Success"}</span></div>`).join("") : '<div class="empty">No login history found.</div>'}</div>
      `;

      const logoutOthersBtn = document.getElementById("logoutOthersBtn");
      if (logoutOthersBtn) {
        logoutOthersBtn.addEventListener("click", async () => {
          try {
            await api("/auth/logout-other-sessions", { method: "POST" });
            alert("Other sessions have been revoked.");
            await loadPlayerDashboard();
          } catch (error) {
            alert(error.message || "Unable to revoke sessions.");
          }
        });
      }
    }

    const profileContent = document.getElementById("profileContent");
    if (profileContent) {
      profileContent.innerHTML = `
        <div class="list-row"><div><strong>Username</strong><div class="muted">${user.name}</div></div></div>
        <div class="list-row"><div><strong>Email</strong><div class="muted">${user.email}</div></div></div>
        <div class="list-row"><div><strong>Role</strong><div class="muted">${user.role}</div></div></div>
        <div class="list-row"><div><strong>Created</strong><div class="muted">${user.created_at ? new Date(user.created_at).toLocaleString() : "Unknown"}</div></div></div>
      `;
    }

    const fpsMicrogameBtn = document.getElementById("fpsMicrogameBtn");
    if (fpsMicrogameBtn) {
      fpsMicrogameBtn.addEventListener("click", () => {
        window.location.href = "game.html";
      });
    }

  } catch (error) {
    console.error("Player dashboard failed", error);
    window.location.replace("login.html");
  }
}

const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    try { await api("/auth/logout", { method: "POST" }); } catch (error) { console.error(error); }
    window.location.href = "login.html";
  });
}

loadPlayerDashboard();
