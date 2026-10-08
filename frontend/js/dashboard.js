// ============================================================
// SecureFPS Dashboard
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

if (window.__SECUREFPS_DASHBOARD_LOADED__) {

    console.warn(
        "[SecureFPS] dashboard.js already loaded. Skipping duplicate execution."
    );

} 
else {

    window.__SECUREFPS_DASHBOARD_LOADED__ = true;


    // ============================================================
    // SecureFPS Dashboard
    // ============================================================

    const API_BASE =
        "http://127.0.0.1:5000/api";
}

// ============================================================
// UNITY GAME LOCATIONS
// ============================================================

const GAME_URLS = {

    "fps-microgame":
        "/public/games/FPS_Microgame/index.html",

    "multiplayer-fps":
        "/public/games/Multiplayer_FPS/index.html"

};


// ============================================================
// API HELPER
// ============================================================
//
// All requests to Flask go through this function.
//
// credentials: "include" is IMPORTANT because your Flask
// authentication uses a session cookie.
//

async function api(
    path,
    options = {}
) {

    const config = {
        credentials: "include",
        ...options
    };


    // Add JSON header only when needed
    if (
        !config.headers
    ) {

        config.headers = {};

    }


    if (
        !config.headers["Content-Type"] &&
        config.body
    ) {

        config.headers["Content-Type"] =
            "application/json";

    }


    const url =
        `${API_BASE}${path}`;


    console.log(
        "[SecureFPS] API request:",
        config.method || "GET",
        url
    );


    let response;


    try {

        response =
            await fetch(
                url,
                config
            );

    } catch (error) {

        console.error(
            "[SecureFPS] Network error:",
            error
        );

        throw new Error(
            "Cannot connect to Flask backend at " +
            API_BASE
        );

    }


    let data = {};


    try {

        data =
            await response.json();

    } catch (error) {

        data = {};

    }


    const safeData = { ...data };
    if (safeData.game_token) {
        safeData.game_token = "[REDACTED]";
    }

    console.log(
        "[SecureFPS] API response:",
        response.status,
        safeData
    );


    if (!response.ok) {

        throw new Error(
            data.message ||
            `Request failed with HTTP ${response.status}`
        );

    }


    return data;

}


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


        throw new Error(
            "Flask did not return game_token."
        );

    }


    const sessionId =
        response.session_id;


    const gameToken =
        response.game_token;


    // --------------------------------------------------------
    // LOG CREDENTIAL STATUS
    // --------------------------------------------------------

    console.log(
        "[SecureFPS] Game session created successfully."
    );


    console.log(
        "[SecureFPS] Session ID:",
        sessionId
    );


    console.log(
        "[SecureFPS] Game token received:",
        true
    );


    // --------------------------------------------------------
    // CREATE UNITY URL
    // --------------------------------------------------------

    const separator =
        baseGameUrl.includes("?")
            ? "&"
            : "?";


    const gameUrl =
        baseGameUrl +
        separator +
        "session_id=" +
        encodeURIComponent(
            sessionId
        ) +
        "&game_token=" +
        encodeURIComponent(
            gameToken
        );


    // --------------------------------------------------------
    // DO NOT PRINT THE COMPLETE TOKEN
    // --------------------------------------------------------

    console.log(
        "[SecureFPS] Final Unity URL created."
    );


    console.log(
        "[SecureFPS] Session parameter present:",
        gameUrl.includes(
            "session_id="
        )
    );


    console.log(
        "[SecureFPS] Token parameter present:",
        gameUrl.includes(
            "game_token="
        )
    );


    return gameUrl;

}


// ============================================================
// OPEN UNITY GAME
// ============================================================

async function openUnityGame(
    gameKey
) {

    console.log(
        "[SecureFPS] Opening Unity game:",
        gameKey
    );


    // --------------------------------------------------------
    // CHECK GAME
    // --------------------------------------------------------

    if (
        !GAME_URLS[gameKey]
    ) {

        console.error(
            "[SecureFPS] Unknown game:",
            gameKey
        );

        return;

    }


    // --------------------------------------------------------
    // GET ELEMENTS
    // --------------------------------------------------------

    const gameSection =
        document.getElementById(
            "gameSection"
        );


    const gameFrame =
        document.getElementById(
            "gameFrame"
        );


    const gameLoading =
        document.getElementById(
            "gameLoading"
        );


    const gameError =
        document.getElementById(
            "gameError"
        );


    if (!gameSection) {

        console.error(
            "[SecureFPS] gameSection not found."
        );

        return;

    }


    if (!gameFrame) {

        console.error(
            "[SecureFPS] gameFrame not found."
        );

        return;

    }


    // --------------------------------------------------------
    // RESET UI
    // --------------------------------------------------------

    if (gameError) {

        gameError.classList.remove(
            "active"
        );

    }


    if (gameLoading) {

        gameLoading.classList.add(
            "active"
        );


        const loadingText =
            gameLoading.querySelector(
                "p"
            );


        if (loadingText) {

            loadingText.textContent =
                "Creating secure game session...";

        }

    }


    // --------------------------------------------------------
    // SHOW GAME
    // --------------------------------------------------------

    gameSection.style.display =
        "block";


    gameSection.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });


    // --------------------------------------------------------
    // CLEAR OLD UNITY
    // --------------------------------------------------------

    gameFrame.onload =
        function () {

            console.log(
                "[SecureFPS] Unity WebGL page loaded."
            );


            if (gameLoading) {

                gameLoading.classList.remove(
                    "active"
                );

            }

        };


    gameFrame.onerror =
        function () {

            console.error(
                "[SecureFPS] Unity iframe failed to load."
            );


            if (gameLoading) {

                gameLoading.classList.remove(
                    "active"
                );

            }


            if (gameError) {

                gameError.textContent =
                    "Unable to load the Unity WebGL game.";

                gameError.classList.add(
                    "active"
                );

            }

        };


    gameFrame.src =
        "about:blank";


    // --------------------------------------------------------
    // CREATE SESSION AND GET SECURE URL
    // --------------------------------------------------------

    try {

        const gameUrl =
            await startUnityGameSession(
                gameKey
            );


        console.log(
            "[SecureFPS] Loading Unity WebGL..."
        );


        // ----------------------------------------------------
        // LOAD UNITY
        // ----------------------------------------------------

        gameFrame.src =
            gameUrl;


    } catch (error) {

        console.error(
            "[SecureFPS] Could not start Unity:",
            error
        );


        if (gameLoading) {

            gameLoading.classList.remove(
                "active"
            );

        }


        if (gameError) {

            gameError.textContent =
                error.message ||
                "Unable to start the Unity game.";

            gameError.classList.add(
                "active"
            );

        }

    }

}


// ============================================================
// CLOSE UNITY GAME
// ============================================================

const closeGameBtn =
    document.getElementById(
        "closeGameBtn"
    );


if (closeGameBtn) {

    closeGameBtn.addEventListener(
        "click",
        function () {

            console.log(
                "[SecureFPS] Closing Unity game."
            );


            const gameSection =
                document.getElementById(
                    "gameSection"
                );


            const gameFrame =
                document.getElementById(
                    "gameFrame"
                );


            const gameLoading =
                document.getElementById(
                    "gameLoading"
                );


            const gameError =
                document.getElementById(
                    "gameError"
                );


            // ------------------------------------------------
            // STOP UNITY
            // ------------------------------------------------

            if (gameFrame) {

                gameFrame.src =
                    "about:blank";

            }


            // ------------------------------------------------
            // HIDE GAME
            // ------------------------------------------------

            if (gameSection) {

                gameSection.style.display =
                    "none";

            }


            // ------------------------------------------------
            // RESET LOADING
            // ------------------------------------------------

            if (gameLoading) {

                gameLoading.classList.remove(
                    "active"
                );

            }


            // ------------------------------------------------
            // RESET ERROR
            // ------------------------------------------------

            if (gameError) {

                gameError.classList.remove(
                    "active"
                );

            }


            window.scrollTo({

                top: 0,

                behavior: "smooth"

            });

        }
    );

}


// ============================================================
// PLAY GAME BUTTONS
// ============================================================
//
// Your existing HTML should have:
//
// <button
//     class="play-btn"
//     data-game="fps-microgame">
//     Play Game
// </button>
//
// This event handler supports that structure.
//

// ============================================================
// PLAY GAME BUTTONS
// ============================================================

document.addEventListener("DOMContentLoaded", function () {

    console.log("[SecureFPS] DOM loaded.");

    const playButtons =
        document.querySelectorAll(".play-btn[data-game]");

    console.log(
        "[SecureFPS] Play buttons found:",
        playButtons.length
    );

    playButtons.forEach(function (button) {

        button.addEventListener("click", async function (event) {

            event.preventDefault();

            console.log("==========================================");
            console.log("[SecureFPS] PLAY GAME CLICKED");
            console.log(
                "[SecureFPS] Game:",
                button.getAttribute("data-game")
            );
            console.log("==========================================");

            const gameKey =
                button.getAttribute("data-game");

            if (!gameKey) {
                console.error(
                    "[SecureFPS] No data-game attribute."
                );
                return;
            }

            if (button.dataset.loading === "true") {
                console.log(
                    "[SecureFPS] Game start already running."
                );
                return;
            }

            button.dataset.loading = "true";

            const originalText =
                button.innerHTML;

            button.innerHTML =
                "Starting Game...";

            try {

                await openUnityGame(gameKey);

            } catch (error) {

                console.error(
                    "[SecureFPS] Game start error:",
                    error
                );

            } finally {

                button.dataset.loading = "false";

                button.innerHTML =
                    originalText;

            }

        });

    });

});


// ============================================================
// MANUAL ML DETECTION
// ============================================================

const detectForm =
    document.getElementById(
        "detectForm"
    );


if (detectForm) {

    detectForm.addEventListener(
        "submit",
        async function (event) {

            event.preventDefault();


            const form =
                new FormData(
                    event.target
                );


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

                            headers: {
                                "Content-Type":
                                    "application/json"
                            },

                            body:
                                JSON.stringify({
                                    features:
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

                        <br><br>

                        Random Forest:

                        <b>
                            ${escapeHtml(
                                rf
                            )}
                        </b>

                        <br>

                        Isolation Forest:

                        <b>
                            ${escapeHtml(
                                isolation
                            )}
                        </b>

                        <br>

                        Risk score:

                        <b>
                            ${scoreText}
                        </b>

                        `;
                    }

                }


                await loadDashboard();


            } catch (error) {

                console.error(
                    "[SecureFPS] Detection error:",
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
// HTML ESCAPE
// ============================================================

function escapeHtml(
    value
) {

    return String(
        value
    )

        .replaceAll(
            "&",
            "&amp;"
        )

        .replaceAll(
            "<",
            "&lt;"
        )

        .replaceAll(
            ">",
            "&gt;"
        )

        .replaceAll(
            '"',
            "&quot;"
        )

        .replaceAll(
            "'",
            "&#039;"
        );

}


// ============================================================
// START DASHBOARD
// ============================================================

console.log(
    "[SecureFPS] dashboard.js loaded."
);


loadDashboard();
