// ============================================================
// SecureFPS Dashboard
// ============================================================

// Unity game locations
const GAME_URLS = {
    "fps-microgame": "public/games/FPS_Microgame/index.html",
    "multiplayer-fps": "public/games/Multiplayer_FPS/index.html"
};


// ============================================================
// LOAD DASHBOARD
// ============================================================

async function loadDashboard() {

    console.log(
        "[SecureFPS] Loading dashboard..."
    );


    try {

        // ----------------------------------------------------
        // GET CURRENT USER
        // ----------------------------------------------------

        const me =
            await api(
                "/auth/me"
            );


        const user =
            me.user;


        if (!user) {

            console.warn(
                "[SecureFPS] No authenticated user."
            );

            window.location.href =
                "login.html";

            return;

        }


        console.log(
            "[SecureFPS] Logged-in user:",
            user.email
        );


        // ----------------------------------------------------
        // ADMIN REDIRECT
        // ----------------------------------------------------

        if (
            user.role === "admin"
        ) {

            window.location.replace(
                "admin.html"
            );

            return;

        }


        // ----------------------------------------------------
        // USER INFORMATION
        // ----------------------------------------------------

        const welcome =
            document.getElementById(
                "welcome"
            );


        const sideName =
            document.getElementById(
                "sideName"
            );


        const sideEmail =
            document.getElementById(
                "sideEmail"
            );


        const avatar =
            document.getElementById(
                "avatar"
            );


        if (welcome) {

            welcome.textContent =
                `Welcome back, ${user.name}`;

        }


        if (sideName) {

            sideName.textContent =
                user.name;

        }


        if (sideEmail) {

            sideEmail.textContent =
                user.email;

        }


        if (avatar) {

            avatar.textContent =
                user.name
                    .charAt(0)
                    .toUpperCase();

        }


        // ----------------------------------------------------
        // GET DASHBOARD DATA
        // ----------------------------------------------------

        const data =
            await api(
                "/dashboard"
            );


        console.log(
            "[SecureFPS] Dashboard data:",
            data
        );


        // ----------------------------------------------------
        // STATISTICS
        // ----------------------------------------------------

        const matches =
            document.getElementById(
                "matches"
            );


        const alerts =
            document.getElementById(
                "alerts"
            );


        if (matches) {

            matches.textContent =
                data.stats?.matches_analyzed ?? 0;

        }


        if (alerts) {

            alerts.textContent =
                data.stats?.alerts ?? 0;

        }


        // ----------------------------------------------------
        // RECENT DETECTIONS
        // ----------------------------------------------------

        const detections =
            document.getElementById(
                "detectionsList"
            );


        if (detections) {

            if (
                data.recent_detections &&
                data.recent_detections.length > 0
            ) {

                detections.innerHTML =
                    data.recent_detections
                        .map(
                            function (detection) {

                                const incomplete =
                                    detection.status !== "success";

                                const bad =
                                    !incomplete && (
                                    detection.rf ===
                                        "cheater" ||

                                    detection.if ===
                                        "anomaly"
                                    );

                                const rf = incomplete
                                    ? "unavailable"
                                    : detection.rf ?? "not loaded";

                                const isolation = incomplete
                                    ? "unavailable"
                                    : detection.if ?? "not loaded";


                                const score =
                                    incomplete || detection.risk_score == null

                                        ? "—"

                                        : `${Math.round(
                                            Number(
                                                detection.risk_score
                                            )
                                        )}%`;


                                return `

                                    <div class="list-row">

                                        <div>

                                            <strong>
                                                RF:
                                            </strong>

                                            ${escapeHtml(
                                                rf
                                            )}

                                            &nbsp;&nbsp;

                                            <strong>
                                                IF:
                                            </strong>

                                            ${escapeHtml(
                                                isolation
                                            )}

                                        </div>


                                        <span class="badge ${
                                            incomplete
                                                ? "gray"
                                                : bad
                                                    ? "bad"
                                                    : "good"
                                        }">

                                            ${
                                                incomplete
                                                    ? "Analysis incomplete"
                                                    : bad
                                                        ? "Review"
                                                        : "Normal"
                                            }

                                            · ${score}

                                        </span>

                                    </div>

                                `;

                            }
                        )
                        .join("");

            } else {

                detections.innerHTML = `
                    <div class="empty">
                        No gameplay detections yet.
                    </div>
                `;

            }

        }


        // ----------------------------------------------------
        // SECURITY ALERTS
        // ----------------------------------------------------

        const alertsList =
            document.getElementById(
                "alertsList"
            );


        if (alertsList) {

            if (
                data.alerts &&
                data.alerts.length > 0
            ) {

                alertsList.innerHTML =
                    data.alerts
                        .map(
                            function (alert) {

                                const type =
                                    String(
                                        alert.type ??
                                        "security_alert"
                                    )
                                    .replaceAll(
                                        "_",
                                        " "
                                    );


                                const severity =
                                    alert.severity ??
                                    "low";


                                return `

                                    <div class="list-row">

                                        <div>

                                            ${escapeHtml(
                                                type
                                            )}

                                        </div>


                                        <span class="badge ${
                                            severity === "high"
                                                ? "bad"
                                                : "warn"
                                        }">

                                            ${escapeHtml(
                                                severity
                                            )}

                                        </span>

                                    </div>

                                `;

                            }
                        )
                        .join("");

            } else {

                alertsList.innerHTML = `
                    <div class="empty">
                        No security alerts.
                    </div>
                `;

            }

        }


    } catch (error) {

        console.error(
            "[SecureFPS] Dashboard loading error:",
            error
        );


        // Only redirect for authentication problems.
        // Do not redirect if MongoDB/API temporarily fails.

        if (
            error.message &&
            (
                error.message.includes("401") ||
                error.message.includes(
                    "Authentication required"
                )
            )
        ) {

            window.location.href =
                "login.html";

        }

    }

}


// ============================================================
// LOGOUT
// ============================================================

const logoutBtn =
    document.getElementById(
        "logoutBtn"
    );


if (logoutBtn) {

    logoutBtn.addEventListener(
        "click",
        async function () {

            try {

                await api(
                    "/auth/logout",
                    {
                        method: "POST"
                    }
                );

            } catch (error) {

                console.error(
                    "[SecureFPS] Logout error:",
                    error
                );

            }


            window.location.href =
                "login.html";

        }
    );

}


// ============================================================
// CREATE SECURE UNITY GAME SESSION
// ============================================================
//
// IMPORTANT:
//
// The browser does NOT create the game token.
//
// Flask creates:
//
//     session_id
//     game_token
//
// through:
//
//     POST /api/game/start
//
// Then this function receives them and creates:
//
//     Unity/index.html
//       ?session_id=XXXX
//       &game_token=YYYY
//
// ============================================================

async function startUnityGameSession(
    gameKey
) {

    console.log(
        "=========================================="
    );

    console.log(
        "[SecureFPS] STARTING UNITY GAME SESSION"
    );

    console.log(
        "Game:",
        gameKey
    );

    console.log(
        "=========================================="
    );


    // --------------------------------------------------------
    // CHECK GAME URL
    // --------------------------------------------------------

    const baseGameUrl =
        GAME_URLS[gameKey];


    if (!baseGameUrl) {

        throw new Error(
            `Game URL not found: ${gameKey}`
        );

    }


    console.log(
        "[SecureFPS] Base Unity URL:",
        baseGameUrl
    );


    // --------------------------------------------------------
    // CALL FLASK
    // --------------------------------------------------------

    console.log(
        "[SecureFPS] Calling POST /api/game/start..."
    );


    let response;


    try {

        response =
            await api(
                "/game/start",
                {
                    method: "POST"
                }
            );

    } catch (error) {

        console.error(
            "[SecureFPS] /api/game/start failed:",
            error
        );


        throw new Error(
            "Could not create game session. " +
            "Make sure Flask is running and you are logged in."
        );

    }


    // --------------------------------------------------------
    // Log session metadata without exposing the game token.
    // --------------------------------------------------------

    console.log(
        "[SecureFPS] /game/start response:",
        {
            success: Boolean(response && response.success),
            session_id: response && response.session_id,
            game_token_received: Boolean(response && response.game_token),
            game: response && response.game
        }
    );


    // --------------------------------------------------------
    // VALIDATE SESSION ID
    // --------------------------------------------------------

    if (
        !response ||
        !response.session_id
    ) {

        console.error(
            "[SecureFPS] session_id missing from /game/start response."
        );


        throw new Error(
            "Flask did not return session_id."
        );

    }


    // --------------------------------------------------------
    // VALIDATE GAME TOKEN
    // --------------------------------------------------------

    if (
        !response.game_token
    ) {

        console.error(
            "[SecureFPS] game_token missing from /game/start response."
        );


        const me = await api("/auth/me");
        const user = me.user;

        if (user.role === "admin") {
            window.location.replace("admin.html");
            return;
        }

        const playerAnalysis = document.getElementById("playerAnalysis");
        if (playerAnalysis) playerAnalysis.remove();

        const welcome = document.getElementById("welcome");
        const sideName = document.getElementById("sideName");
        const sideEmail = document.getElementById("sideEmail");
        const avatar = document.getElementById("avatar");

        if (welcome) {
            welcome.textContent = `Welcome back, ${user.name}`;
        }

        if (sideName) {
            sideName.textContent = user.name;
        }

        if (sideEmail) {
            sideEmail.textContent = user.email;
        }

        if (avatar) {
            avatar.textContent = user.name.charAt(0).toUpperCase();
        }

        const [dashboardData, matchesData, detectionsData, historyData, securityStatus] = await Promise.all([
            api("/dashboard").catch((error) => {
                console.error("Dashboard summary failed:", error);
                return { stats: {}, recent_detections: [], alerts: [] };
            }),
            api("/player/matches").catch((error) => {
                console.error("Matches failed:", error);
                return { matches: [] };
            }),
            api("/player/detections").catch((error) => {
                console.error("Detections failed:", error);
                return { detections: [] };
            }),
            api("/player/login-history").catch((error) => {
                console.error("Login history failed:", error);
                return { login_history: [] };
            }),
            api("/player/security-status").catch((error) => {
                console.error("Security status failed:", error);
                return { status: "active", mfa_enabled: true, last_login: null };
            })
        ]);

        const matches = document.getElementById("matches");
        const alerts = document.getElementById("alerts");

        if (matches) {
            matches.textContent = dashboardData.stats?.matches_analyzed ?? matchesData.matches?.length ?? 0;
        }

        if (alerts) {
            alerts.textContent = dashboardData.stats?.alerts ?? 0;
        }

        const detectionsElement = document.getElementById("detectionsList");
        if (detectionsElement) {
            const recentDetections = detectionsData.detections ?? dashboardData.recent_detections ?? [];
            if (recentDetections.length > 0) {
                detectionsElement.innerHTML = recentDetections.map(d => {
                    const risk = d.risk_score ?? d.confidence ?? 0;
                    const score = `${Math.round(Number(risk) * 100 || Number(risk) || 0)}%`;
                    const title = d.detection_type || d.rf || "Suspicious behaviour";
                    return `
                        <div class="list-row">
                            <div>
                                <strong>${title}</strong>
                                <div class="muted">${d.description || "Anomaly detected."}</div>
                            </div>
                            <span class="badge ${Number(risk) >= 0.6 ? "bad" : "warn"}">${score}</span>
                        </div>
                    `;
                }).join("");
            } else {
                detectionsElement.innerHTML = '<div class="empty">No gameplay detections yet.</div>';
            }
        }

        const alertsList = document.getElementById("alertsList");
        if (alertsList) {
            const alertItems = dashboardData.alerts ?? [];
            if (alertItems.length > 0) {
                alertsList.innerHTML = alertItems.map(a => {
                    const severity = a.severity ?? "low";
                    return `
                        <div class="list-row">
                            <div>${a.type || "security_alert"}</div>
                            <span class="badge ${severity === "high" ? "bad" : "warn"}">${severity}</span>
                        </div>
                    `;
                }).join("");
            } else {
                alertsList.innerHTML = '<div class="empty">No security alerts.</div>';
            }
        }

        const matchesList = document.getElementById("matchesList");
        if (matchesList) {
            if (matchesData.matches && matchesData.matches.length > 0) {
                matchesList.innerHTML = matchesData.matches.map(match => `
                    <div class="list-row">
                        <div>
                            <strong>Match ${match.match_id || "unknown"}</strong>
                            <div class="muted">${match.date ? new Date(match.date).toLocaleString() : "Recent match"}</div>
                        </div>
                        <div class="muted">K/D ${match.kd ?? 0} · Acc ${match.accuracy ?? 0}%</div>
                    </div>
                `).join("");
            } else {
                matchesList.innerHTML = '<div class="empty">No matches found.</div>';
            }
        }

        const loginHistoryList = document.getElementById("loginHistoryList");
        if (loginHistoryList) {
            const history = historyData.login_history ?? [];
            if (history.length > 0) {
                loginHistoryList.innerHTML = history.map(entry => `
                    <div class="list-row">
                        <div>
                            <strong>${entry.authentication_method || "MFA"}</strong>
                            <div class="muted">${entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "Recent login"}</div>
                        </div>
                        <span class="badge ${entry.success === false ? "bad" : "good"}">${entry.success === false ? "Failed" : "Success"}</span>
                    </div>
                `).join("");
            } else {
                loginHistoryList.innerHTML = '<div class="empty">No login history found.</div>';
            }
        }

        const statusElement = document.querySelector(".status-pill");
        if (statusElement && securityStatus) {
            statusElement.innerHTML = `<span class="status-dot"></span>${securityStatus.status === "active" ? "Platform protected" : "Review required"}`;
        }

    } catch (error) {
        console.error("Dashboard loading error:", error);
        const message = document.getElementById("message") || document.body;
        if (message && message.id === "message") {
            message.textContent = "Unable to load dashboard. Please try again.";
        } else {
            window.location.href = "login.html";
        }
    }
}


// ============================================================
// LOGOUT
// ============================================================

const logoutBtn =
    document.getElementById("logoutBtn");

if (logoutBtn) {

    logoutBtn.addEventListener("click", async () => {

        try {

            await api("/auth/logout", {
                method: "POST"
            });

        } catch (error) {

            console.error(
                "Logout error:",
                error
            );
        }

        window.location.href = "login.html";

    });
}


// ============================================================
// UNITY GAME
// ============================================================

function openUnityGame(gameKey) {

    console.log("Opening Unity game:", gameKey);

    const gameUrl = GAME_URLS[gameKey];

    if (!gameUrl) {

        console.error(
            "Game URL not found:",
            gameKey
        );

        return;
    }


    // Remove existing game window
    const existing =
        document.getElementById("unityGameModal");

    if (existing) {
        existing.remove();
    }


    // Create modal
    const modal =
        document.createElement("div");

    modal.id = "unityGameModal";

    modal.innerHTML = `

        <div class="unity-overlay">

            <div class="unity-container">

                <div class="unity-header">

                    <div>
                        <strong>FPS Microgame</strong>
                        <small>Unity WebGL</small>
                    </div>

                    <div class="unity-buttons">

                        <button
                            id="unityFullscreen"
                            type="button">
                            ⛶ Fullscreen
                        </button>

                        <button
                            id="unityClose"
                            type="button">
                            ✕ Close
                        </button>

                    </div>

                </div>


                <div class="unity-content">

                    <div
                        id="unityLoading"
                        class="unity-loading">

                        <div class="spinner"></div>

                        <p>Loading FPS Microgame...</p>

                    </div>


                    <iframe
                        id="unityFrame"
                        src="${gameUrl}"
                        title="FPS Microgame"
                        allow="fullscreen; autoplay"
                        allowfullscreen>
                    </iframe>

                </div>

            </div>

        </div>
    `;


    document.body.appendChild(modal);

    document.body.style.overflow = "hidden";


    // Add styles
    addUnityStyles();


    // iframe
    const iframe =
        document.getElementById("unityFrame");


    // Loading
    const loading =
        document.getElementById("unityLoading");


    iframe.addEventListener("load", () => {

        if (loading) {
            loading.style.display = "none";
        }

    });


    // Close
    const close =
        document.getElementById("unityClose");

    close.addEventListener("click", () => {

        modal.remove();

        document.body.style.overflow = "";

    });


    // Fullscreen
    const fullscreen =
        document.getElementById(
            "unityFullscreen"
        );

    fullscreen.addEventListener(
        "click",
        async () => {

            try {

                await iframe.requestFullscreen();

            } catch (error) {

                console.error(
                    "Fullscreen error:",
                    error
                );

            }

        }
    );
}


// ============================================================
// UNITY GAME STYLES
// ============================================================

function addUnityStyles() {

    if (
        document.getElementById(
            "unityGameStyles"
        )
    ) {
        return;
    }


    const style =
        document.createElement("style");

    style.id = "unityGameStyles";


    style.textContent = `

        #unityGameModal {
            position: fixed;
            inset: 0;
            z-index: 999999;
        }

        .unity-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.92);

            display: flex;
            align-items: center;
            justify-content: center;

            padding: 20px;
        }

        .unity-container {
            width: 95vw;
            height: 92vh;

            background: #080d16;

            border-radius: 12px;
            overflow: hidden;

            display: flex;
            flex-direction: column;

            box-shadow:
                0 20px 80px rgba(0,0,0,0.7);
        }

        .unity-header {
            height: 55px;
            min-height: 55px;

            background: #0c1624;

            color: white;

            display: flex;
            align-items: center;
            justify-content: space-between;

            padding: 0 15px;

            box-sizing: border-box;
        }

        .unity-header strong {
            display: block;
            font-size: 15px;
        }

        .unity-header small {
            display: block;
            margin-top: 3px;
            opacity: 0.6;
        }

        .unity-buttons {
            display: flex;
            gap: 8px;
        }

        .unity-buttons button {
            border: 1px solid
                rgba(255,255,255,0.15);

            background: #16253a;
            color: white;

            padding: 8px 12px;

            border-radius: 6px;

            cursor: pointer;
        }

        .unity-buttons button:hover {
            background: #243c5b;
        }

        .unity-content {
            position: relative;

            flex: 1;

            background: black;
        }

        #unityFrame {
            position: absolute;

            left: 0;
            top: 0;

            width: 100%;
            height: 100%;

            border: none;

            background: black;
        }

        .unity-loading {
            position: absolute;

            inset: 0;

            z-index: 5;

            display: flex;

            flex-direction: column;

            align-items: center;

            justify-content: center;

            background: black;

            color: white;
        }

        .spinner {
            width: 35px;
            height: 35px;

            border: 3px solid
                rgba(255,255,255,0.25);

            border-top-color: white;

            border-radius: 50%;

            animation:
                spin 0.8s linear infinite;
        }

        .unity-loading p {
            margin-top: 15px;
            opacity: 0.7;
        }

        @keyframes spin {

            from {
                transform: rotate(0deg);
            }

            to {
                transform: rotate(360deg);
            }

        }

        @media(max-width:700px) {

            .unity-overlay {
                padding: 0;
            }

            .unity-container {
                width: 100vw;
                height: 100vh;

                border-radius: 0;
            }

        }

    `;

    document.head.appendChild(style);
}


// ============================================================
// PLAY BUTTONS
// ============================================================

document.addEventListener("click", function(event) {

    const button =
        event.target.closest(
            ".play-btn[data-game]"
        );

    if (!button) {
        return;
    }


    event.preventDefault();
    event.stopPropagation();


    const game =
        button.getAttribute("data-game");


    console.log(
        "PLAY GAME BUTTON CLICKED:",
        game
    );


    openUnityGame(game);

});


// ============================================================
// ML DETECTION
// ============================================================

const detectForm =
    document.getElementById("detectForm");


if (detectForm) {

    detectForm.addEventListener(
        "submit",
        async (event) => {

            event.preventDefault();


            const form =
                new FormData(event.target);


            const features =
                Object.fromEntries(
                    form.entries()
                );


            const resultBox =
                document.getElementById(
                    "detectResult"
                );


            try {

                const result =
                    await api(
                        "/detect",
                        {
                            method: "POST",

                            body: JSON.stringify({
                                features
                            })
                        }
                    );


                if (resultBox) {

                    resultBox.classList.remove(
                        "hidden"
                    );

                    if (result.status !== "success") {
                        resultBox.textContent =
                            "Analysis incomplete — model results unavailable.";
                    } else {

                        const score =
                            result.result?.risk_score ??
                            result.risk_score;


                        const scoreText =
                            score == null
                                ? "—"
                                : `${Math.round(
                                    Number(score)
                                )}%`;


                        const rf =
                            result.result?.random_forest ??
                            result.random_forest ??
                            "model not loaded";


                        const isolation =
                            result.result?.isolation_forest ??
                            result.isolation_forest ??
                            "model not loaded";


                        resultBox.innerHTML = `

                        <strong>
                            Detection result
                        </strong>

                        <br>

                        Random Forest:
                        <b>
                            ${
                                result.random_forest ??
                                "model not loaded"
                            }
                        </b>

                        <br>

                        Isolation Forest:
                        <b>
                            ${
                                result.isolation_forest ??
                                "model not loaded"
                            }
                        </b>

                        <br>

                        Risk score:
                        <b>
                            ${score}
                        </b>

                        `;
                    }

                }


                await loadDashboard();

            } catch (error) {

                console.error(
                    "Detection error:",
                    error
                );


                if (resultBox) {

                    resultBox.classList.remove(
                        "hidden"
                    );

                    resultBox.textContent =
                        error.message ||
                        "Security analysis failed.";
                }

            }

        }
    );
}


// ============================================================
// START
// ============================================================

loadDashboard();