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

    // Kick off 60+ FPS render loop
    requestAnimationFrame(renderLoop);

  } catch (error) {
    console.error('[SecureFPS] Game initialization failed:', error);
    if (statusEl) {
      statusEl.textContent = `INITIALIZATION FAILED: ${error.message}`;
      statusEl.style.color = '#ff0055';
    }
  }
}

/**
 * Initializes Menu Tabs, Mode Launchers, and Settings System
 */
function initTacticalMenu(controller, gameMode, botManager, telemetry, multiplayer, camera) {
  const loadingOverlay = document.getElementById('loading-overlay');

  // Load Saved Preferences from localStorage
  loadSavedSettings(controller, camera);

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
      // Solo Deathmatch: exactly 25 eliminations
      if (trainingMgr) trainingMgr.stopSimulation();
      botManager.setEnabled(true);
      if (typeof botManager.resetAllBots === 'function') {
        botManager.resetAllBots(new THREE.Vector3(0, 1.8, 28));
      } else {
        botManager.resumeAllBots();
      }
      botManager.setDifficulty('normal');
      gameMode.targetKills = 25;
    } else if (mode === 'bots') {
      // Bot Combat: 12:00 timer, chosen difficulty
      if (trainingMgr) trainingMgr.stopSimulation();
      botManager.setEnabled(true);
      if (typeof botManager.resetAllBots === 'function') {
        botManager.resetAllBots(new THREE.Vector3(0, 1.8, 28));
      } else {
        botManager.resumeAllBots();
      }
      botManager.setDifficulty(difficulty);
      gameMode.targetKills = 25;
    } else if (mode === 'multiplayer') {
      if (trainingMgr) trainingMgr.stopSimulation();
      botManager.setEnabled(false);
      botManager.stopAllBots();
    }

    controller.respawn(new THREE.Vector3(0, 1.8, 28));
    controller.resetKeys();
    controller.requestLock();

    gameMode.startMatch();
    if (mode !== 'training') {
      await telemetry.startSession();
    }
    onWindowResize();
  }

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
      multiplayer.connect();
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

  const savedName = sessionStorage.getItem('securefps_player_name');
  if (savedName) {
    if (playerNameInput) playerNameInput.value = savedName;
    const hudOpName = document.getElementById('hud-operator-name');
    if (hudOpName) hudOpName.textContent = savedName.toUpperCase();
  }

  // Automatically sync session-authenticated profile username & Honour Score
  window.localPlayerHonour = 100;
  async function syncAuthenticatedProfile() {
    try {
      const res = await fetch('/api/player/profile', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.name) {
          sessionStorage.setItem('securefps_player_name', data.name);
          if (playerNameInput) playerNameInput.value = data.name;
          const hudOpName = document.getElementById('hud-operator-name');
          if (hudOpName) hudOpName.textContent = data.name.toUpperCase();
        }
        if (data && typeof data.honour_score === 'number') {
          window.localPlayerHonour = data.honour_score;
        }
      }
      // Also fetch live honour endpoint
      const hRes = await fetch('/api/game/honour', { credentials: 'include' });
      if (hRes.ok) {
        const hData = await hRes.json();
        if (typeof hData.honour_score === 'number') {
          window.localPlayerHonour = hData.honour_score;
        }
      }
    } catch (_) {}
  }
  syncAuthenticatedProfile();

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
    if (serverStatusText) serverStatusText.textContent = 'OFFLINE (:4001)';
    if (serverStatusPill) serverStatusPill.style.color = '#fbbf24';
  });

  if (btnCreateRoom) {
    btnCreateRoom.addEventListener('click', () => {
      multiplayer.createRoom(getPlayerName(), window.localPlayerHonour || 100);
    });
  }

  if (btnJoinRoom) {
    btnJoinRoom.addEventListener('click', () => {
      const code = (roomCodeInput?.value || '').trim().toUpperCase();
      if (!code || code.length !== 6) {
        showError('Please enter a valid 6-character room code.');
        return;
      }
      multiplayer.joinRoom(code, getPlayerName(), window.localPlayerHonour || 100);
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
    gameMode.setMode('multiplayer');
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

    gameMode.startMatch();
    await telemetry.startSession();
    onWindowResize();

    // Show synchronized 3-second deployment countdown
    showMatchCountdown();
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
  if (masterVolInput && masterVolVal) {
    masterVolInput.addEventListener('input', () => {
      masterVolVal.textContent = `${masterVolInput.value}%`;
      window.gameAudio.setMasterVolume(parseFloat(masterVolInput.value) / 100);
    });
  }

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

  // Music Volume
  const musicVolInput = document.getElementById('setting-music-volume');
  const musicVolVal = document.getElementById('setting-music-val');
  if (musicVolInput && musicVolVal) {
    musicVolInput.addEventListener('input', () => {
      musicVolVal.textContent = `${musicVolInput.value}%`;
      if (typeof window.gameAudio.setMusicVolume === 'function') {
        window.gameAudio.setMusicVolume(parseFloat(musicVolInput.value) / 100);
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

  // Show FPS Toggle
  const showFpsCheck = document.getElementById('setting-show-fps');
  if (showFpsCheck) {
    showFpsCheck.addEventListener('change', () => {
      const fpsEl = document.getElementById('hud-fps');
      if (fpsEl) fpsEl.style.display = showFpsCheck.checked ? 'block' : 'none';
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

  // Multiplayer Server URL
  const serverUrlInput = document.getElementById('setting-server-url');
  if (serverUrlInput) {
    serverUrlInput.value = localStorage.getItem('securefps_server_url') || '';
  }

  // Save Settings Button
  const btnSaveSettings = document.getElementById('btn-save-settings');
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', () => {
      const settings = {
        sensitivity: sensInput ? sensInput.value : '4',
        aimSensitivity: aimSensInput ? (parseFloat(aimSensInput.value) / 10).toString() : '0.7',
        masterVolume: masterVolInput ? masterVolInput.value : '90',
        sfxVolume: volumeInput ? volumeInput.value : '85',
        musicVolume: musicVolInput ? musicVolInput.value : '70',
        crosshairSize: crosshairSizeSelect ? crosshairSizeSelect.value : 'normal',
        crosshairColor: crosshairColorSelect ? crosshairColorSelect.value : 'cyan',
        crosshairVisible: crosshairVisibleCheck ? crosshairVisibleCheck.checked : true,
        showFps: showFpsCheck ? showFpsCheck.checked : true,
        fov: fovInput ? fovInput.value : '75',
        invertY: invertYCheck ? invertYCheck.checked : false,
        graphics: graphicsSelect ? graphicsSelect.value : 'medium',
        serverUrl: serverUrlInput ? serverUrlInput.value.trim() : ''
      };
      localStorage.setItem('securefps_settings', JSON.stringify(settings));
      if (settings.serverUrl) {
        localStorage.setItem('securefps_server_url', settings.serverUrl);
      }
      switchTab('bots');
    });
  }
}

function loadSavedSettings(controller, camera) {
  try {
    const raw = localStorage.getItem('securefps_settings');
    if (!raw) return;
    const s = JSON.parse(raw);

    if (s.sensitivity) {
      const sens = parseFloat(s.sensitivity);
      controller.mouseSensitivity = sens * 0.00055;
      const el = document.getElementById('setting-sens');
      const valEl = document.getElementById('setting-sens-val');
      if (el) el.value = s.sensitivity;
      if (valEl) valEl.textContent = sens.toFixed(1);
    }
    if (s.aimSensitivity && controller) {
      const mult = parseFloat(s.aimSensitivity);
      controller.aimSensitivityMultiplier = mult;
      const el = document.getElementById('setting-aim-sens');
      const valEl = document.getElementById('setting-aim-sens-val');
      if (el) el.value = Math.round(mult * 10);
      if (valEl) valEl.textContent = `${mult.toFixed(1)}x`;
    }
    if (s.masterVolume !== undefined) {
      const mVol = parseFloat(s.masterVolume);
      window.gameAudio.setMasterVolume(mVol / 100);
      const el = document.getElementById('setting-master-volume');
      const valEl = document.getElementById('setting-master-val');
      if (el) el.value = s.masterVolume;
      if (valEl) valEl.textContent = `${mVol}%`;
    }
    if (s.sfxVolume !== undefined) {
      const sVol = parseFloat(s.sfxVolume);
      if (typeof window.gameAudio.setSFXVolume === 'function') {
        window.gameAudio.setSFXVolume(sVol / 100);
      }
      const el = document.getElementById('setting-volume');
      const valEl = document.getElementById('setting-volume-val');
      if (el) el.value = s.sfxVolume;
      if (valEl) valEl.textContent = `${sVol}%`;
    }
    if (s.musicVolume !== undefined) {
      const muVol = parseFloat(s.musicVolume);
      if (typeof window.gameAudio.setMusicVolume === 'function') {
        window.gameAudio.setMusicVolume(muVol / 100);
      }
      const el = document.getElementById('setting-music-volume');
      const valEl = document.getElementById('setting-music-val');
      if (el) el.value = s.musicVolume;
      if (valEl) valEl.textContent = `${muVol}%`;
    }
    if (s.crosshairSize && window.SecureFPSGame?.hud) {
      window.SecureFPSGame.hud.setCrosshairSize(s.crosshairSize);
      const el = document.getElementById('setting-crosshair-size');
      if (el) el.value = s.crosshairSize;
    }
    if (s.crosshairColor && window.SecureFPSGame?.hud) {
      window.SecureFPSGame.hud.setCrosshairColor(s.crosshairColor);
      const el = document.getElementById('setting-crosshair-color');
      if (el) el.value = s.crosshairColor;
    }
    if (s.crosshairVisible !== undefined && window.SecureFPSGame?.hud) {
      window.SecureFPSGame.hud.setCrosshairVisible(!!s.crosshairVisible);
      const el = document.getElementById('setting-crosshair-visible');
      if (el) el.checked = !!s.crosshairVisible;
    }
    if (s.showFps !== undefined) {
      const fpsEl = document.getElementById('hud-fps');
      if (fpsEl) fpsEl.style.display = s.showFps ? 'block' : 'none';
      const el = document.getElementById('setting-show-fps');
      if (el) el.checked = !!s.showFps;
    }
    if (s.fov && camera) {
      const fov = parseInt(s.fov, 10);
      camera.fov = fov;
      camera.updateProjectionMatrix();
      const el = document.getElementById('setting-fov');
      const valEl = document.getElementById('setting-fov-val');
      if (el) el.value = s.fov;
      if (valEl) valEl.textContent = `${fov}°`;
    }
    if (s.invertY !== undefined) {
      controller.invertY = !!s.invertY;
      const el = document.getElementById('setting-invert-y');
      if (el) el.checked = !!s.invertY;
    }
  } catch (e) {
    console.warn('[SecureFPS Settings] Load error:', e);
  }
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

  // Handle Pointer Lock State Changes
  window.addEventListener('fps:pointerlock', (e) => {
    const isLocked = e.detail.locked;
    const prompt = document.getElementById('pointer-lock-prompt');
    if (prompt) {
      prompt.style.display = (!isLocked && !window.SecureFPSGame.isMenuOpen) ? 'flex' : 'none';
    }

    if (isLocked) {
      if (pauseOverlay) pauseOverlay.classList.remove('active');
      window.SecureFPSGame.isPaused = false;
    } else {
      // NEVER show blocking pause menu in multiplayer mode!
      if (gameMode?.currentMode === 'multiplayer') {
        return;
      }
      if (loadingOverlay && loadingOverlay.classList.contains('hidden') && !window.SecureFPSGame.isMenuOpen) {
        if (pauseOverlay) pauseOverlay.classList.add('active');
        window.SecureFPSGame.isPaused = true;
      }
    }
  });

  // Prompt click handler
  const promptEl = document.getElementById('pointer-lock-prompt');
  if (promptEl) {
    promptEl.addEventListener('click', () => {
      controller.requestLock();
    });
  }

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
    restartBtn.addEventListener('click', () => {
      if (pauseOverlay) pauseOverlay.classList.remove('active');
      window.SecureFPSGame.isPaused = false;
      gameMode.resetMatch();
      controller.respawn(new THREE.Vector3(0, 1.8, 28));
      controller.resetKeys();
      controller.requestLock();
    });
  }

  // Action 3: Open Multiplayer Lobby from Pause
  if (pauseLobbyBtn) {
    pauseLobbyBtn.addEventListener('click', () => {
      if (pauseOverlay) pauseOverlay.classList.remove('active');
      window.SecureFPSGame.isMenuOpen = true;
      if (loadingOverlay) loadingOverlay.classList.remove('hidden');
      const menuOp = window.SecureFPSGame.menuOperator;
      if (menuOp && menuOp.root) menuOp.root.visible = true;
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
      const isMatchActive = gameMode && gameMode.isMatchActive && !gameMode.isMatchEnded;
      if (isMatchActive) {
        promptVoluntaryExit(() => returnToMainMenu());
      } else {
        returnToMainMenu();
      }
    });
  }

  // Action 5: Safe Exit to Player Dashboard (With Honour Confirmation during active match)
  if (pauseExitDashboardBtn) {
    pauseExitDashboardBtn.addEventListener('click', () => {
      const isMatchActive = gameMode && gameMode.isMatchActive && !gameMode.isMatchEnded;
      if (isMatchActive) {
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
        banner.textContent = detail.kills >= 25 ? '🏆 VICTORY - 25 KILLS REACHED!' : '🏆 VICTORY!';
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
    setEl('mc-accuracy', `${Math.round((detail.accuracy || 0) * 100)}%`);
    setEl('mc-headshots', detail.headshots ?? 0);

    const dur = detail.duration || 0;
    const durMins = Math.floor(dur / 60).toString().padStart(2, '0');
    const durSecs = (dur % 60).toString().padStart(2, '0');
    setEl('mc-duration', `${durMins}:${durSecs}`);
    setEl('mc-score', `${(detail.score || 0).toLocaleString()} PTS`);
    const curHonour = window.localPlayerHonour ?? 100;
    const nextHonour = Math.min(100, curHonour + 5);
    window.localPlayerHonour = nextHonour;
    setEl('mc-honour-val', `${nextHonour}/100 (+5 MATCH COMPLETED)`);

    mcOverlay.style.display = 'flex';

    // Start 6-second auto-redirect countdown to Main Menu
    if (matchCompleteCountdownTimer) clearInterval(matchCompleteCountdownTimer);
    let secondsLeft = 6;
    const countdownEl = document.getElementById('mc-countdown-seconds');
    if (countdownEl) countdownEl.textContent = secondsLeft;

    matchCompleteCountdownTimer = setInterval(() => {
      secondsLeft--;
      if (countdownEl) countdownEl.textContent = Math.max(0, secondsLeft);
      if (secondsLeft <= 0) {
        clearInterval(matchCompleteCountdownTimer);
        matchCompleteCountdownTimer = null;
        mcOverlay.style.display = 'none';
        returnToMainMenu();
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

  function returnToMainMenu() {
    const loadingOverlay = document.getElementById('loading-overlay');
    const pauseOverlay = document.getElementById('pause-overlay');
    const mcOverlay = document.getElementById('match-complete-overlay');
    const tcOverlay = document.getElementById('training-complete-overlay');
    const mainMenuHub = document.getElementById('main-menu-hub');
    const loaderProgress = document.getElementById('loader-progress-box');
    const gameHud = document.getElementById('game-hud');
    const trainingHud = document.getElementById('training-hud');

    if (document.exitPointerLock) {
      document.exitPointerLock();
    }
    if (window.SecureFPSGame?.controller?.controls) {
      window.SecureFPSGame.controller.controls.unlock();
    }

    if (pauseOverlay) pauseOverlay.classList.remove('active');
    if (mcOverlay) mcOverlay.style.display = 'none';
    if (tcOverlay) tcOverlay.style.display = 'none';
    if (gameHud) gameHud.style.display = 'none';
    if (trainingHud) trainingHud.style.display = 'none';

    window.SecureFPSGame.isMenuOpen = true;
    window.SecureFPSGame.isPaused = false;

    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    if (mainMenuHub) mainMenuHub.style.display = 'block';
    if (loaderProgress) loaderProgress.style.display = 'none';

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
    if (e.code === 'Tab') {
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
      if (loadingOverlay && loadingOverlay.classList.contains('hidden') && !controller.isLocked && !window.SecureFPSGame.isMenuOpen) {
        controller.requestLock();
      }
    });
  }

  // Viewport resize handler
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('orientationchange', onWindowResize);
}

function updateScoreboardTable(gameMode, multiplayer) {
  const tbody = document.getElementById('scoreboard-tbody');
  const modeLabel = document.getElementById('scoreboard-mode-label');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (modeLabel && gameMode) {
    modeLabel.textContent = (gameMode.currentMode || 'FREE-FOR-ALL').toUpperCase();
  }

  const rows = [];

  // Local Player Row
  const localName = sessionStorage.getItem('securefps_player_name') || 'Operator (You)';
  const kills = gameMode?.kills || 0;
  const deaths = gameMode?.deaths || 0;
  const kd = deaths > 0 ? (kills / deaths).toFixed(2) : (kills > 0 ? kills.toFixed(2) : '0.00');
  const score = kills * 100 + (gameMode?.headshots || 0) * 25;

  rows.push({
    name: localName,
    isLocal: true,
    status: 'ACTIVE',
    kills: kills,
    deaths: deaths,
    kd: kd,
    score: score,
    ping: '5 ms'
  });

  // If Bot Mode: Add Active Bots
  if (gameMode?.currentMode === 'bots' || gameMode?.currentMode === 'solo') {
    const botManager = window.SecureFPSGame.botManager;
    if (botManager && botManager.bots) {
      botManager.bots.forEach(b => {
        const botDead = b.isDead;
        rows.push({
          name: b.name,
          isLocal: false,
          status: botDead ? 'ELIMINATED' : (b.state || 'PATROL'),
          kills: 0,
          deaths: botDead ? 1 : 0,
          kd: botDead ? '0.00' : '1.00',
          score: botDead ? 0 : 50,
          ping: 'BOT'
        });
      });
    }
  }

  // If Multiplayer Mode: Add Remote Players
  if (gameMode?.currentMode === 'multiplayer' && multiplayer) {
    multiplayer.remotePlayers.forEach(p => {
      rows.push({
        name: p.name,
        isLocal: false,
        status: p.health > 0 ? 'ACTIVE' : 'RESPAWNING',
        kills: 1,
        deaths: 1,
        kd: '1.00',
        score: 100,
        ping: '28 ms'
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
    window.location.href = '/player.html';
  } catch (e) {
    window.location.href = '/player.html';
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
  if (isMenuOpen && menuOperator) {
    menuOperator.root.rotation.y += delta * 0.45;
    menuOperator.updateAnimation(delta, 0, true, camera);
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
    return;
  }

  // 2. Update First-Person Kinematics & Collisions
  if (controller) {
    try {
      controller.update(delta);
    } catch (e) {
      console.warn('[RenderLoop] Controller error:', e);
    }
  }

  // 3. Update Weapons, Recoil, Tracers & Firing
  if (weapons) {
    try {
      weapons.update(delta, controller, botManager);
    } catch (e) {
      console.warn('[RenderLoop] WeaponManager error:', e);
    }
  }

  // 4. Update Enemy AI Bots (only active in combat modes and while match is underway)
  if (botManager && controller && !botManager.isStopped) {
    if (gameMode && !gameMode.isMatchCompleted && (gameMode.currentMode === 'bots' || gameMode.currentMode === 'solo')) {
      try {
        botManager.update(
          delta,
          controller.position,
          controller,
          camera,
          gameMode,
          (damage, botName, botPos) => {
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
  if (trainingManager && gameMode && gameMode.currentMode === 'training') {
    try {
      trainingManager.update(delta);
    } catch (e) {
      console.warn('[RenderLoop] TrainingManager error:', e);
    }
  }

  // 6. Update Game Mode Progression & Spawn Protection Timers
  if (gameMode && controller) {
    try {
      gameMode.update(delta, controller);
    } catch (e) {
      console.warn('[RenderLoop] GameMode error:', e);
    }
  }

  // 7. Update Real-time Telemetry Client
  if (telemetry && controller) {
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
