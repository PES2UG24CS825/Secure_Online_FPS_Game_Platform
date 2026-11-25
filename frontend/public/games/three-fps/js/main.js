/**
 * SecureFPS: CyberStrike 3D - Main Game Engine & Tactical Hub
 * Orchestrates WebGL 2.0 rendering, 60+ FPS kinematics, adult TacticalOperator 3D models,
 * realistic weapons arsenal, 6-option main menu, 5-action pause menu, match scoreboard (TAB),
 * 6-character room multiplayer lobby, and real-time security telemetry.
 */

window.SecureFPSGame = {
  scene: null,
  camera: null,
  renderer: null,
  arena: null,
  lighting: null,
  controller: null,
  hud: null,
  weapons: null,
  botManager: null,
  gameMode: null,
  telemetry: null,
  multiplayer: null,
  menuOperator: null,
  clock: null,
  isInitialized: false,
  isPaused: false,
  isMenuOpen: true
};

document.addEventListener('DOMContentLoaded', () => {
  initGame();
});

function showGameStartupFailure(message) {
  for (const id of ['pause-overlay', 'scoreboard-overlay', 'death-overlay']) {
    document.getElementById(id)?.classList.remove('active');
  }
  for (const id of ['match-complete-overlay', 'training-complete-overlay', 'voluntary-exit-modal']) {
    const layer = document.getElementById(id);
    if (layer) layer.style.display = 'none';
  }
  const section = document.getElementById('game-start-failure');
  document.getElementById('game-start-failure-message').textContent = message;
  document.getElementById('loader-progress-box').style.display = 'none';
  document.getElementById('main-menu-hub').style.display = 'none';
  document.getElementById('loading-overlay').classList.remove('hidden');
  section.hidden = false;
  const retry = document.getElementById('game-start-retry');
  retry.onclick = () => window.location.reload();
  retry.focus();
}

/**
 * Step-by-step asynchronous game initialization with progress visualizer
 */
async function initGame() {
  const statusEl = document.getElementById('loader-status-text');
  const fillEl = document.getElementById('loader-progress-fill');
  const percentEl = document.getElementById('loader-percent');
  const progressBox = document.getElementById('loader-progress-box');
  const menuHub = document.getElementById('main-menu-hub');
  const canvas = document.getElementById('game-canvas');

  function updateProgress(step, text, percent) {
    if (statusEl) statusEl.textContent = `[${step}/7] ${text}`;
    if (fillEl) fillEl.style.width = `${percent}%`;
    if (percentEl) percentEl.textContent = `${percent}%`;
    return new Promise(resolve => setTimeout(resolve, 45));
  }

  try {
    // Step 1: WebGL Renderer initialization with High-Performance Settings
    await updateProgress(1, 'Initializing High-Performance WebGL 2.0 Renderer...', 15);
    const renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      cancelAnimationFrame(window.SecureFPSGame.animationFrameId);
      window.SecureFPSGame.isInitialized = false;
      window.SecureFPSGame.isPaused = false;
      document.exitPointerLock?.();
      showGameStartupFailure('The graphics context was lost. Reload to restart the arena.');
    }, { once: true });
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    window.SecureFPSGame.renderer = renderer;

    // Step 2: Scene & Camera
    await updateProgress(2, 'Building Tactical 3D Scene & Perspective Camera...', 30);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 400);
    scene.add(camera);
    window.SecureFPSGame.scene = scene;
    window.SecureFPSGame.camera = camera;

    // Step 3: Lighting, Atmospheric Fog & Sky Dome
    await updateProgress(3, 'Calibrating Soft Shadows, Sky Dome & Atmosphere...', 48);
    const lighting = new Lighting(scene);
    window.SecureFPSGame.lighting = lighting;

    // Step 4: Tactical Training Arena Construction & Collision Volumes
    await updateProgress(4, 'Building Tactical Arena, Central Compound & Colliders...', 65);
    const arena = new Arena(scene);
    window.SecureFPSGame.arena = arena;

    // Step 5: First-Person Controller & Audio
    await updateProgress(5, 'Calibrating Kinematic FPS Controller & Audio Engine...', 78);
    window.gameAudio.init();
    const controller = new Controller(camera, canvas, arena);
    window.SecureFPSGame.controller = controller;

    // Step 6: Weapons, Balanced Bot AI & Game Mode Systems
    await updateProgress(6, 'Preloading Rigged Adult Operator Models & Arsenal...', 90);
    await TacticalOperator.loadAssets();

    const weapons = new WeaponManager(scene, camera, window.gameAudio);
    window.SecureFPSGame.weapons = weapons;

    const botManager = new BotManager(scene, arena, window.gameAudio);
    window.SecureFPSGame.botManager = botManager;

    const gameMode = new GameModeManager(window.gameAudio);
    window.SecureFPSGame.gameMode = gameMode;

    const trainingManager = new TrainingManager(scene, arena, window.gameAudio);
    window.SecureFPSGame.trainingManager = trainingManager;

    const hud = new HUD(controller);
    window.SecureFPSGame.hud = hud;

    // 3D Menu Operator Preview Presentation (Task Force Ghost Operator)
    const menuOperator = new TacticalOperator(scene, {
      isEnemy: false,
      callsign: "TaskForce_Ghost",
      position: new THREE.Vector3(0, 0, 24)
    });
    window.SecureFPSGame.menuOperator = menuOperator;

    // Step 7: Telemetry & Authoritative Multiplayer Client
    await updateProgress(7, 'Connecting Real Gameplay Telemetry & Networking...', 100);
    const telemetry = new TelemetryClient();
    window.SecureFPSGame.telemetry = telemetry;

    const multiplayer = new MultiplayerClient(scene, window.gameAudio);
    window.SecureFPSGame.multiplayer = multiplayer;

    window.SecureFPSGame.clock = new THREE.Clock();
    window.SecureFPSGame.isInitialized = true;
    window.SecureFPSGame.isMenuOpen = true;

    // Viewport layout alignment
    onWindowResize();

    // Transition from progress bar to Tactical Menu Hub
    if (progressBox) progressBox.style.display = 'none';
    if (menuHub) menuHub.style.display = 'block';

    // Position camera for 3D Menu Presentation
    camera.position.set(0, 1.7, 26.8);
    camera.lookAt(0, 1.4, 24);

    // Initialize Menu Tabs, Navigation, Difficulty Selector, and Settings
    initTacticalMenu(controller, gameMode, botManager, telemetry, multiplayer, camera);

    // Attach Window Event Handlers & Pause Navigation
    initWindowEvents(controller, gameMode, telemetry, multiplayer);
    initGameDialogFocus();

    // Initialize Live Dev Weapon Calibration Sliders (F3 overlay)
    initWeaponCalibrationSliders();

    // Kick off 60+ FPS render loop
    requestAnimationFrame(renderLoop);

  } catch (error) {
    console.error('[SecureFPS] Game initialization failed:', error);
    window.SecureFPSGame.isInitialized = false;
    showGameStartupFailure('The arena could not start. Reload the game or return to the dashboard.');
  }
}

/**
 * Initializes Menu Tabs, Mode Launchers, and Settings System
 */
function initTacticalMenu(controller, gameMode, botManager, telemetry, multiplayer, camera) {
  const loadingOverlay = document.getElementById('loading-overlay');

  // Helper to deploy local game match with strict mode isolation
  async function deployLocalMatch(mode, difficulty = 'normal') {
    window.gameAudio.resume();
    gameMode.setMode(mode);

    // Hide all modal overlays
    const mcOverlay = document.getElementById('match-complete-overlay');
    if (mcOverlay) mcOverlay.style.display = 'none';
    const tcOverlay = document.getElementById('training-complete-overlay');
    if (tcOverlay) tcOverlay.style.display = 'none';
    const pauseOverlay = document.getElementById('pause-overlay');
    if (pauseOverlay) pauseOverlay.classList.remove('active');

    window.SecureFPSGame.isMenuOpen = false;
    window.SecureFPSGame.isPaused = false;
    loadingOverlay.classList.add('hidden');
    const gameHud = document.getElementById('game-hud');
    if (gameHud) gameHud.style.display = 'block';

    const menuOp = window.SecureFPSGame.menuOperator;
    if (menuOp && menuOp.root) {
      menuOp.root.visible = false;
      menuOp.root.position.set(0, -999, 0); // Displace far away from player view & colliders
      const sc = window.SecureFPSGame.scene;
      if (sc && sc.children.includes(menuOp.root)) {
        sc.remove(menuOp.root);
      }
    }

    const trainingMgr = window.SecureFPSGame.trainingManager;

    if (mode === 'training') {
      // Training mode: disable combat bots, start target range simulation
      botManager.setEnabled(false);
      botManager.stopAllBots();
      if (trainingMgr) trainingMgr.startSimulation();
    } else if (mode === 'solo') {
      // Free Roam: zero hostile bots, free arena exploration (Task 3d)
      if (trainingMgr) trainingMgr.stopSimulation();
      botManager.setEnabled(false);
      botManager.stopAllBots();
      gameMode.targetKills = 0;
    } else if (mode === 'bots') {
      // Bot Combat: first to 15 kills or 8:00, whichever comes first.
      if (trainingMgr) trainingMgr.stopSimulation();
      botManager.setEnabled(true);
      if (typeof botManager.resetAllBots === 'function') {
        botManager.resetAllBots(new THREE.Vector3(0, 1.8, 28));
      } else {
        botManager.resumeAllBots();
      }
      botManager.setDifficulty(difficulty);
      gameMode.targetKills = 10;
    } else if (mode === 'multiplayer') {
      if (trainingMgr) trainingMgr.stopSimulation();
      botManager.setEnabled(false);
      botManager.stopAllBots();
    }

    window.SecureFPSGame.weapons?.resetForMatch();
    controller.respawn(new THREE.Vector3(0, 1.8, 28));
    controller.resetKeys();
    controller.requestLock();

    gameMode.startMatch();
    if (mode !== 'training') {
      await telemetry.startSession(mode, mode === 'bots' ? gameMode.difficulty : 'normal');
    }
    onWindowResize();
  }
  window.SecureFPSGame.deployLocalMatch = deployLocalMatch;

  window.addEventListener('fps:game_reconnected', async (event) => {
    const snapshot = event.detail || {};
    if (snapshot.state !== 'in_game') return;
    const localId = multiplayer.localPlayerId;
    const localPlayer = snapshot.players?.find(player => player.id === localId);
    if (!localPlayer) {
      console.warn('[SecureFPS Multiplayer] Reconnect snapshot did not include the local operator.');
      return;
    }

    gameMode.currentMode = 'multiplayer';
    gameMode.matchDuration = Number(snapshot.matchDuration) || 480;
    gameMode.targetKills = Number(snapshot.scoreLimit) || 10;
    gameMode.timeRemaining = Math.max(0, Number(snapshot.matchTimeRemaining) || 0);
    gameMode.matchActive = true;
    gameMode.isMatchCompleted = false;
    gameMode.playerHealth = Math.max(0, Number(localPlayer.health) || 0);
    gameMode.playerArmour = 0;
    gameMode.kills = Number(localPlayer.kills) || 0;
    gameMode.deaths = Number(localPlayer.deaths) || 0;
    gameMode.assists = Number(localPlayer.assists) || 0;
    gameMode.shotsFired = Number(localPlayer.totalShots) || 0;
    gameMode.shotsHit = Number(localPlayer.totalHits) || 0;
    gameMode.headshots = Number(localPlayer.headshots) || 0;
    gameMode.isDead = gameMode.playerHealth <= 0;
    gameMode.hasSpawnProtection = Boolean(localPlayer.spawnProtected);
    gameMode.spawnProtectionTimer = gameMode.hasSpawnProtection ? 2 : 0;
    controller.position.set(localPlayer.x, localPlayer.y, localPlayer.z);
    controller.yaw = Number(localPlayer.yaw) || 0;
    controller.pitch = Number(localPlayer.pitch) || 0;
    controller.velocity?.set(0, 0, 0);
    controller.resetKeys();

    window.SecureFPSGame.isMenuOpen = false;
    window.SecureFPSGame.isPaused = false;
    loadingOverlay.classList.add('hidden');
    document.getElementById('main-menu-hub').style.display = 'none';
    document.getElementById('game-hud').style.display = 'block';
    document.getElementById('pause-overlay')?.classList.remove('active');
    document.getElementById('match-complete-overlay').style.display = 'none';
    gameMode.updateHUD();
    gameMode.updateTimerDisplay();
    gameMode.updateSpawnProtectionHUD();

    if (!await telemetry.resumeSession()) {
      console.warn('[SecureFPS Multiplayer] Match restored without a resumable telemetry session.');
    }
    onWindowResize();
  });

  // =========================================================================
  // 1. MENU TABS NAVIGATION (6 Options)
  // =========================================================================
  const tabs = {
    solo: document.getElementById('tab-solo'),
    bots: document.getElementById('tab-bots'),
    multiplayer: document.getElementById('tab-multiplayer'),
    training: document.getElementById('tab-training'),
    settings: document.getElementById('tab-settings')
  };

  const views = {
    solo: document.getElementById('view-solo'),
    bots: document.getElementById('view-bots'),
    multiplayer: document.getElementById('view-multiplayer'),
    training: document.getElementById('view-training'),
    settings: document.getElementById('view-settings')
  };

  function switchTab(tabKey) {
    Object.keys(tabs).forEach(k => {
      if (tabs[k]) tabs[k].classList.toggle('active', k === tabKey);
      if (views[k]) views[k].classList.toggle('active', k === tabKey);
    });

    if (tabKey === 'multiplayer') {
      void multiplayer.connect().catch(() => {});
    }
  }

  if (tabs.solo) tabs.solo.addEventListener('click', () => switchTab('solo'));
  if (tabs.bots) tabs.bots.addEventListener('click', () => switchTab('bots'));
  if (tabs.multiplayer) tabs.multiplayer.addEventListener('click', () => switchTab('multiplayer'));
  if (tabs.training) tabs.training.addEventListener('click', () => switchTab('training'));
  if (tabs.settings) tabs.settings.addEventListener('click', () => switchTab('settings'));

  // Exit Option: Return to SecureFPS Player Dashboard
  const btnMenuExitDashboard = document.getElementById('btn-menu-exit-dashboard');
  if (btnMenuExitDashboard) {
    btnMenuExitDashboard.addEventListener('click', () => {
      safeExitToDashboard(telemetry);
    });
  }

  // =========================================================================
  // 2. PLAY SOLO DEPLOYMENT
  // =========================================================================
  const btnDeploySolo = document.getElementById('btn-deploy-solo');
  if (btnDeploySolo) {
    btnDeploySolo.addEventListener('click', () => {
      deployLocalMatch('solo', 'normal');
    });
  }

  // =========================================================================
  // 3. PLAY WITH BOTS & DIFFICULTY SELECTOR
  // =========================================================================
  let selectedDifficulty = 'normal';
  const diffCards = document.querySelectorAll('.difficulty-card');

  diffCards.forEach(card => {
    card.addEventListener('click', () => {
      diffCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedDifficulty = card.dataset.diff || 'normal';
    });
  });

  const btnDeployBots = document.getElementById('btn-deploy-bots');
  if (btnDeployBots) {
    btnDeployBots.addEventListener('click', () => {
      deployLocalMatch('bots', selectedDifficulty);
    });
  }

  // =========================================================================
  // 4. TRAINING MODE DEPLOYMENT
  // =========================================================================
  const btnDeployTraining = document.getElementById('btn-deploy-training');
  if (btnDeployTraining) {
    btnDeployTraining.addEventListener('click', () => {
      deployLocalMatch('training');
    });
  }

  // =========================================================================
  // 5. MULTIPLAYER LOBBY SYSTEM
  // =========================================================================
  const playerNameInput = document.getElementById('mp-player-name');
  const operatorSelect = document.getElementById('mp-operator');
  const previews = { vanguard: window.SecureFPSGame.menuOperator };
  function selectOperator() {
    const key = operatorSelect.value;
    if (!previews[key]) {
      previews[key] = new TacticalOperator(window.SecureFPSGame.scene, {
        isFemale: true,
        callsign: 'Valkyrie',
        position: new THREE.Vector3(0, 0, 24),
      });
    }
    window.SecureFPSGame.menuOperator.root.visible = false;
    window.SecureFPSGame.menuOperator = previews[key];
    previews[key].root.visible = true;
  }
  operatorSelect.value = localStorage.getItem('securefps_operator') === 'valkyrie' ? 'valkyrie' : 'vanguard';
  operatorSelect.addEventListener('change', () => {
    selectOperator();
    localStorage.setItem('securefps_operator', operatorSelect.value);
  });
  selectOperator();
  const serverStatusPill = document.getElementById('mp-server-status');
  const serverStatusText = document.getElementById('mp-status-text');
  const roomSelectView = document.getElementById('mp-room-selection');
  const lobbyView = document.getElementById('mp-lobby-view');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const roomCodeInput = document.getElementById('mp-room-code-input');
  const errorBanner = document.getElementById('mp-error-banner');

  const activeCodeEl = document.getElementById('mp-active-code');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const roleBadge = document.getElementById('mp-role-badge');
  const playersGrid = document.getElementById('mp-players-grid');
  const playerCountEl = document.getElementById('mp-player-count');
  const btnToggleReady = document.getElementById('btn-toggle-ready');
  const btnStartMatch = document.getElementById('btn-start-match');
  const btnLeaveRoom = document.getElementById('btn-leave-room');

  let savedName = sessionStorage.getItem('securefps_player_name');
  if (!savedName || savedName === 'Ghost_01') {
    savedName = `Operator_${Math.floor(100 + Math.random() * 900)}`;
    sessionStorage.setItem('securefps_player_name', savedName);
  }
  if (playerNameInput) playerNameInput.value = savedName;
  const hudOpName = document.getElementById('hud-operator-name');
  if (hudOpName) hudOpName.textContent = savedName.toUpperCase();

  const isDemoCallsign = (name) => {
    const s = String(name || '').toLowerCase();
    return s.includes('cheater') || s.includes('demo');
  };

  // Global F8 shortcut to toggle Cheater Demo Panel & ensure initialization
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F8' || e.code === 'F8') {
      e.preventDefault();
      const panel = document.getElementById('demo-cheater-panel');
      if (panel) {
        const isHidden = (panel.style.display === 'none' || !panel.style.display);
        initDemoControlPanel({ showPanel: false });
        panel.style.display = isHidden ? 'block' : 'none';
        if (isHidden && document.pointerLockElement && document.exitPointerLock) {
          try { document.exitPointerLock(); } catch (_) {}
        }
      } else {
        initDemoControlPanel();
      }
    }
  });

  if (playerNameInput) {
    playerNameInput.addEventListener('input', () => {
      const val = playerNameInput.value.trim();
      if (val) {
        sessionStorage.setItem('securefps_player_name', val);
        if (hudOpName) hudOpName.textContent = val.toUpperCase();
        if (isDemoCallsign(val)) {
          initDemoControlPanel();
        }
      }
    });
  }

  // Automatically sync session-authenticated profile username & Honour Score
  window.localPlayerHonour = 100;
  async function syncAuthenticatedProfile() {
    try {
      const apiBase = window.API_BASE || window.APP_CONFIG?.apiBase || (
        (window.location.port === "5000" || window.location.port === "" || window.location.protocol === "https:" || window.location.port === "8080")
          ? `${window.location.origin}/api`
          : `http://${window.location.hostname || "127.0.0.1"}:5000/api`
      );
      const res = await fetch(`${apiBase}/player/profile`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (data && data.name) {
          sessionStorage.setItem('securefps_player_name', data.name);
          if (playerNameInput) playerNameInput.value = data.name;
          const hudOpName = document.getElementById('hud-operator-name');
          if (hudOpName) hudOpName.textContent = data.name.toUpperCase();
          if (isDemoCallsign(data.name)) {
            initDemoControlPanel();
          }
        }
        if (data && typeof data.honour_score === 'number') {
          window.localPlayerHonour = data.honour_score;
        }
      }
      // Also fetch live honour endpoint
      const hRes = await fetch(`${apiBase}/game/honour`, { credentials: 'include' });
      if (hRes.ok) {
        const hData = await hRes.json();
        if (typeof hData.honour_score === 'number') {
          window.localPlayerHonour = hData.honour_score;
        }
      }

      // Check Cheater Demonstration Authorization (Phases 4 & 7)
      const demoRes = await fetch(`${apiBase}/game/demo-status`, { credentials: 'include' });
      if (demoRes.ok) {
        const demoData = await demoRes.json();
        if (demoData.can_use_demo_panel) {
          initDemoControlPanel();
        }
      }
    } catch (_) {}
  }
  syncAuthenticatedProfile();

  // If savedName or URL matches demo/cheater operator, activate immediately on startup
  if (isDemoCallsign(savedName) || window.location.search.includes('demo') || window.location.hash.includes('demo')) {
    initDemoControlPanel();
  }

  let _alertCollapseTimer = null;
  window.updateSecurityAlertBanner = function(mode, customMessage = null) {
    const banner = document.getElementById('cheat-alert-banner');
    const titleEl = document.getElementById('cheat-alert-title');
    const subEl = document.getElementById('cheat-alert-sub');
    if (!banner) return;

    if (_alertCollapseTimer) {
      clearTimeout(_alertCollapseTimer);
      _alertCollapseTimer = null;
    }

    if (mode === 'hide') {
      delete banner.dataset.serverEnforced;
      banner.classList.remove('visible', 'collapsed');
      return;
    }

    if (mode === 'server') {
      banner.dataset.serverEnforced = '1';
      if (titleEl) titleEl.textContent = 'SECURITY WARNING';
      if (subEl) subEl.textContent = customMessage || 'Suspicious gameplay activity detected.';
    } else {
      return;
    }

    banner.classList.remove('collapsed');
    banner.classList.add('visible');

    _alertCollapseTimer = setTimeout(() => {
      if (banner.classList.contains('visible')) {
        banner.classList.add('collapsed');
      }
    }, 5000);
  };

  function initDemoControlPanel(options = {}) {
    const panel = document.getElementById('demo-cheater-panel');
    const launcherBtn = document.getElementById('btn-demo-hud-launcher');
    if (!panel) return;
    if (launcherBtn) launcherBtn.style.display = 'inline-flex';
    if (options.showPanel !== false && (!panel.style.display || panel.style.display === 'none')) {
      panel.style.display = 'block';
    }

    if (window._demoControlPanelInitialized) return;
    window._demoControlPanelInitialized = true;

    const toggleDemoPanel = () => {
      const isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? 'block' : 'none';
      if (isHidden && document.pointerLockElement && document.exitPointerLock) {
        try { document.exitPointerLock(); } catch (_) {}
      }
    };

    if (launcherBtn) {
      launcherBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      launcherBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDemoPanel();
      });
    }
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('click', (e) => e.stopPropagation());

    const panelBody = document.getElementById('demo-cheater-panel-body');
    const btnCollapse = document.getElementById('btn-demo-collapse');
    const overallStatus = document.getElementById('demo-overall-status');
    const btnImpossibleHit = document.getElementById('btn-demo-impossible-hit');
    const statusImpossibleHit = document.getElementById('status-demo-impossible-hit');
    const btnSpeed = document.getElementById('btn-demo-speed');
    const statusSpeed = document.getElementById('status-demo-speed');
    const btnFireRate = document.getElementById('btn-demo-firerate');
    const statusFireRate = document.getElementById('status-demo-firerate');
    const btnAim = document.getElementById('btn-demo-aim');
    const statusAim = document.getElementById('status-demo-aim');
    const btnActivateAll = document.getElementById('btn-demo-activate-all');
    const btnReset = document.getElementById('btn-demo-reset');
    const btnStartMatch = document.getElementById('btn-demo-start-match');
    const btnEndMatch = document.getElementById('btn-demo-end-match');

    window.SecureFPSGame = window.SecureFPSGame || {};
    let demoToggleState = { speed: false, headshot: false, wallhack: false, rapidfire: false };

    function applyToggleState(state) {
      const speed = Boolean(state.speed);
      const headshot = Boolean(state.headshot);
      const wallhack = Boolean(state.wallhack);
      const rapidfire = Boolean(state.rapidfire);
      demoToggleState = { speed, headshot, wallhack, rapidfire };

      const ctrl = window.SecureFPSGame?.controller;
      const weap = window.SecureFPSGame?.weapons;
      const gm = window.SecureFPSGame?.gameMode;

      if (ctrl) ctrl.speedMultiplier = speed ? 4.0 : 1.0;
      if (weap) {
        weap.demoHighAccuracy = headshot;
        weap.demoImpossibleHit = wallhack;
        weap.fireRateMultiplier = rapidfire ? 3.0 : 1.0;
      }

      const activeCount = [speed, headshot, wallhack, rapidfire].filter(Boolean).length;
      window.SecureFPSGame.isCheaterDemoActive = activeCount > 0;
      window.SecureFPSGame.demoToggles = demoToggleState;
      window.isDemoGodModeActive = false;
      if (gm) gm.demoGodMode = false;

      const setBtnStyle = (btn, statusEl, isOn, onLabel = 'ON') => {
        if (statusEl) {
          statusEl.textContent = isOn ? onLabel : 'OFF';
          statusEl.style.color = isOn ? '#ef4444' : '#94a3b8';
        }
        if (btn) {
          btn.style.borderColor = isOn ? '#ef4444' : '#475569';
          btn.style.background = isOn ? 'rgba(239, 68, 68, 0.25)' : 'rgba(30, 41, 59, 0.9)';
        }
      };

      setBtnStyle(btnSpeed, statusSpeed, speed, '4× ON');
      setBtnStyle(btnAim, statusAim, headshot, 'ON');
      setBtnStyle(btnImpossibleHit, statusImpossibleHit, wallhack, 'ON');
      setBtnStyle(btnFireRate, statusFireRate, rapidfire, '3× ON');

      if (overallStatus) {
        overallStatus.textContent = activeCount > 0 ? `ACTIVE (${activeCount}/4)` : 'NORMAL (ALL OFF)';
        overallStatus.style.color = activeCount > 0 ? '#ef4444' : '#94a3b8';
      }

      if (window.SecureFPSGame?.multiplayer?.emitDemoToggles) {
        window.SecureFPSGame.multiplayer.emitDemoToggles({ speed, headshot, wallhack, rapidfire });
      }
    }

    function getCurrentState() {
      return { ...demoToggleState };
    }

    // Default: ALL demonstration options OFF on login / initialization
    applyToggleState({ speed: false, headshot: false, wallhack: false, rapidfire: false });

    // Collapsible panel toggle
    if (btnCollapse && panelBody) {
      btnCollapse.addEventListener('click', () => {
        const isCollapsed = panelBody.style.display === 'none';
        panelBody.style.display = isCollapsed ? 'block' : 'none';
        btnCollapse.textContent = isCollapsed ? '−' : '+';
      });
    }

    // Independent toggles
    if (btnSpeed) {
      btnSpeed.addEventListener('click', () => {
        const st = getCurrentState();
        applyToggleState({ ...st, speed: !st.speed });
      });
    }
    if (btnAim) {
      btnAim.addEventListener('click', () => {
        const st = getCurrentState();
        applyToggleState({ ...st, headshot: !st.headshot });
      });
    }
    if (btnImpossibleHit) {
      btnImpossibleHit.addEventListener('click', () => {
        const st = getCurrentState();
        applyToggleState({ ...st, wallhack: !st.wallhack });
      });
    }
    if (btnFireRate) {
      btnFireRate.addEventListener('click', () => {
        const st = getCurrentState();
        applyToggleState({ ...st, rapidfire: !st.rapidfire });
      });
    }

    // Activate All
    if (btnActivateAll) {
      btnActivateAll.addEventListener('click', () => {
        applyToggleState({ speed: true, headshot: true, wallhack: true, rapidfire: true });
      });
    }

    // Reset to Normal
    if (btnReset) {
      btnReset.addEventListener('click', () => {
        applyToggleState({ speed: false, headshot: false, wallhack: false, rapidfire: false });
      });
    }

    // Reset on disconnect, room leave, ban, or new game session
    window.addEventListener('fps:demo_reset', () => {
      applyToggleState({ speed: false, headshot: false, wallhack: false, rapidfire: false });
    });

    // Start Demo Match
    if (btnStartMatch) {
      btnStartMatch.addEventListener('click', () => {
        if (window.SecureFPSGame?.deployLocalMatch) {
          window.SecureFPSGame.deployLocalMatch('bots', 'normal');
        } else if (typeof deployLocalMatch === 'function') {
          deployLocalMatch('bots', 'normal');
        }
      });
    }

    // End Demo Match
    if (btnEndMatch) {
      btnEndMatch.addEventListener('click', async () => {
        const tel = window.SecureFPSGame?.telemetry;
        const gm = window.SecureFPSGame?.gameMode;
        const weap = window.SecureFPSGame?.weapons;
        if (tel?.isSessionActive) {
          const shots = gm?.shotsFired || weap?.shotsFired || 0;
          const hits = gm?.shotsHit || weap?.shotsHit || 0;
          const headshots = gm?.headshots || 0;
          await tel.endGameSession(true, {
            kills: gm?.kills || 0,
            deaths: gm?.deaths || 0,
            shots: shots,
            hits: hits,
            headshots: headshots,
            accuracy: shots > 0 ? hits / shots : 0,
            kdr: (gm?.kills || 0) / Math.max(1, gm?.deaths || 1)
          });
        }
        if (window.SecureFPSGame?.returnToMainMenu) {
          window.SecureFPSGame.returnToMainMenu();
        } else if (typeof returnToMainMenu === 'function') {
          returnToMainMenu();
        }
      });
    }

    // Real-Time ML Risk Score Display
    window.addEventListener('fps:ml_risk_update', (e) => {
      const riskEl = document.getElementById('hud-stat-risk');
      if (riskEl && e.detail?.risk_score != null) {
        const score = Math.round(e.detail.risk_score);
        riskEl.textContent = `${score}/100`;
        riskEl.style.color = score >= 75 ? '#ef4444' : score >= 50 ? '#f59e0b' : '#10b981';
      }
    });

    // Update Live Telemetry Contract HUD Ticker
    setInterval(() => {
      const shotsEl = document.getElementById('hud-stat-shots');
      const hitsEl = document.getElementById('hud-stat-hits');
      const headshotsEl = document.getElementById('hud-stat-headshots');
      const hsRatioEl = document.getElementById('hud-stat-hs-ratio');
      const accEl = document.getElementById('hud-stat-acc');
      const killsEl = document.getElementById('hud-stat-kills');
      const deathsEl = document.getElementById('hud-stat-deaths');
      const kdrEl = document.getElementById('hud-stat-kdr');
      const frEl = document.getElementById('hud-stat-firerate');
      const spdEl = document.getElementById('hud-stat-speed');
      const smEl = document.getElementById('hud-stat-smooth');

      const gm = window.SecureFPSGame?.gameMode;
      const weap = window.SecureFPSGame?.weapons;
      const ctrl = window.SecureFPSGame?.controller;

      const shots = Math.max(gm?.shotsFired || 0, weap?.shotsFired || 0);
      const hits = Math.max(gm?.shotsHit || 0, weap?.shotsHit || 0);
      const headshots = Math.max(gm?.headshots || 0, weap?.headshots || 0);
      const acc = shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0';
      const hsRatio = hits > 0 ? ((headshots / hits) * 100).toFixed(1) : '0';
      const kills = gm?.kills || 0;
      const deaths = gm?.deaths || 0;
      const kdr = (kills / Math.max(1, deaths)).toFixed(2);
      const horizSpeed = Math.hypot(ctrl?.velocity?.x || 0, ctrl?.velocity?.z || 0);

      if (shotsEl) shotsEl.textContent = shots;
      if (hitsEl) hitsEl.textContent = hits;
      if (headshotsEl) headshotsEl.textContent = headshots;
      if (hsRatioEl) hsRatioEl.textContent = `${hsRatio}%`;
      if (accEl) accEl.textContent = `${acc}%`;
      if (killsEl) killsEl.textContent = kills;
      if (deathsEl) deathsEl.textContent = deaths;
      if (kdrEl) kdrEl.textContent = kdr;
      if (spdEl) spdEl.textContent = `${horizSpeed.toFixed(1)}m/s`;
      if (frEl) {
        const mult = weap?.fireRateMultiplier || 1.0;
        const estRps = (1.0 / (weap?.activeWeapon?.fireRate || 0.13)) * mult;
        frEl.textContent = `${estRps.toFixed(1)}/s`;
      }
      if (smEl) {
        smEl.textContent = weap?.demoHighAccuracy ? '0.98' : '0.85';
      }
    }, 200);
  }

  function getPlayerName() {
    let name = (playerNameInput?.value || '').trim();
    if (!name) name = `Operator_${Math.floor(10 + Math.random() * 89)}`;
    return name;
  }

  function showError(msg) {
    if (!errorBanner) return;
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
    setTimeout(() => {
      errorBanner.style.display = 'none';
    }, 4500);
  }

  window.addEventListener('fps:mp_connected', (e) => {
    if (serverStatusText) serverStatusText.textContent = `ONLINE (${e.detail.url.split('//')[1]})`;
    if (serverStatusPill) serverStatusPill.style.color = '#10b981';
  });

  window.addEventListener('fps:mp_disconnected', () => {
    if (serverStatusText) serverStatusText.textContent = 'DISCONNECTED';
    if (serverStatusPill) serverStatusPill.style.color = '#ef4444';
  });

  window.addEventListener('fps:mp_error', (e) => {
    if (serverStatusText) serverStatusText.textContent = 'UNAVAILABLE';
    if (serverStatusPill) serverStatusPill.style.color = '#fbbf24';
    showError(e.detail.message || 'Multiplayer is unavailable.');
  });

  if (btnCreateRoom) {
    btnCreateRoom.addEventListener('click', () => {
      multiplayer.createRoom(getPlayerName(), window.localPlayerHonour || 100, operatorSelect.value);
    });
  }

  if (btnJoinRoom) {
    btnJoinRoom.addEventListener('click', () => {
      const code = (roomCodeInput?.value || '').trim().toUpperCase();
      if (!code || code.length !== 6) {
        showError('Please enter a valid 6-character room code.');
        return;
      }
      multiplayer.joinRoom(code, getPlayerName(), window.localPlayerHonour || 100, operatorSelect.value);
    });
  }

  function enterLobbyView(data) {
    if (roomSelectView) roomSelectView.style.display = 'none';
    if (lobbyView) lobbyView.style.display = 'block';

    if (activeCodeEl) activeCodeEl.textContent = data.roomCode;
    if (roleBadge) {
      roleBadge.textContent = data.isHost ? 'HOST' : 'MEMBER';
      roleBadge.className = `role-badge ${data.isHost ? 'host' : 'member'}`;
    }

    if (btnStartMatch) {
      btnStartMatch.style.display = data.isHost ? 'inline-block' : 'none';
    }

    renderLobbyPlayers(data.players || []);
  }

  window.addEventListener('fps:lobby_created', (e) => enterLobbyView(e.detail));
  window.addEventListener('fps:lobby_joined', (e) => enterLobbyView(e.detail));

  window.addEventListener('fps:lobby_host_changed', (e) => {
    if (roleBadge) {
      roleBadge.textContent = multiplayer.isHost ? 'HOST' : 'MEMBER';
      roleBadge.className = `role-badge ${multiplayer.isHost ? 'host' : 'member'}`;
    }
    if (btnStartMatch) {
      btnStartMatch.style.display = multiplayer.isHost ? 'inline-block' : 'none';
    }
  });

  window.addEventListener('fps:lobby_player_update', (e) => {
    renderLobbyPlayers(e.detail.players || []);
  });

  window.addEventListener('fps:lobby_error', (e) => {
    showError(e.detail.message || 'Lobby operation failed.');
  });

  window.addEventListener('fps:lobby_left', () => {
    if (lobbyView) lobbyView.style.display = 'none';
    if (roomSelectView) roomSelectView.style.display = 'block';
  });

  function renderLobbyPlayers(players) {
    if (!playersGrid) return;
    playersGrid.innerHTML = '';

    if (playerCountEl) playerCountEl.textContent = players.length;

    const isLocalHost = multiplayer.isHost;
    if (btnStartMatch) {
      btnStartMatch.style.display = isLocalHost ? 'inline-block' : 'none';
      if (isLocalHost) {
        const total = players.length;
        const allReady = (total >= 2 && players.every(p => p.isReady));
        if (allReady) {
          btnStartMatch.disabled = false;
          btnStartMatch.classList.remove('disabled');
          btnStartMatch.style.opacity = '1';
          btnStartMatch.style.cursor = 'pointer';
          btnStartMatch.textContent = 'START MATCH (HOST)';
        } else if (total < 2) {
          btnStartMatch.disabled = true;
          btnStartMatch.classList.add('disabled');
          btnStartMatch.style.opacity = '0.55';
          btnStartMatch.style.cursor = 'not-allowed';
          btnStartMatch.textContent = 'NEED 2+ OPERATORS';
        } else {
          btnStartMatch.disabled = true;
          btnStartMatch.classList.add('disabled');
          btnStartMatch.style.opacity = '0.55';
          btnStartMatch.style.cursor = 'not-allowed';
          btnStartMatch.textContent = 'WAITING FOR ALL READY';
        }
      }
    }

    if (btnToggleReady) {
      const myId = multiplayer.localPlayerId || multiplayer.socket?.id;
      const me = players.find(p => p.id === myId);
      if (me && me.isReady) {
        btnToggleReady.textContent = 'READY ✓';
        btnToggleReady.classList.add('primary');
      } else {
        btnToggleReady.textContent = 'SET READY';
        btnToggleReady.classList.remove('primary');
      }
    }

    for (let i = 0; i < 8; i++) {
      const slot = document.createElement('div');
      const p = players[i];

      if (p) {
        slot.className = 'lobby-player-slot occupied';
        slot.innerHTML = `
          <div class="slot-name">${p.isHost ? '👑 ' : ''}${p.name}</div>
          <div class="slot-honour-badge" title="Player Honour Score">★ ${p.honour_score ?? 100}</div>
          <div class="slot-status ${p.isReady ? 'ready' : 'waiting'}">
            ${p.isReady ? 'READY' : 'WAITING...'}
          </div>
        `;
      } else {
        slot.className = 'lobby-player-slot';
        slot.innerHTML = `
          <div class="slot-name" style="color: rgba(255,255,255,0.2);">OPEN SLOT</div>
          <div class="slot-status open">VACANT</div>
        `;
      }

      playersGrid.appendChild(slot);
    }
  }

  if (btnCopyCode) {
    btnCopyCode.addEventListener('click', () => {
      const code = activeCodeEl?.textContent;
      if (code) {
        navigator.clipboard.writeText(code).then(() => {
          btnCopyCode.textContent = '✓ COPIED';
          setTimeout(() => btnCopyCode.textContent = '📋 COPY', 1800);
        });
      }
    });
  }

  if (btnToggleReady) {
    btnToggleReady.addEventListener('click', () => {
      multiplayer.setReady(!multiplayer.isReady);
    });
  }

  if (btnStartMatch) {
    btnStartMatch.addEventListener('click', () => {
      multiplayer.startMatch();
    });
  }

  if (btnLeaveRoom) {
    btnLeaveRoom.addEventListener('click', () => {
      multiplayer.leaveRoom();
    });
  }

  window.addEventListener('fps:game_start', async (e) => {
    window.gameAudio.resume();
    gameMode.setMode('multiplayer', e.detail.matchDuration);
    window.SecureFPSGame.isMenuOpen = false;
    loadingOverlay.classList.add('hidden');

    const gameHud = document.getElementById('game-hud');
    if (gameHud) gameHud.style.display = 'block';

    // Disable AI bots in multiplayer so only connected human players engage
    if (window.SecureFPSGame.botManager) {
      window.SecureFPSGame.botManager.setEnabled(false);
      window.SecureFPSGame.botManager.stopAllBots();
    }

    const menuOp = window.SecureFPSGame.menuOperator;
    if (menuOp && menuOp.root) {
      menuOp.root.visible = false;
      menuOp.root.position.set(0, -999, 0); // Displace far away from player view & colliders
      const sc = window.SecureFPSGame.scene;
      if (sc && sc.children.includes(menuOp.root)) {
        sc.remove(menuOp.root);
      }
    }

    // CRITICAL FOCUS RESTORATION: Unfocus all lobby text inputs so WASD keys reach the Controller!
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    const canvas = document.getElementById('game-canvas');
    if (canvas && typeof canvas.focus === 'function') {
      canvas.focus();
    }
    if (typeof window.focus === 'function') {
      window.focus();
    }

    controller.resetKeys();
    controller.requestLock();

    window.SecureFPSGame.weapons?.resetForMatch();
    gameMode.targetKills = e.detail.scoreLimit ?? 10;
    gameMode.startMatch();
    await telemetry.startSession('multiplayer', 'normal');
    onWindowResize();

  });

  // =========================================================================
  // 6. SETTINGS FORM WIRING & LOCAL PERSISTENCE
  // =========================================================================
  // Mouse Sensitivity
  const sensInput = document.getElementById('setting-sens');
  const sensVal = document.getElementById('setting-sens-val');
  if (sensInput && sensVal) {
    sensInput.addEventListener('input', () => {
      sensVal.textContent = parseFloat(sensInput.value).toFixed(1);
      controller.mouseSensitivity = parseFloat(sensInput.value) * 0.00055;
    });
  }

  // Aim (ADS) Sensitivity Multiplier
  const aimSensInput = document.getElementById('setting-aim-sens');
  const aimSensVal = document.getElementById('setting-aim-sens-val');
  if (aimSensInput && aimSensVal) {
    aimSensInput.addEventListener('input', () => {
      const mult = parseFloat(aimSensInput.value) / 10;
      aimSensVal.textContent = `${mult.toFixed(1)}x`;
      controller.aimSensitivityMultiplier = mult;
    });
  }

  // Master Volume
  const masterVolInput = document.getElementById('setting-master-volume');
  const masterVolVal = document.getElementById('setting-master-val');
  const muteInput = document.getElementById('setting-mute');
  const updateMasterVolume = () => {
    masterVolVal.textContent = `${masterVolInput.value}%`;
    window.gameAudio.setMasterVolume(muteInput.checked ? 0 : Number(masterVolInput.value) / 100);
  };
  masterVolInput.addEventListener('input', updateMasterVolume);
  muteInput.addEventListener('change', updateMasterVolume);

  // Sound FX Volume
  const volumeInput = document.getElementById('setting-volume');
  const volumeVal = document.getElementById('setting-volume-val');
  if (volumeInput && volumeVal) {
    volumeInput.addEventListener('input', () => {
      volumeVal.textContent = `${volumeInput.value}%`;
      if (typeof window.gameAudio.setSFXVolume === 'function') {
        window.gameAudio.setSFXVolume(parseFloat(volumeInput.value) / 100);
      } else {
        window.gameAudio.setMasterVolume(parseFloat(volumeInput.value) / 100);
      }
    });
  }

  // Crosshair Size
  const crosshairSizeSelect = document.getElementById('setting-crosshair-size');
  if (crosshairSizeSelect) {
    crosshairSizeSelect.addEventListener('change', () => {
      window.SecureFPSGame?.hud?.setCrosshairSize(crosshairSizeSelect.value);
    });
  }

  // Crosshair Color
  const crosshairColorSelect = document.getElementById('setting-crosshair-color');
  if (crosshairColorSelect) {
    crosshairColorSelect.addEventListener('change', () => {
      window.SecureFPSGame?.hud?.setCrosshairColor(crosshairColorSelect.value);
    });
  }

  // Crosshair Visibility
  const crosshairVisibleCheck = document.getElementById('setting-crosshair-visible');
  if (crosshairVisibleCheck) {
    crosshairVisibleCheck.addEventListener('change', () => {
      window.SecureFPSGame?.hud?.setCrosshairVisible(crosshairVisibleCheck.checked);
    });
  }
  const crosshairOpacity = document.getElementById('setting-crosshair-opacity');
  crosshairOpacity.addEventListener('input', () => {
    document.getElementById('crosshair').style.opacity = Number(crosshairOpacity.value) / 100;
    document.getElementById('setting-crosshair-opacity-value').value = `${crosshairOpacity.value}%`;
  });

  // Show FPS Toggle
  const showFpsCheck = document.getElementById('setting-show-fps');
  if (showFpsCheck) {
    showFpsCheck.addEventListener('change', () => {
      const cleanFps = document.getElementById('clean-fps-badge');
      if (cleanFps) cleanFps.style.display = showFpsCheck.checked ? 'block' : 'none';
    });
  }

  // Field of View
  const fovInput = document.getElementById('setting-fov');
  const fovVal = document.getElementById('setting-fov-val');
  if (fovInput && fovVal) {
    fovInput.addEventListener('input', () => {
      const fov = parseInt(fovInput.value, 10);
      fovVal.textContent = `${fov}°`;
      camera.fov = fov;
      window.SecureFPSGame.weapons.baseFov = fov;
      camera.updateProjectionMatrix();
    });
  }

  // Invert Mouse Y
  const invertYCheck = document.getElementById('setting-invert-y');
  if (invertYCheck) {
    invertYCheck.addEventListener('change', () => {
      controller.invertY = invertYCheck.checked;
    });
  }

  // Graphics Quality
  const graphicsSelect = document.getElementById('setting-graphics');
  if (graphicsSelect) {
    graphicsSelect.addEventListener('change', () => {
      applyGraphicsQuality(graphicsSelect.value);
    });
  }

  // Fullscreen
  const btnFullscreen = document.getElementById('btn-toggle-fullscreen');
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
  }

  wireGamePreferences();
  wireGameRecording();

  if (sessionStorage.getItem('securefps_reconnect')) {
    switchTab('multiplayer');
  }
}

function wireGamePreferences() {
  const settingsKey = 'securefps_settings';
  const serverKey = 'securefps_server_url';
  const serverInput = document.getElementById('setting-server-url');
  const status = document.getElementById('settings-status');
  const fields = {
    sensitivity: 'setting-sens',
    aimSensitivity: 'setting-aim-sens',
    masterVolume: 'setting-master-volume',
    mute: 'setting-mute',
    sfxVolume: 'setting-volume',
    crosshairSize: 'setting-crosshair-size',
    crosshairColor: 'setting-crosshair-color',
    crosshairVisible: 'setting-crosshair-visible',
    crosshairOpacity: 'setting-crosshair-opacity',
    showFps: 'setting-show-fps',
    fov: 'setting-fov',
    invertY: 'setting-invert-y',
    graphics: 'setting-graphics',
  };

  function readPreferences() {
    return Object.fromEntries(Object.entries(fields).map(([key, id]) => {
      const input = document.getElementById(id);
      const value = input.type === 'checkbox' ? input.checked : input.value;
      return [key, key === 'aimSensitivity' ? String(Number(value) / 10) : value];
    }));
  }

  const defaults = readPreferences();

  function applyPreferences(preferences, strict = false) {
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new Error('Invalid settings file.');
    const values = Object.entries(fields).map(([key, id]) => {
      const input = document.getElementById(id);
      let value = preferences[key];
      let valid;
      if (input.type === 'checkbox') {
        valid = typeof value === 'boolean';
      } else if (input.type === 'range') {
        valid = ['string', 'number'].includes(typeof value) && String(value).trim() !== '';
        value = Number(value) * (key === 'aimSensitivity' ? 10 : 1);
        valid = valid && Number.isFinite(value) && value >= Number(input.min) && value <= Number(input.max);
      } else {
        valid = [...input.options].some(option => option.value === value);
      }
      if (!valid && strict && Object.hasOwn(preferences, key)) throw new Error(`Invalid preference: ${input.labels[0]?.textContent || key}.`);
      return { input, valid, value };
    });

    for (const { input, valid, value } of values) {
      if (!valid) continue;
      if (input.type === 'checkbox') input.checked = value;
      else input.value = value;
      input.dispatchEvent(new Event(input.type === 'range' ? 'input' : 'change'));
    }
  }

  function restore() {
    applyPreferences(defaults);
    const saved = localStorage.getItem(settingsKey);
    if (saved) applyPreferences(JSON.parse(saved));
    serverInput.value = localStorage.getItem(serverKey) || '';
  }

  try { restore(); } catch { status.textContent = 'Saved preferences could not be read.'; }

  document.getElementById('btn-save-settings').addEventListener('click', () => {
    try {
      const address = serverInput.value.trim();
      if (address) {
        const url = new URL(address);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
          throw new Error('Enter an HTTP or HTTPS server origin without credentials or a path.');
        }
        localStorage.setItem(serverKey, url.origin);
      } else {
        localStorage.removeItem(serverKey);
      }
      localStorage.setItem(settingsKey, JSON.stringify({ version: 1, ...readPreferences() }));
      status.textContent = 'Settings saved in this browser.';
    } catch (error) {
      status.textContent = error.message;
    }
  });
  document.getElementById('restore-settings').addEventListener('click', () => {
    try {
      restore();
      status.textContent = 'Saved preferences restored.';
    } catch {
      status.textContent = 'Saved preferences could not be read.';
    }
  });
  document.getElementById('reset-settings').addEventListener('click', () => {
    applyPreferences(defaults);
    serverInput.value = '';
    status.textContent = 'Defaults restored. Save settings to keep them.';
  });

  const fileInput = document.getElementById('settings-file');
  document.getElementById('import-settings').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      if (file.size > 16384) throw new Error('Settings files must be smaller than 16 KB.');
      const document = JSON.parse(await file.text());
      if (document?.version !== 1) throw new Error('Unsupported settings version.');
      applyPreferences(document.preferences, true);
      status.textContent = 'Preferences imported. Save settings to keep them.';
    } catch (error) {
      status.textContent = error.message;
    }
  });
  document.getElementById('export-settings').addEventListener('click', () => {
    const data = JSON.stringify({ version: 1, preferences: readPreferences() }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'securefps-settings.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const categories = document.querySelectorAll('[data-settings-category]');
  const panels = document.querySelectorAll('[data-settings-panel]');
  categories.forEach(button => button.addEventListener('click', () => {
    categories.forEach(category => category.setAttribute('aria-pressed', String(category === button)));
    panels.forEach(panel => { panel.hidden = panel.dataset.settingsPanel !== button.dataset.settingsCategory; });
  }));
}

function wireGameRecording() {
  const canvas = document.getElementById('game-canvas');
  const start = document.getElementById('start-recording');
  const stop = document.getElementById('stop-recording');
  const download = document.getElementById('download-recording');
  const status = document.getElementById('recording-status');
  if (!canvas?.captureStream || typeof MediaRecorder !== 'function') {
    status.textContent = 'Gameplay recording is unavailable in this browser.';
    return;
  }
  status.textContent = 'Capture up to five minutes of arena video without audio or HUD overlays.';
  start.disabled = false;
  let recorder;
  let recordingUrl;
  let timer;

  function stopRecording() {
    if (recorder?.state === 'recording') recorder.stop();
  }
  stop.addEventListener('click', stopRecording);

  start.addEventListener('click', () => {
    let stream;
    try {
      stream = canvas.captureStream(30);
      recorder = new MediaRecorder(stream, { videoBitsPerSecond: 4000000 });
      const chunks = [];
      let bytes = 0;
      let failed = false;
      recorder.addEventListener('dataavailable', event => {
        if (!event.data.size) return;
        chunks.push(event.data);
        bytes += event.data.size;
        if (bytes >= 150000000) stopRecording();
      });
      recorder.addEventListener('error', () => {
        failed = true;
        status.textContent = 'The browser could not finish recording.';
      });
      recorder.addEventListener('stop', () => {
        clearTimeout(timer);
        stream.getTracks().forEach(track => track.stop());
        start.disabled = false;
        stop.disabled = true;
        if (failed || !chunks.length) {
          status.textContent = 'No recording was saved.';
          return;
        }
        const mime = recorder.mimeType || chunks[0].type;
        if (recordingUrl) URL.revokeObjectURL(recordingUrl);
        recordingUrl = URL.createObjectURL(new Blob(chunks, { type: mime }));
        download.href = recordingUrl;
        download.download = `securefps-${Date.now()}.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
        download.hidden = false;
        status.textContent = 'Recording ready to download.';
      });
      recorder.start(1000);
      start.disabled = true;
      stop.disabled = false;
      status.textContent = 'Recording arena video.';
      timer = setTimeout(stopRecording, 300000);
    } catch {
      stream?.getTracks().forEach(track => track.stop());
      status.textContent = 'The browser could not start recording.';
    }
  });
}

function applyGraphicsQuality(quality) {
  const renderer = window.SecureFPSGame.renderer;
  if (!renderer) return;

  if (quality === 'high') {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.0));
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  } else if (quality === 'low') {
    renderer.setPixelRatio(1.0);
    renderer.shadowMap.type = THREE.BasicShadowMap;
  } else {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
}

/**
 * Window & Interaction Event Listeners, Pause Menu, Scoreboard (TAB)
 */
function initWindowEvents(controller, gameMode, telemetry, multiplayer) {
  if (window.SecureFPSGame.eventsAttached) return;
  window.SecureFPSGame.eventsAttached = true;

  const pauseOverlay = document.getElementById('pause-overlay');
  const resumeBtn = document.getElementById('resume-btn');
  const restartBtn = document.getElementById('restart-match-btn');
  const pauseLobbyBtn = document.getElementById('pause-lobby-btn');
  const pauseMainMenuBtn = document.getElementById('pause-main-menu-btn');
  const pauseExitDashboardBtn = document.getElementById('pause-exit-dashboard-btn');
  const scoreboardOverlay = document.getElementById('scoreboard-overlay');
  const canvas = document.getElementById('game-canvas');
  const loadingOverlay = document.getElementById('loading-overlay');

  const prompt = document.getElementById('pointer-lock-prompt');
  const dialogs = [...document.querySelectorAll('[aria-modal="true"], #death-overlay')];
  const isVisible = layer => layer.getClientRects().length && getComputedStyle(layer).visibility === 'visible';
  const isInMatch = () => loadingOverlay.classList.contains('hidden') && !window.SecureFPSGame.isMenuOpen;
  const canEngage = () => isInMatch() && !controller.isLocked && !window.SecureFPSGame.isPaused && !dialogs.some(isVisible);

  let pauseOpenedAt = 0;

  window.addEventListener('fps:pointerlock', (event) => {
    if (event.detail.locked) {
      pauseOverlay.classList.remove('active');
      window.SecureFPSGame.isPaused = false;
    } else if (isInMatch() && !dialogs.some(isVisible)) {
      pauseOverlay.classList.add('active');
      pauseOpenedAt = performance.now();
      if (gameMode.currentMode !== 'multiplayer') {
        window.SecureFPSGame.isPaused = true;
      }
      if (restartBtn) {
        restartBtn.style.display = gameMode.currentMode === 'multiplayer' ? 'none' : 'block';
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && isInMatch()) {
      if (pauseOverlay.classList.contains('active')) {
        // Prevent rapid close race condition: pointer lock release on ESC opens pause, do not immediately close within 350ms
        if (performance.now() - pauseOpenedAt > 350) {
          pauseOverlay.classList.remove('active');
          window.SecureFPSGame.isPaused = false;
          controller.requestLock();
        }
      } else if (!dialogs.some(isVisible)) {
        pauseOverlay.classList.add('active');
        pauseOpenedAt = performance.now();
        if (gameMode.currentMode !== 'multiplayer') {
          window.SecureFPSGame.isPaused = true;
        }
        if (restartBtn) {
          restartBtn.style.display = gameMode.currentMode === 'multiplayer' ? 'none' : 'block';
        }
        if (document.exitPointerLock) document.exitPointerLock();
      }
    }
  });

  const updateEngagePrompt = () => {
    prompt.style.display = canEngage() ? 'flex' : 'none';
  };
  const engageObserver = new MutationObserver(updateEngagePrompt);
  for (const layer of [...dialogs, loadingOverlay]) {
    engageObserver.observe(layer, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
  }
  window.addEventListener('fps:pointerlock', updateEngagePrompt);
  prompt.addEventListener('click', () => {
    if (canEngage()) controller.requestLock();
  });
  updateEngagePrompt();

  // Action 1: Resume Combat
  if (resumeBtn) {
    resumeBtn.addEventListener('click', () => {
      if (pauseOverlay) pauseOverlay.classList.remove('active');
      window.SecureFPSGame.isPaused = false;
      controller.resetKeys();
      controller.requestLock();
    });
  }

  // Action 2: Restart Match
  if (restartBtn) {
    restartBtn.addEventListener('click', async () => {
      if (gameMode.currentMode === 'multiplayer') return;
      if (pauseOverlay) pauseOverlay.classList.remove('active');
      window.SecureFPSGame.isPaused = false;
      await window.SecureFPSGame.deployLocalMatch?.(gameMode.currentMode, gameMode.difficulty);
    });
  }

  // Action 3: Open Multiplayer Lobby from Pause
  if (pauseLobbyBtn) {
    pauseLobbyBtn.addEventListener('click', () => {
      if (telemetry?.isSessionActive) void telemetry.endGameSession(false);
      controller.resetKeys();
      returnToMainMenu();
      const tabMp = document.getElementById('tab-multiplayer');
      if (tabMp) tabMp.click();
    });
  }

  // Voluntary Exit Modal Controls
  const voluntaryExitModal = document.getElementById('voluntary-exit-modal');
  const exitModalCurrentHonour = document.getElementById('exit-modal-current-honour');
  const exitModalAfterHonour = document.getElementById('exit-modal-after-honour');
  const btnCancelExitMatch = document.getElementById('btn-cancel-exit-match');
  const btnConfirmExitMatch = document.getElementById('btn-confirm-exit-match');
  let pendingExitAction = null;

  function promptVoluntaryExit(onConfirm) {
    pendingExitAction = onConfirm;
    const current = window.localPlayerHonour ?? 100;
    const penalty = 5;
    const after = Math.max(0, current - penalty);

    if (exitModalCurrentHonour) exitModalCurrentHonour.textContent = `${current}/100`;
    if (exitModalAfterHonour) exitModalAfterHonour.textContent = `${after}/100`;

    if (voluntaryExitModal) {
      voluntaryExitModal.style.display = 'flex';
    }
  }

  if (btnCancelExitMatch) {
    btnCancelExitMatch.addEventListener('click', () => {
      if (voluntaryExitModal) voluntaryExitModal.style.display = 'none';
      pendingExitAction = null;
    });
  }

  if (btnConfirmExitMatch) {
    btnConfirmExitMatch.addEventListener('click', async () => {
      btnConfirmExitMatch.disabled = true;
      btnConfirmExitMatch.textContent = 'ABANDONING...';
      try {
        if (telemetry) {
          await telemetry.voluntaryExitMatch();
        }
        if (typeof window.localPlayerHonour === 'number') {
          window.localPlayerHonour = Math.max(0, window.localPlayerHonour - 5);
        }
      } catch (err) {
        console.warn('Voluntary exit error:', err);
      }
      if (typeof pendingExitAction === 'function') {
        pendingExitAction();
      } else {
        safeExitToDashboard(telemetry);
      }
    });
  }

  // Action 4: Return to Main Menu (With Honour Confirmation during active match)
  if (pauseMainMenuBtn) {
    pauseMainMenuBtn.addEventListener('click', () => {
      if (pauseOverlay) pauseOverlay.classList.remove('active');
      const isMatchActive = gameMode && gameMode.matchActive && !gameMode.isMatchCompleted;
      if (isMatchActive && gameMode.currentMode !== 'multiplayer') {
        promptVoluntaryExit(() => returnToMainMenu());
      } else {
        returnToMainMenu();
      }
    });
  }

  // Action 5: Safe Exit to Player Dashboard (With Honour Confirmation during active match)
  if (pauseExitDashboardBtn) {
    pauseExitDashboardBtn.addEventListener('click', () => {
      if (pauseOverlay) pauseOverlay.classList.remove('active');
      const isMatchActive = gameMode && gameMode.matchActive && !gameMode.isMatchCompleted;
      if (isMatchActive && gameMode.currentMode !== 'multiplayer') {
        promptVoluntaryExit(() => safeExitToDashboard(telemetry));
      } else {
        safeExitToDashboard(telemetry);
      }
    });
  }

  // Safe HTML Escaping for Player & Bot Names
  function escapeHTML(str) {
    if (typeof str !== 'string') return String(str ?? '');
    return str.replace(/[&<>'"]/g, function(tag) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag;
    });
  }

  // Match Completion & Winner Screen Presentation
  let matchCompleteCountdownTimer = null;

  window.addEventListener('fps:game_completed', (e) => {
    const detail = e.detail || {};
    const mcOverlay = document.getElementById('match-complete-overlay');
    if (!mcOverlay) return;

    // Immediately unlock controls and exit pointer lock so cursor is available
    if (document.exitPointerLock) {
      document.exitPointerLock();
    }
    if (window.SecureFPSGame?.controller?.controls) {
      window.SecureFPSGame.controller.controls.unlock();
    }

    // Play Victory sound effect
    if (detail.isVictory && window.gameAudio?.playStreakSound) {
      window.gameAudio.playStreakSound(10);
    }

    const banner = document.getElementById('mc-banner');
    const winnerTitle = document.getElementById('mc-winner-title');
    const modeBadge = document.getElementById('mc-mode-badge');

    if (banner) {
      if (detail.isVictory) {
        banner.textContent = detail.kills >= 10 ? '🏆 VICTORY - 10 KILLS REACHED!' : '🏆 VICTORY!';
        banner.className = 'mc-header-banner victory';
      } else if (detail.isDraw) {
        banner.textContent = 'DRAW MATCH';
        banner.className = 'mc-header-banner draw';
      } else {
        banner.textContent = 'DEFEAT';
        banner.className = 'mc-header-banner defeat';
      }
    }

    if (winnerTitle) {
      const mvpBadge = detail.mvp ? `<div style="font-size: 13px; color: #fbbf24; margin-top: 6px; font-weight: 700;">🏆 MATCH MVP: ${escapeHTML(detail.mvp.name)} (${detail.mvp.score} PTS)</div>` : '';
      winnerTitle.innerHTML = `WINNER: ${escapeHTML(detail.winner || 'Operator')}${mvpBadge}`;
    }

    if (modeBadge) {
      modeBadge.textContent = `${(detail.mode || 'Combat').toUpperCase()} // COMPLETED`;
    }

    const setEl = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setEl('mc-kills', detail.kills ?? 0);
    setEl('mc-deaths', detail.deaths ?? 0);
    setEl('mc-kd', typeof detail.kdr === 'number' ? detail.kdr.toFixed(2) : detail.kdr);
    const totalShots = detail.shots ?? 0;
    const totalHits = detail.hits ?? 0;
    const calcAcc = totalShots > 0 ? ((totalHits / totalShots) * 100).toFixed(1) : ((detail.accuracy || 0) * 100).toFixed(1);
    setEl('mc-shots', totalShots);
    setEl('mc-hits', totalHits);
    setEl('mc-accuracy', `${calcAcc}% (${totalHits}/${totalShots})`);
    setEl('mc-headshots', detail.headshots ?? 0);

    const dur = detail.duration || 0;
    const durMins = Math.floor(dur / 60).toString().padStart(2, '0');
    const durSecs = (dur % 60).toString().padStart(2, '0');
    setEl('mc-duration', `${durMins}:${durSecs}`);
    setEl('mc-score', `${(detail.score || 0).toLocaleString()} PTS`);
    setEl('mc-honour-val', 'Pending match processing');

    mcOverlay.style.display = 'flex';

    // Start 6-second auto-redirect countdown to Main Menu
    if (matchCompleteCountdownTimer) clearInterval(matchCompleteCountdownTimer);
    let secondsLeft = 6;
    const countdownEl = document.getElementById('mc-countdown-seconds');
    const countdownDestination = document.getElementById('mc-countdown-destination');
    if (countdownDestination) countdownDestination.textContent = detail.mode === 'multiplayer' ? 'lobby' : 'main menu';
    if (countdownEl) countdownEl.textContent = secondsLeft;

    matchCompleteCountdownTimer = setInterval(() => {
      secondsLeft--;
      if (countdownEl) countdownEl.textContent = Math.max(0, secondsLeft);
      if (secondsLeft <= 0) {
        clearInterval(matchCompleteCountdownTimer);
        matchCompleteCountdownTimer = null;
        mcOverlay.style.display = 'none';
        returnToMainMenu({ keepRoom: detail.mode === 'multiplayer' });
      }
    }, 1000);
  });

  // Match Complete Actions
  const btnMatchRestart = document.getElementById('btn-match-restart');
  if (btnMatchRestart) {
    btnMatchRestart.addEventListener('click', () => {
      if (matchCompleteCountdownTimer) { clearInterval(matchCompleteCountdownTimer); matchCompleteCountdownTimer = null; }
      const mcOverlay = document.getElementById('match-complete-overlay');
      if (mcOverlay) mcOverlay.style.display = 'none';
      if (gameMode.currentMode === 'multiplayer') {
        returnToMainMenu({ keepRoom: true });
        return;
      }
      deployLocalMatch(gameMode.currentMode, gameMode.difficulty);
    });
  }

  const btnMatchMenu = document.getElementById('btn-match-menu');
  if (btnMatchMenu) {
    btnMatchMenu.addEventListener('click', () => {
      if (matchCompleteCountdownTimer) { clearInterval(matchCompleteCountdownTimer); matchCompleteCountdownTimer = null; }
      const mcOverlay = document.getElementById('match-complete-overlay');
      if (mcOverlay) mcOverlay.style.display = 'none';
      returnToMainMenu();
    });
  }

  const btnMatchDashboard = document.getElementById('btn-match-dashboard');
  if (btnMatchDashboard) {
    btnMatchDashboard.addEventListener('click', () => {
      if (matchCompleteCountdownTimer) { clearInterval(matchCompleteCountdownTimer); matchCompleteCountdownTimer = null; }
      safeExitToDashboard(telemetry);
    });
  }

  // Training Course Completion Event
  window.addEventListener('fps:training_completed', (e) => {
    const detail = e.detail || {};
    const tcOverlay = document.getElementById('training-complete-overlay');
    if (!tcOverlay) return;

    if (document.exitPointerLock) document.exitPointerLock();

    const rankTitle = document.getElementById('tc-rank-title');
    if (rankTitle) rankTitle.textContent = detail.rank || 'TACTICAL OPERATOR';

    const setEl = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setEl('tc-targets-hit', `${detail.targetsHit}/${detail.totalTargets}`);
    setEl('tc-targets-missed', detail.targetsMissed ?? 0);
    setEl('tc-accuracy', `${detail.accuracy}%`);
    setEl('tc-headshots', detail.headshots ?? 0);
    setEl('tc-reaction', `${detail.avgReaction}ms`);
    setEl('tc-duration', `${detail.duration}s`);
    setEl('tc-score', `${(detail.score || 0).toLocaleString()} PTS`);

    tcOverlay.style.display = 'flex';
  });

  // Training Complete Actions
  const btnTrainingRetry = document.getElementById('btn-training-retry');
  if (btnTrainingRetry) {
    btnTrainingRetry.addEventListener('click', () => {
      const tcOverlay = document.getElementById('training-complete-overlay');
      if (tcOverlay) tcOverlay.style.display = 'none';
      deployLocalMatch('training');
    });
  }

  const btnTrainingMenu = document.getElementById('btn-training-menu');
  if (btnTrainingMenu) {
    btnTrainingMenu.addEventListener('click', () => {
      const tcOverlay = document.getElementById('training-complete-overlay');
      if (tcOverlay) tcOverlay.style.display = 'none';
      returnToMainMenu();
    });
  }

  const btnTrainingDashboard = document.getElementById('btn-training-dashboard');
  if (btnTrainingDashboard) {
    btnTrainingDashboard.addEventListener('click', () => {
      safeExitToDashboard(telemetry);
    });
  }

  function returnToMainMenu({ keepRoom = false } = {}) {
    window.SecureFPSGame.returnToMainMenu = returnToMainMenu;
    const loadingOverlay = document.getElementById("loading-overlay");
    const pauseOverlay = document.getElementById("pause-overlay");
    const mcOverlay = document.getElementById("match-complete-overlay");
    const tcOverlay = document.getElementById("training-complete-overlay");
    const mainMenuHub = document.getElementById("main-menu-hub");
    const loaderProgress = document.getElementById("loader-progress-box");
    const gameHud = document.getElementById("game-hud");
    const trainingHud = document.getElementById("training-hud");
    const voluntaryExitModal = document.getElementById("voluntary-exit-modal");
    const btnConfirmExit = document.getElementById("btn-confirm-exit-match");

    if (document.exitPointerLock) {
      document.exitPointerLock();
    }
    if (window.SecureFPSGame?.controller?.unlock) {
      window.SecureFPSGame.controller.unlock();
    }

    if (pauseOverlay) pauseOverlay.classList.remove("active");
    if (mcOverlay) mcOverlay.style.display = "none";
    if (tcOverlay) tcOverlay.style.display = "none";
    if (voluntaryExitModal) voluntaryExitModal.style.display = "none";
    if (btnConfirmExit) {
      btnConfirmExit.disabled = false;
      btnConfirmExit.textContent = "ABANDON & EXIT";
    }
    if (gameHud) gameHud.style.display = "none";
    if (trainingHud) trainingHud.style.display = "none";

    window.SecureFPSGame.isMenuOpen = true;
    window.SecureFPSGame.isPaused = false;

    // Reset match state
    if (window.SecureFPSGame?.gameMode) {
      window.SecureFPSGame.gameMode.matchActive = false;
      window.SecureFPSGame.gameMode.isMatchCompleted = false;
    }

    // Leave room if in multiplayer match
    if (!keepRoom && window.SecureFPSGame?.multiplayer?.isInRoom) {
      window.SecureFPSGame.multiplayer.leaveRoom();
    }
    if (keepRoom) document.getElementById('tab-multiplayer')?.click();

    // Reset weapons state (ADS / scopes)
    if (window.SecureFPSGame?.weapons) {
      window.SecureFPSGame.weapons.isAiming = false;
      if (window.SecureFPSGame.weapons.sniperScopeOverlay) {
        window.SecureFPSGame.weapons.sniperScopeOverlay.style.display = "none";
      }
    }

    if (loadingOverlay) loadingOverlay.classList.remove("hidden");
    if (mainMenuHub) mainMenuHub.style.display = "block";
    if (loaderProgress) loaderProgress.style.display = "none";

    // Stop bots and training targets
    const botMgr = window.SecureFPSGame.botManager;
    if (botMgr) botMgr.stopAllBots();
    const trainingMgr = window.SecureFPSGame.trainingManager;
    if (trainingMgr) trainingMgr.stopSimulation();

    const menuOp = window.SecureFPSGame.menuOperator;
    if (menuOp && menuOp.root) {
      const sc = window.SecureFPSGame.scene;
      if (sc && !sc.children.includes(menuOp.root)) {
        sc.add(menuOp.root);
      }
      menuOp.root.position.set(0, 0, 24);
      menuOp.root.visible = true;
    }

    const camera = window.SecureFPSGame.camera;
    if (camera) {
      camera.position.set(0, 1.7, 26.8);
      camera.lookAt(0, 1.4, 24);
    }
  }

  // Scoreboard [TAB] key handler
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab' && controller.isLocked && !window.SecureFPSGame.isPaused && !gameMode.isMatchCompleted) {
      e.preventDefault();
      if (scoreboardOverlay && !window.SecureFPSGame.isMenuOpen) {
        updateScoreboardTable(gameMode, multiplayer);
        scoreboardOverlay.classList.add('active');
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Tab') {
      if (scoreboardOverlay) {
        scoreboardOverlay.classList.remove('active');
      }
    }
  });

  // Canvas click to lock if paused and clicked
  if (canvas) {
    canvas.addEventListener('click', () => {
      if (canEngage()) {
        controller.requestLock();
      }
    });
  }

  // Viewport resize handler
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('orientationchange', onWindowResize);
}

function initGameDialogFocus() {
  const targets = {
    'pause-overlay': 'resume-btn',
    'match-complete-overlay': 'btn-match-menu',
    'training-complete-overlay': 'btn-training-menu',
    'voluntary-exit-modal': 'btn-cancel-exit-match'
  };
  const layers = Object.keys(targets).map(id => document.getElementById(id)).filter(Boolean);
  const focusStack = new Map();
  let active;
  const visible = element => Boolean(element?.getClientRects().length);
  const dismiss = layer => document.getElementById(targets[layer.id]);
  const observer = new MutationObserver(() => {
    const next = [...layers].reverse().find(visible);
    if (next === active) return;
    const previousFocus = active && focusStack.get(active);
    if (active && !visible(active)) focusStack.delete(active);
    active = next;
    if (next) {
      if (!focusStack.has(next)) focusStack.set(next, document.activeElement);
      dismiss(next)?.focus({ preventScroll: true });
    } else if (visible(previousFocus)) {
      previousFocus.focus({ preventScroll: true });
    }
  });
  for (const layer of layers) observer.observe(layer, { attributes: true, attributeFilter: ['class', 'style'] });

  document.addEventListener('keydown', event => {
    if (!active || !visible(active)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss(active)?.click();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...active.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)')].filter(visible);
    if (!controls.length) return;
    const index = controls.indexOf(document.activeElement);
    if (index === -1 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0]).focus();
    }
  }, true);
}

function updateScoreboardTable(gameMode, multiplayer) {
  const tbody = document.getElementById('scoreboard-tbody');
  const modeLabel = document.getElementById('scoreboard-mode-label');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (modeLabel && gameMode) {
    modeLabel.textContent = (gameMode.currentMode || 'FREE-FOR-ALL').toUpperCase();
  }

  function formatKD(kills, deaths) {
    const totalKills = Number(kills) || 0;
    const totalDeaths = Number(deaths) || 0;
    return (totalKills / Math.max(totalDeaths, 1)).toFixed(2);
  }

  const rows = [];

  // Local Player Row
  const localName = sessionStorage.getItem('securefps_player_name') || 'Operator (You)';
  const kills = gameMode?.kills || 0;
  const deaths = gameMode?.deaths || 0;
  const kd = formatKD(kills, deaths);
  const score = kills * 100 + (gameMode?.headshots || 0) * 25;

  const isMP = gameMode?.currentMode === 'multiplayer';
  const localPing = isMP ? (multiplayer?.currentPing ? `${Math.round(multiplayer.currentPing)} ms` : '--') : 'LOCAL (0ms)';

  rows.push({
    name: localName,
    isLocal: true,
    status: (gameMode?.playerHealth ?? 100) > 0 ? 'ACTIVE' : 'RESPAWNING',
    kills: kills,
    deaths: deaths,
    kd: kd,
    score: score,
    ping: localPing
  });

  // If Bot Mode: Add Active Bots (Task 3c: real bot metrics)
  if (gameMode?.currentMode === 'bots') {
    const botManager = window.SecureFPSGame.botManager;
    if (botManager && botManager.bots) {
      botManager.bots.forEach(b => {
        if (!b.isActive) return;
        const botDead = b.isDead;
        const bKills = gameMode.botScores[b.name]?.kills ?? 0;
        const bDeaths = gameMode.botScores[b.name]?.deaths ?? 0;
        const bKd = formatKD(bKills, bDeaths);
        const bScore = bKills * 100 + (botDead ? 0 : 50);
        rows.push({
          name: b.name,
          isLocal: false,
          status: botDead ? 'ELIMINATED' : (b.state || 'PATROL'),
          kills: bKills,
          deaths: bDeaths,
          kd: bKd,
          score: bScore,
          ping: 'BOT'
        });
      });
    }
  }

  // If Multiplayer Mode: Add Remote Players (Task 3c: real multiplayer telemetry)
  if (isMP && multiplayer && multiplayer.remotePlayers) {
    multiplayer.remotePlayers.forEach(p => {
      const pKills = p.kills || 0;
      const pDeaths = p.deaths || 0;
      const pKd = formatKD(pKills, pDeaths);
      const pScore = p.score || (pKills * 100);
      const pPing = p.ping !== undefined ? `${Math.round(p.ping)} ms` : (multiplayer.currentPing ? `${Math.round(multiplayer.currentPing)} ms` : '--');
      rows.push({
        name: p.name || 'Remote Operator',
        isLocal: false,
        status: p.health > 0 ? 'ACTIVE' : 'RESPAWNING',
        kills: pKills,
        deaths: pDeaths,
        kd: pKd,
        score: pScore,
        ping: pPing
      });
    });
  }

  // Sort rows by score descending
  rows.sort((a, b) => b.score - a.score);

  rows.forEach(r => {
    const tr = document.createElement('tr');
    if (r.isLocal) tr.className = 'local-player';
    tr.innerHTML = `
      <td>${r.isLocal ? '⭐ ' : ''}${r.name}</td>
      <td><span style="color:${r.status === 'ACTIVE' ? '#10b981' : '#fbbf24'};">${r.status}</span></td>
      <td>${r.kills}</td>
      <td>${r.deaths}</td>
      <td>${r.kd}</td>
      <td><strong>${r.score}</strong></td>
      <td>${r.ping}</td>
    `;
    tbody.appendChild(tr);
  });
}

/**
 * Safe Exit to Player Dashboard (Preserves authentication, stops loops/audio)
 */
async function safeExitToDashboard(telemetry) {
  const getDashboardUrl = () => {
    return window.location.pathname.includes("/frontend/")
      ? `${window.location.origin}/frontend/player.html`
      : `${window.location.origin}/player.html`;
  };

  try {
    if (window.SecureFPSGame?.animationFrameId) {
      cancelAnimationFrame(window.SecureFPSGame.animationFrameId);
      window.SecureFPSGame.animationFrameId = null;
    }
    if (window.SecureFPSGame?.multiplayer) {
      window.SecureFPSGame.multiplayer.leaveRoom();
      window.SecureFPSGame.multiplayer.disconnect();
    }
    if (window.gameAudio && window.gameAudio.ctx) {
      window.gameAudio.ctx.suspend().catch(() => {});
    }
    if (telemetry) {
      await telemetry.endGameSession();
    }
    if (document.exitPointerLock) {
      document.exitPointerLock();
    }
    if (window.SecureFPSGame?.controller?.unlock) {
      window.SecureFPSGame.controller.unlock();
    }
    window.location.href = getDashboardUrl();
  } catch (e) {
    window.location.href = getDashboardUrl();
  }
}

function onWindowResize() {
  const camera = window.SecureFPSGame.camera;
  const renderer = window.SecureFPSGame.renderer;
  if (!camera || !renderer) return;

  const width = window.innerWidth;
  const height = window.innerHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

/**
 * Main 60+ FPS Render & Animation Loop
 */
function renderLoop() {
  window.SecureFPSGame.animationFrameId = requestAnimationFrame(renderLoop);

  const {
    clock,
    controller,
    hud,
    weapons,
    botManager,
    gameMode,
    telemetry,
    multiplayer,
    menuOperator,
    renderer,
    scene,
    camera,
    isInitialized,
    isMenuOpen
  } = window.SecureFPSGame;

  if (!isInitialized) return;

  const delta = Math.min(clock.getDelta(), 0.1);
  const now = performance.now() / 1000;

  // 1. Menu Presentation Animation (Rotating 3D Operator Preview)
  if (isMenuOpen && menuOperator && gameMode?.currentMode !== 'multiplayer') {
    menuOperator.root.rotation.y += delta * 0.45;
    menuOperator.updateAnimation(delta, 0, true, camera);
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
    return;
  }

  const modePaused = Boolean(
    gameMode && (
      (gameMode.currentMode !== 'multiplayer' && window.SecureFPSGame.isPaused) ||
      (gameMode.currentMode === 'multiplayer' && isMenuOpen)
    )
  );

  // 2. Update First-Person Kinematics & Collisions
  if (controller && !modePaused) {
    try {
      controller.update(delta);
    } catch (e) {
      console.warn('[RenderLoop] Controller error:', e);
    }
  }

  // 3. Update Weapons, Recoil, Tracers & Firing
  if (weapons && !modePaused) {
    try {
      weapons.update(delta, controller, botManager);
    } catch (e) {
      console.warn('[RenderLoop] WeaponManager error:', e);
    }
  }

  // 4. Update Enemy AI Bots (only active in combat modes and while match is underway)
  if (!modePaused && botManager && controller && !botManager.isStopped) {
    if (gameMode && !gameMode.isMatchCompleted && gameMode.currentMode === 'bots') {
      try {
        botManager.update(
          delta,
          controller.position,
          controller,
          camera,
          gameMode,
          (damage, botName, botPos) => {
            if (window.isDemoGodModeActive || window.SecureFPSGame?.isCheaterDemoActive || gameMode?.demoGodMode) {
              if (gameMode) {
                gameMode.playerHealth = 100;
                gameMode.playerArmour = 100;
                gameMode.isDead = false;
                gameMode.updateHUD();
              }
              return;
            }
            gameMode.damagePlayer(damage, botName, controller, botPos);
          }
        );
      } catch (e) {
        console.warn('[RenderLoop] BotManager error:', e);
      }
    }
  }

  // 5. Update Training Targets & Kinematics Challenge (only active in training mode)
  const trainingManager = window.SecureFPSGame.trainingManager;
  if (!modePaused && trainingManager && gameMode && gameMode.currentMode === 'training') {
    try {
      trainingManager.update(delta);
    } catch (e) {
      console.warn('[RenderLoop] TrainingManager error:', e);
    }
  }

  // 6. Update Game Mode Progression & Spawn Protection Timers
  if (!modePaused && gameMode && controller) {
    try {
      gameMode.update(delta, controller);
    } catch (e) {
      console.warn('[RenderLoop] GameMode error:', e);
    }
  }

  // 7. Update Real-time Telemetry Client
  if (!modePaused && telemetry && controller) {
    try {
      telemetry.update(now, controller);
    } catch (e) {
      console.warn('[RenderLoop] Telemetry error:', e);
    }
  }

  // 8. Update Real-time Multiplayer Networking
  if (multiplayer && controller) {
    try {
      multiplayer.update(delta, now, controller);
    } catch (e) {
      console.warn('[RenderLoop] Multiplayer error:', e);
    }
  }

  // 9. Update Heads-Up Display Metrics & Dynamic Crosshair Enemy Lock
  if (hud) {
    try {
      hud.update(delta);
      if (!isMenuOpen && camera && scene) {
        hud.checkEnemyUnderCrosshair(camera, scene);
      }

      if (gameMode) {
        const curMode = gameMode.currentMode || 'bots';
        let modeTag = 'VS TACTICAL BOTS';
        let playerCountText = 'ENEMIES: 4';
        let targetKills = 10;
        let timeText = '00:00';
        let pingText = 'LOCAL (0ms)';

        if (curMode === 'solo') {
          modeTag = 'FREE ROAM';
          playerCountText = 'ALIVE 1 / 1 (SOLO)';
          targetKills = null;
          const elapsed = Math.floor(gameMode.matchDuration - (gameMode.timeRemaining || 0));
          const mins = Math.floor(Math.max(0, elapsed) / 60).toString().padStart(2, '0');
          const secs = (Math.max(0, elapsed) % 60).toString().padStart(2, '0');
          timeText = `${mins}:${secs}`;
          pingText = 'LOCAL (0ms)';
        } else if (curMode === 'bots') {
          const diffStr = (gameMode.difficulty || 'normal').toUpperCase();
          modeTag = `BOTS • ${diffStr}`;
          const botMgr = window.SecureFPSGame?.botManager;
          const activeBots = botMgr?.bots ? botMgr.bots.filter(b => b.isActive) : [];
          const aliveBots = activeBots.filter(b => !b.isDead).length;
          const totalBots = activeBots.length;
          const isPlayerAlive = (gameMode.playerHealth || 100) > 0 ? 1 : 0;
          const totalAlive = aliveBots + isPlayerAlive;
          const totalPlayers = totalBots + 1;
          playerCountText = `ALIVE ${totalAlive} / ${totalPlayers} PLAYERS`;
          targetKills = 10;
          const rem = Math.max(0, Math.floor(gameMode.timeRemaining || 0));
          const mins = Math.floor(rem / 60).toString().padStart(2, '0');
          const secs = (rem % 60).toString().padStart(2, '0');
          timeText = `${mins}:${secs}`;
          pingText = 'LOCAL (0ms)';
        } else if (curMode === 'multiplayer') {
          modeTag = 'MULTIPLAYER ARENA';
          const remotes = multiplayer?.remotePlayers || new Map();
          let aliveCount = ((gameMode.playerHealth || 100) > 0 ? 1 : 0);
          remotes.forEach(p => { if (p.health > 0) aliveCount++; });
          const totalCount = remotes.size + 1;
          playerCountText = `ALIVE ${aliveCount} / ${totalCount} PLAYERS`;
          targetKills = gameMode.targetKills || 10;
          const rem = Math.max(0, Math.floor(gameMode.timeRemaining || 0));
          const mins = Math.floor(rem / 60).toString().padStart(2, '0');
          const secs = (rem % 60).toString().padStart(2, '0');
          timeText = `${mins}:${secs}`;
          const rtt = Math.round(multiplayer?.currentPing || 0);
          pingText = rtt > 0 ? `${rtt} ms` : 'LOCAL (0ms)';
        } else if (curMode === 'training') {
          modeTag = 'TRAINING COURSE';
          const trMgr = window.SecureFPSGame?.trainingManager;
          playerCountText = `TARGETS ${trMgr?.targetsHit || 0} / 20`;
          targetKills = null;
          timeText = 'PRACTICE';
          pingText = 'LOCAL (0ms)';
        }

        hud.updateMatchHeader({
          mode: modeTag,
          playerCountText: playerCountText,
          kills: gameMode.kills || 0,
          targetKills: targetKills,
          timeText: timeText,
          pingText: pingText
        });
      }
    } catch (e) {
      console.warn('[RenderLoop] HUD error:', e);
    }
  }

  // 10. Render 3D Scene
  if (renderer && scene && camera) {
    try {
      renderer.render(scene, camera);
    } catch (e) {
      console.error('[RenderLoop] Three.js render fatal error:', e);
    }
  }
}

function showMatchCountdown() {
  const overlay = document.getElementById('match-countdown-overlay');
  const numEl = document.getElementById('match-countdown-num');
  const subEl = document.getElementById('match-countdown-sub');
  if (!overlay || !numEl) return;

  overlay.style.display = 'flex';
  let count = 3;
  numEl.textContent = count;
  numEl.style.color = '#00f0ff';
  if (subEl) subEl.textContent = 'DEPLOYING OPERATORS...';

  const timer = setInterval(() => {
    count--;
    if (count > 0) {
      numEl.textContent = count;
    } else if (count === 0) {
      numEl.textContent = 'ENGAGE';
      numEl.style.color = '#10b981';
      if (subEl) subEl.textContent = 'MISSION UNDERWAY';
    } else {
      clearInterval(timer);
      overlay.style.display = 'none';
    }
  }, 750);
}

/**
 * Initializes the F3 Developer Live Weapon Calibration Sliders
 */
function initWeaponCalibrationSliders() {
  const controls = [
    { slider: 'slider-wep-pos-x', label: 'val-wep-pos-x', prop: 'posX' },
    { slider: 'slider-wep-pos-y', label: 'val-wep-pos-y', prop: 'posY' },
    { slider: 'slider-wep-pos-z', label: 'val-wep-pos-z', prop: 'posZ' },
    { slider: 'slider-wep-rot-x', label: 'val-wep-rot-x', prop: 'rotX' },
    { slider: 'slider-wep-rot-y', label: 'val-wep-rot-y', prop: 'rotY' },
    { slider: 'slider-wep-rot-z', label: 'val-wep-rot-z', prop: 'rotZ' }
  ];

  controls.forEach(({ slider, label, prop }) => {
    const inputEl = document.getElementById(slider);
    const labelEl = document.getElementById(label);
    if (inputEl) {
      inputEl.addEventListener('input', () => {
        const val = parseFloat(inputEl.value);
        if (labelEl) labelEl.textContent = val.toFixed(3);
        const update = {};
        update[prop] = val;
        if (window.TacticalOperator && typeof window.TacticalOperator.applyWeaponCalibration === 'function') {
          window.TacticalOperator.applyWeaponCalibration(update);
        }
      });
    }
  });

  const copyBtn = document.getElementById('dev-copy-weapon-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (window.TacticalOperator && window.TacticalOperator.currentWeaponCalibration) {
        const cal = window.TacticalOperator.currentWeaponCalibration;
        const formatted = `TacticalOperator.currentWeaponCalibration = ${JSON.stringify(cal, null, 2)};`;
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(formatted).then(() => {
            copyBtn.textContent = 'COPIED TO CLIPBOARD!';
            setTimeout(() => { copyBtn.textContent = 'Copy Calibrated Values'; }, 2000);
          }).catch(() => {
            console.log('[DevWeaponCalibration]', formatted);
            copyBtn.textContent = 'LOGGED TO CONSOLE';
            setTimeout(() => { copyBtn.textContent = 'Copy Calibrated Values'; }, 2000);
          });
        } else {
          console.log('[DevWeaponCalibration]', formatted);
          copyBtn.textContent = 'LOGGED TO CONSOLE';
          setTimeout(() => { copyBtn.textContent = 'Copy Calibrated Values'; }, 2000);
        }
      }
    });
  }
}
