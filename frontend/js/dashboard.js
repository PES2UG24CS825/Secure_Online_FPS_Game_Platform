// ============================================================
// SecureFPS Dashboard
// ============================================================

// Unity game locations
const GAME_URLS = {
    "fps-microgame": "/public/games/FPS_Microgame/index.html",
    "multiplayer-fps": "/public/games/Multiplayer_FPS/index.html"
};


// ============================================================
// LOAD DASHBOARD
// ============================================================

async function loadDashboard() {

    try {

        const me = await api("/auth/me");
        const user = me.user;

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
            avatar.textContent =
                user.name.charAt(0).toUpperCase();
        }


        // Dashboard data
        const data = await api("/dashboard");


        // Statistics
        const matches = document.getElementById("matches");
        const alerts = document.getElementById("alerts");

        if (matches) {
            matches.textContent =
                data.stats?.matches_analyzed ?? 0;
        }

        if (alerts) {
            alerts.textContent =
                data.stats?.alerts ?? 0;
        }


        // Recent detections
        const detections =
            document.getElementById("detectionsList");

        if (detections) {

            if (
                data.recent_detections &&
                data.recent_detections.length > 0
            ) {

                detections.innerHTML =
                    data.recent_detections.map(d => {

                        const bad =
                            d.rf === "cheater" ||
                            d.if === "anomaly";

                        const score =
                            d.risk_score == null
                                ? "—"
                                : `${Math.round(
                                    d.risk_score * 100
                                )}%`;

                        return `
                            <div class="list-row">

                                <div>
                                    <strong>RF:</strong>
                                    ${d.rf ?? "not loaded"}

                                    &nbsp;&nbsp;

                                    <strong>IF:</strong>
                                    ${d.if ?? "not loaded"}
                                </div>

                                <span class="badge ${
                                    bad ? "bad" : "good"
                                }">
                                    ${bad ? "Review" : "Normal"}
                                    · ${score}
                                </span>

                            </div>
                        `;

                    }).join("");

            } else {

                detections.innerHTML =
                    '<div class="empty">No gameplay detections yet.</div>';
            }
        }


        // Security alerts
        const alertsList =
            document.getElementById("alertsList");

        if (alertsList) {

            if (
                data.alerts &&
                data.alerts.length > 0
            ) {

                alertsList.innerHTML =
                    data.alerts.map(a => {

                        const type =
                            String(
                                a.type ?? "security_alert"
                            ).replaceAll("_", " ");

                        const severity =
                            a.severity ?? "low";

                        return `
                            <div class="list-row">

                                <div>
                                    ${type}
                                </div>

                                <span class="badge ${
                                    severity === "high"
                                        ? "bad"
                                        : "warn"
                                }">
                                    ${severity}
                                </span>

                            </div>
                        `;

                    }).join("");

            } else {

                alertsList.innerHTML =
                    '<div class="empty">No security alerts.</div>';
            }
        }

    } catch (error) {

        console.error(
            "Dashboard loading error:",
            error
        );

        window.location.href = "login.html";
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


                    const score =
                        result.risk_score == null
                            ? "—"
                            : `${Math.round(
                                result.risk_score * 100
                            )}%`;


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