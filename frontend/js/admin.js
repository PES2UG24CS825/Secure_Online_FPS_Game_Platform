// ============================================================
// SecureFPS Admin Control Center
// ============================================================

const ADMIN_SECTIONS = ["overview", "players", "security-events", "game-monitoring"];

let currentAdmin = null;
let toastTimer = null;


// ============================================================
// HELPERS
// ============================================================

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[character]));
}

function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "—";
    }

    return date.toLocaleString();
}

function formatDateOnly(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "—";
    }

    return date.toLocaleDateString();
}

function getInitials(name) {
    const value = String(name || "Admin").trim();

    if (!value) {
        return "A";
    }

    const parts = value.split(/\s+/);

    if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
    }

    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function showToast(message, isError = false) {
    const toast = document.getElementById("adminToast");

    if (!toast) return;

    clearTimeout(toastTimer);

    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("show");

    toastTimer = setTimeout(() => {
        toast.classList.remove("show");
    }, 3000);
}

function riskClass(score) {
    const value = Number(score) || 0;

    if (value >= 70) return "risk-high";
    if (value >= 40) return "risk-medium";

    return "risk-low";
}


// ============================================================
// AUTHENTICATION
// ============================================================

async function checkAdminAuth() {
    try {
        const response = await api("/auth/me");

        if (!response || !response.authenticated || !response.user) {
            throw new Error("Authentication required.");
        }

        if (response.user.role !== "admin") {
            window.location.replace("dashboard.html");
            return null;
        }

        currentAdmin = response.user;

        updateAdminProfile(response.user);

        return response.user;

    } catch (error) {
        console.error("Admin authentication failed:", error);

        window.location.replace("login.html");

        return null;
    }
}

function updateAdminProfile(user) {
    const nameElement = document.getElementById("adminName");
    const emailElement = document.getElementById("adminEmail");
    const avatarElement = document.getElementById("adminAvatar");
    const sessionDetail = document.getElementById("sessionDetail");

    if (nameElement) {
        nameElement.textContent = user.name || "Security Admin";
    }

    if (emailElement) {
        emailElement.textContent = user.email || "—";
    }

    if (avatarElement) {
        avatarElement.textContent = getInitials(user.name);
    }

    if (sessionDetail) {
        sessionDetail.textContent =
            `${user.email || "Administrator"} • MFA enabled • Account ${user.status || "active"}`;
    }
}


// ============================================================
// NAVIGATION
// ============================================================

function setupNavigation() {
    document.querySelectorAll(".admin-nav-btn").forEach((button) => {
        button.addEventListener("click", async () => {
            const sectionName = button.dataset.section;

            if (!ADMIN_SECTIONS.includes(sectionName)) {
                return;
            }

            document.querySelectorAll(".admin-nav-btn").forEach((item) => {
                item.classList.toggle(
                    "active",
                    item.dataset.section === sectionName
                );
            });

            document.querySelectorAll(".admin-section").forEach((section) => {
                section.classList.toggle(
                    "active",
                    section.id === sectionName
                );
            });

            await loadSection(sectionName);
        });
    });
}

async function loadSection(sectionName) {
    if (sectionName === "overview") {
        await loadOverview();
        return;
    }

    if (sectionName === "players") {
        await loadPlayers();
        return;
    }

    if (sectionName === "security-events") {
        await loadSecurityEvents();
        return;
    }

    if (sectionName === "game-monitoring") {
        await loadGameMonitoring();
    }
}


// ============================================================
// OVERVIEW
// ============================================================

async function loadOverview() {
    try {
        const data = await api("/admin/overview");

        const summary = data.summary || data.stats || {};

        document.getElementById("playerCount").textContent =
            summary.total_players ?? 0;

        document.getElementById("sessionCount").textContent =
            summary.active_sessions ?? 0;

        document.getElementById("matchCount").textContent =
            summary.matches_analyzed ?? 0;

        document.getElementById("highCount").textContent =
            summary.high_severity_events ?? 0;

        renderRecentEvents(data.events || []);

    } catch (error) {
        console.error("Overview loading failed:", error);

        document.getElementById("recentEvents").innerHTML = `
            <div class="admin-empty">
                <strong>Unable to load security activity</strong>
                <span>${escapeHtml(error.message)}</span>
            </div>
        `;
    }
}

function renderRecentEvents(events) {
    const container = document.getElementById("recentEvents");

    if (!container) return;

    if (!events.length) {
        container.innerHTML = `
            <div class="admin-empty">
                <strong>No security events recorded</strong>
                <span>New authentication and security activity will appear here.</span>
            </div>
        `;

        return;
    }

    container.innerHTML = `
        <div class="admin-table-wrap">
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Event</th>
                        <th>Severity</th>
                        <th>User</th>
                        <th>Description</th>
                    </tr>
                </thead>

                <tbody>
                    ${events.slice(0, 8).map((event) => `
                        <tr>
                            <td>
                                ${escapeHtml(formatDate(event.timestamp))}
                            </td>

                            <td>
                                <span class="event-type">
                                    ${escapeHtml(
                                        event.event_type ||
                                        event.type ||
                                        "Security event"
                                    )}
                                </span>
                            </td>

                            <td>
                                <span class="severity-badge severity-${escapeHtml(
                                    event.severity || "low"
                                )}">
                                    ${escapeHtml(event.severity || "low")}
                                </span>
                            </td>

                            <td>
                                ${escapeHtml(event.user || event.user_id || "System")}
                            </td>

                            <td>
                                <span class="event-description">
                                    ${escapeHtml(
                                        event.description ||
                                        "Security event recorded."
                                    )}
                                </span>
                            </td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        </div>
    `;
}


// ============================================================
// PLAYERS
// ============================================================

async function loadPlayers() {
    const container = document.getElementById("playersContainer");
    const summary = document.getElementById("playersSummary");

    if (!container) return;

    container.innerHTML = `
        <div class="admin-empty">
            <strong>Loading player accounts</strong>
            <span>Fetching current account data...</span>
        </div>
    `;

    try {
        const data = await api("/admin/players");

        const players = Array.isArray(data.players)
            ? data.players
            : [];

        if (summary) {
            summary.textContent =
                `${players.length} player account${players.length === 1 ? "" : "s"} registered`;
        }

        if (!players.length) {
            container.innerHTML = `
                <div class="admin-empty">
                    <strong>No player accounts found</strong>
                    <span>
                        Create a player account and it will appear here automatically.
                    </span>
                </div>
            `;

            return;
        }

        container.innerHTML = `
            <div class="admin-table-wrap">
                <table class="admin-table">

                    <thead>
                        <tr>
                            <th>Player</th>
                            <th>Email</th>
                            <th>MFA</th>
                            <th>Status</th>
                            <th>Risk</th>
                            <th>Created</th>
                            <th>Actions</th>
                        </tr>
                    </thead>

                    <tbody>
                        ${players
                            .map((player) => renderPlayerRow(player))
                            .join("")}
                    </tbody>

                </table>
            </div>
        `;

        attachPlayerActions();

    } catch (error) {
        console.error("Players loading failed:", error);

        if (summary) {
            summary.textContent = "Unable to load player accounts";
        }

        container.innerHTML = `
            <div class="admin-empty">
                <strong>Unable to load players</strong>
                <span>${escapeHtml(error.message)}</span>
            </div>
        `;
    }
}

function renderPlayerRow(player) {
    const playerId = escapeHtml(player.id);

    const playerName = escapeHtml(
        player.username ||
        player.name ||
        "Player"
    );

    const playerEmail = escapeHtml(
        player.email ||
        "—"
    );

    const mfaEnabled =
        player.mfa_status === "Enabled" ||
        player.mfa_enabled === true;

    const status =
        player.account_status ||
        player.status ||
        "active";

    const risk =
        Number(player.risk_score || 0);

    return `
        <tr>

            <td>
                <div class="player-cell">
                    <strong>${playerName}</strong>
                    <small>${playerId}</small>
                </div>
            </td>

            <td>
                ${playerEmail}
            </td>

            <td>
                <span class="mfa-badge ${
                    mfaEnabled
                        ? "mfa-enabled"
                        : "mfa-disabled"
                }">
                    ${
                        mfaEnabled
                            ? "✓ Enabled"
                            : "✕ Disabled"
                    }
                </span>
            </td>

            <td>
                <span class="status-badge ${
                    status === "active"
                        ? "status-active"
                        : "status-suspended"
                }">
                    ${escapeHtml(status)}
                </span>
            </td>

            <td>
                <span class="risk-value ${riskClass(risk)}">
                    ${risk}
                </span>
            </td>

            <td>
                ${escapeHtml(formatDateOnly(player.created_at))}
            </td>

            <td>

                <div class="table-actions">

                    <button
                        class="table-action"
                        type="button"
                        data-action="view"
                        data-player-id="${playerId}">
                        View
                    </button>

                    ${
                        status === "active"
                            ? `
                                <button
                                    class="table-action danger"
                                    type="button"
                                    data-action="suspend"
                                    data-player-id="${playerId}"
                                    data-player-name="${playerName}">
                                    Suspend
                                </button>
                              `
                            : `
                                <button
                                    class="table-action"
                                    type="button"
                                    data-action="activate"
                                    data-player-id="${playerId}"
                                    data-player-name="${playerName}">
                                    Activate
                                </button>
                              `
                    }

                    <button
                        class="table-action danger"
                        type="button"
                        data-action="delete"
                        data-player-id="${playerId}"
                        data-player-name="${playerName}">
                        Delete
                    </button>

                </div>

            </td>

        </tr>
    `;
}

function attachPlayerActions() {

    document
        .querySelectorAll("[data-action='view']")
        .forEach((button) => {

            button.addEventListener("click", () => {
                viewPlayer(button.dataset.playerId);
            });

        });

    document
        .querySelectorAll("[data-action='suspend']")
        .forEach((button) => {

            button.addEventListener("click", () => {

                updatePlayerStatus(
                    button.dataset.playerId,
                    "suspend",
                    button.dataset.playerName
                );

            });

        });

    document
        .querySelectorAll("[data-action='activate']")
        .forEach((button) => {

            button.addEventListener("click", () => {

                updatePlayerStatus(
                    button.dataset.playerId,
                    "activate",
                    button.dataset.playerName
                );

            });

        });

    document
        .querySelectorAll("[data-action='delete']")
        .forEach((button) => {

            button.addEventListener("click", () => {

                deletePlayer(
                    button.dataset.playerId,
                    button.dataset.playerName
                );

            });

        });
}


// ============================================================
// VIEW PLAYER
// ============================================================

async function viewPlayer(playerId) {

    try {

        const data = await api(
            `/admin/players/${encodeURIComponent(playerId)}`
        );

        const user = data.user || {};
        const gameplay = data.gameplay || {};
        const security = data.security || {};

        const message = [
            `Player: ${user.username || user.name || "—"}`,
            `Email: ${user.email || "—"}`,
            `Status: ${user.account_status || user.status || "—"}`,
            `Risk score: ${security.risk_score ?? 0}`,
            `Matches: ${gameplay.total_matches ?? 0}`,
            `Detections: ${security.detections?.length ?? 0}`,
            `MFA: ${user.mfa_status || "—"}`
        ].join("\n");

        alert(message);

    } catch (error) {

        showToast(
            `Unable to load player: ${error.message}`,
            true
        );

    }
}


// ============================================================
// SUSPEND / ACTIVATE
// ============================================================

async function updatePlayerStatus(
    playerId,
    action,
    playerName
) {

    const actionText =
        action === "suspend"
            ? `Suspend ${playerName}?`
            : `Activate ${playerName}?`;

    if (!window.confirm(actionText)) {
        return;
    }

    try {

        await api(
            `/admin/players/${encodeURIComponent(playerId)}/${action}`,
            {
                method: "POST"
            }
        );

        showToast(
            action === "suspend"
                ? "Player suspended successfully."
                : "Player activated successfully."
        );

        await loadPlayers();
        await loadOverview();

    } catch (error) {

        showToast(
            `Action failed: ${error.message}`,
            true
        );

    }
}


// ============================================================
// DELETE PLAYER
// ============================================================

async function deletePlayer(
    playerId,
    playerName
) {

    if (!window.confirm(
        `Delete ${playerName} permanently?\n\n` +
        `This removes the player's account and related security records.`
    )) {
        return;
    }

    try {

        await api(
            `/admin/players/${encodeURIComponent(playerId)}/delete`,
            {
                method: "POST"
            }
        );

        showToast(
            "Player account deleted."
        );

        await loadPlayers();
        await loadOverview();

    } catch (error) {

        showToast(
            `Delete failed: ${error.message}`,
            true
        );

    }
}


// ============================================================
// SECURITY EVENTS
// ============================================================

async function loadSecurityEvents() {

    const container =
        document.getElementById("eventsContainer");

    const severity =
        document.getElementById("severityFilter")?.value || "";

    if (!container) {
        return;
    }

    container.innerHTML = `
        <div class="admin-empty">
            <strong>Loading security events</strong>
            <span>Fetching the audit trail...</span>
        </div>
    `;

    try {

        const path = severity
            ? `/admin/security-events?severity=${encodeURIComponent(severity)}`
            : "/admin/security-events";

        const data = await api(path);

        const events =
            Array.isArray(data.events)
                ? data.events
                : [];

        if (!events.length) {

            container.innerHTML = `
                <div class="admin-empty">
                    <strong>No matching security events</strong>
                    <span>
                        There are no events for the selected severity.
                    </span>
                </div>
            `;

            return;
        }

        container.innerHTML = `
            <div class="admin-table-wrap">

                <table class="admin-table">

                    <thead>
                        <tr>
                            <th>Timestamp</th>
                            <th>Event</th>
                            <th>Severity</th>
                            <th>User</th>
                            <th>Description</th>
                        </tr>
                    </thead>

                    <tbody>

                        ${events.map((event) => `

                            <tr>

                                <td>
                                    ${escapeHtml(
                                        formatDate(event.timestamp)
                                    )}
                                </td>

                                <td>
                                    <span class="event-type">
                                        ${escapeHtml(
                                            event.event_type ||
                                            event.type ||
                                            "Security event"
                                        )}
                                    </span>
                                </td>

                                <td>
                                    <span class="severity-badge severity-${escapeHtml(
                                        event.severity || "low"
                                    )}">
                                        ${escapeHtml(
                                            event.severity || "low"
                                        )}
                                    </span>
                                </td>

                                <td>
                                    ${escapeHtml(
                                        event.user ||
                                        event.user_id ||
                                        "System"
                                    )}
                                </td>

                                <td>
                                    <span class="event-description">
                                        ${escapeHtml(
                                            event.description ||
                                            "Security event recorded."
                                        )}
                                    </span>
                                </td>

                            </tr>

                        `).join("")}

                    </tbody>

                </table>

            </div>
        `;

    } catch (error) {

        console.error(
            "Security events loading failed:",
            error
        );

        container.innerHTML = `
            <div class="admin-empty">
                <strong>
                    Unable to load security events
                </strong>

                <span>
                    ${escapeHtml(error.message)}
                </span>
            </div>
        `;
    }
}


// ============================================================
// GAME MONITORING
// ============================================================

async function loadGameMonitoring() {

    try {

        const data =
            await api("/admin/game-monitoring");

        document.getElementById("activeGames").textContent =
            data.active_games?.length ?? 0;

        document.getElementById("totalMatches").textContent =
            data.total_matches ?? 0;

        document.getElementById("suspicionRate").textContent =
            `${Number(
                data.average_suspicion_rate ?? 0
            ).toFixed(2)}%`;

        document.getElementById("detectionCount").textContent =
            data.detections ?? 0;

        renderSupportedGames(
            data.supported_games || []
        );

        renderActiveGames(
            data.active_games || []
        );

    } catch (error) {

        console.error(
            "Game monitoring loading failed:",
            error
        );

        document.getElementById(
            "supportedGames"
        ).innerHTML = `
            <div class="admin-empty">

                <strong>
                    Unable to load monitoring data
                </strong>

                <span>
                    ${escapeHtml(error.message)}
                </span>

            </div>
        `;

        document.getElementById(
            "activeGamesList"
        ).innerHTML = "";
    }
}

function renderSupportedGames(games) {

    const container =
        document.getElementById("supportedGames");

    if (!container) {
        return;
    }

    if (!games.length) {

        container.innerHTML = `
            <div class="admin-empty">

                <strong>
                    No supported games connected
                </strong>

                <span>
                    Connected games will appear here.
                </span>

            </div>
        `;

        return;
    }

    container.innerHTML =
        games.map((game) => `

            <article class="game-card">

                <div class="game-card-top">

                    <span class="game-code">
                        ${escapeHtml(
                            String(
                                game.id ||
                                "GAME"
                            ).toUpperCase()
                        )}
                    </span>

                    <span class="game-live">
                        ● ${escapeHtml(
                            game.status ||
                            "available"
                        )}
                    </span>

                </div>

                <h3>
                    ${escapeHtml(
                        game.name ||
                        "Supported game"
                    )}
                </h3>

                <p>
                    Connected to SecureFPS telemetry
                    and security monitoring.
                </p>

                <div class="game-card-footer">

                    <span>
                        Monitoring status
                    </span>

                    <strong>
                        ${escapeHtml(
                            game.status ||
                            "available"
                        )}
                    </strong>

                </div>

            </article>

        `).join("");
}

function renderActiveGames(games) {

    const container =
        document.getElementById(
            "activeGamesList"
        );

    if (!container) {
        return;
    }

    if (!games.length) {

        container.innerHTML = `
            <div class="admin-empty">

                <strong>
                    No active gameplay
                </strong>

                <span>
                    No matches are currently reporting telemetry.
                </span>

            </div>
        `;

        return;
    }

    container.innerHTML = `

        <div class="admin-table-wrap">

            <table class="admin-table">

                <thead>

                    <tr>
                        <th>Match</th>
                        <th>Game</th>
                        <th>Player</th>
                        <th>Started</th>
                    </tr>

                </thead>

                <tbody>

                    ${games.map((game) => `

                        <tr>

                            <td>
                                ${escapeHtml(
                                    game.match_id ||
                                    "—"
                                )}
                            </td>

                            <td>
                                ${escapeHtml(
                                    game.game_id ||
                                    "—"
                                )}
                            </td>

                            <td>
                                ${escapeHtml(
                                    game.player_id ||
                                    "—"
                                )}
                            </td>

                            <td>
                                ${escapeHtml(
                                    formatDate(
                                        game.started_at
                                    )
                                )}
                            </td>

                        </tr>

                    `).join("")}

                </tbody>

            </table>

        </div>
    `;
}


// ============================================================
// LOGOUT
// ============================================================

function setupLogout() {

    const button =
        document.getElementById("logoutBtn");

    if (!button) {
        return;
    }

    button.addEventListener(
        "click",
        async () => {

            button.disabled = true;
            button.textContent = "Signing out...";

            try {

                await api(
                    "/auth/logout",
                    {
                        method: "POST"
                    }
                );

            } catch (error) {

                console.error(
                    "Logout failed:",
                    error
                );

            } finally {

                window.location.replace(
                    "login.html"
                );

            }

        }
    );
}


// ============================================================
// FILTERS
// ============================================================

function setupFilters() {

    const filter =
        document.getElementById(
            "severityFilter"
        );

    if (!filter) {
        return;
    }

    filter.addEventListener(
        "change",
        loadSecurityEvents
    );
}


// ============================================================
// INITIALIZATION
// ============================================================

async function initializeAdmin() {

    setupNavigation();

    setupLogout();

    setupFilters();

    const user =
        await checkAdminAuth();

    if (!user) {
        return;
    }

    await loadOverview();
}

document.addEventListener(
    "DOMContentLoaded",
    initializeAdmin
);