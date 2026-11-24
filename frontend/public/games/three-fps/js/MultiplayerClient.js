/**
 * SecureFPS: Real-Time Multiplayer Networking Client (Authoritative V2)
 *
 * Implements:
 * - 30Hz client movement synchronization using socket.volatile.emit and sequence numbering
 * - Snapshot interpolation with 100ms adaptive buffer delay and shortest-arc rotation
 * - Maximum 150ms dead-reckoning extrapolation and frame-rate-independent smoothing
 * - Authoritative fire flow (cosmetic local prediction, server arbitration, floating damage on hit_confirmed)
 * - Server-authoritative rubberband reconciliation for local controller
 * - Session resumption via server-issued reconnect token in sessionStorage
 * - Clean async connect() Promise API without arbitrary setTimeout delays
 * - Complete listener teardown in disconnect()
 * - Latency, jitter, and packet loss metrics exported to HUD
 */

class RemotePlayer {
  constructor(id, name, position, scene, isFemale = false, team = 'red') {
    this.id = id;
    this.name = name;
    this.scene = scene;
    this.position = position ? position.clone() : new THREE.Vector3();
    this.currentRotation = 0;
    this.currentPitch = 0;
    this.isFemale = isFemale;
    this.team = team;
    this.health = 100;
    this.isCrouching = false;
    this.currentWeaponKey = 'carbine';

    // Snapshot interpolation buffer (stores timestamped server snapshots)
    this.snapshotBuffer = [];
    this.lastRenderTime = 0;

    // Use ONE shared character factory: TacticalOperator
    this.operator = new TacticalOperator(this.scene, {
      isEnemy: false,
      team: this.team,
      callsign: this.name,
      isFemale: this.isFemale,
      position: this.position
    });

    this.mesh = this.operator.root;
    this.mesh.userData.remotePlayer = this;
    this.headMesh = this.operator.headMesh;
    if (this.headMesh) this.headMesh.userData.remotePlayer = this;
    this.bodyMesh = this.operator.bodyMesh;
    if (this.bodyMesh) this.bodyMesh.userData.remotePlayer = this;
    this.nameTag = this.operator.nameTagSprite;
  }

  setWeapon(weaponKey) {
    if (!weaponKey || this.currentWeaponKey === weaponKey) return;
    this.currentWeaponKey = weaponKey;
    if (this.operator && typeof this.operator.setWeapon === 'function') {
      this.operator.setWeapon(weaponKey);
    }
  }

  addSnapshot(serverTime, x, y, z, yaw, pitch, isCrouching, health) {
    this.health = (health !== undefined) ? health : this.health;
    if (this.operator) {
      if (this.health <= 0 && !this.operator.isDead) {
        this.operator.die();
      } else if (this.health > 0 && this.operator.isDead) {
        this.operator.respawn(new THREE.Vector3(Number(x), Number(y), Number(z)));
        if (this.mesh) this.mesh.visible = true;
      }
    }
    this.snapshotBuffer.push({
      time: serverTime,
      x: Number(x),
      y: Number(y),
      z: Number(z),
      yaw: Number(yaw),
      pitch: Number(pitch || 0),
      isCrouching: Boolean(isCrouching)
    });

    // Keep buffer bounded (~1.2 seconds depth)
    while (this.snapshotBuffer.length > 40) {
      this.snapshotBuffer.shift();
    }
  }

  updateInterpolation(delta, currentEstimatedServerTime, interpDelay = 100) {
    if (!this.mesh) return;
    if (this.health <= 0) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    if (this.snapshotBuffer.length === 0) return;

    // Render time delayed by interpDelay (~100ms) behind authoritative server clock
    const renderTime = currentEstimatedServerTime - interpDelay;
    const buf = this.snapshotBuffer;

    let targetX = this.position.x;
    let targetY = this.position.y;
    let targetZ = this.position.z;
    let targetYaw = this.currentRotation;
    let targetPitch = this.currentPitch;
    let targetCrouch = this.isCrouching;

    if (renderTime <= buf[0].time) {
      // Snapshot buffer has not progressed past first entry
      const s = buf[0];
      targetX = s.x; targetY = s.y; targetZ = s.z;
      targetYaw = s.yaw; targetPitch = s.pitch;
      targetCrouch = s.isCrouching;
    } else if (renderTime >= buf[buf.length - 1].time) {
      // Ahead of latest snapshot -> Extrapolate up to 150ms max
      const latest = buf[buf.length - 1];
      const prev = buf[Math.max(0, buf.length - 2)];
      const dt = Math.max(0.001, latest.time - prev.time);
      const extrapolateTime = Math.min(150, renderTime - latest.time);
      const factor = extrapolateTime / dt;

      targetX = latest.x + (latest.x - prev.x) * factor;
      targetY = latest.y + (latest.y - prev.y) * factor;
      targetZ = latest.z + (latest.z - prev.z) * factor;
      targetYaw = latest.yaw;
      targetPitch = latest.pitch;
      targetCrouch = latest.isCrouching;
    } else {
      // Interpolate between two surrounding snapshots
      for (let i = 0; i < buf.length - 1; i++) {
        const s0 = buf[i];
        const s1 = buf[i + 1];
        if (renderTime >= s0.time && renderTime <= s1.time) {
          const span = Math.max(0.001, s1.time - s0.time);
          const alpha = (renderTime - s0.time) / span;

          targetX = s0.x + (s1.x - s0.x) * alpha;
          targetY = s0.y + (s1.y - s0.y) * alpha;
          targetZ = s0.z + (s1.z - s0.z) * alpha;

          // Shortest-arc angular interpolation for yaw
          let dYaw = s1.yaw - s0.yaw;
          while (dYaw > Math.PI) dYaw -= Math.PI * 2;
          while (dYaw < -Math.PI) dYaw += Math.PI * 2;
          targetYaw = s0.yaw + dYaw * alpha;

          targetPitch = s0.pitch + (s1.pitch - s0.pitch) * alpha;
          targetCrouch = (alpha < 0.5) ? s0.isCrouching : s1.isCrouching;
          break;
        }
      }
    }

    // Calculate instantaneous horizontal movement speed for procedural gait animation
    const dx = targetX - this.position.x;
    const dz = targetZ - this.position.z;
    const speed = Math.hypot(dx, dz) / Math.max(0.001, delta || 0.016);

    // Frame-rate independent exponential smoothing: (1 - exp(-k * dt))
    const smoothFactor = 1.0 - Math.exp(-22.0 * (delta || 0.016));
    this.position.x += (targetX - this.position.x) * smoothFactor;
    this.position.y += (targetY - this.position.y) * smoothFactor;
    this.position.z += (targetZ - this.position.z) * smoothFactor;
    this.mesh.position.copy(this.position);

    // Smooth shortest-arc yaw
    let rotDiff = targetYaw - this.currentRotation;
    while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
    while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
    this.currentRotation += rotDiff * smoothFactor;
    // The operator faces +Z and network yaw comes from a camera facing -Z.
    this.mesh.rotation.y = this.currentRotation + Math.PI;

    this.currentPitch += (targetPitch - this.currentPitch) * smoothFactor;
    this.isCrouching = targetCrouch;

    // Drive shared tactical operator procedural animation (walk/run/crouch/aim pitch)
    const camera = window.SecureFPSGame?.camera || null;
    if (this.operator && typeof this.operator.updateAnimation === 'function') {
      this.operator.updateAnimation(delta, speed, true, camera, this.isCrouching, this.currentPitch);
    }
  }

  triggerShoot() {
    if (this.operator && typeof this.operator.triggerShoot === 'function') {
      this.operator.triggerShoot();
    }
  }

  destroy() {
    if (this.operator && typeof this.operator.destroy === 'function') {
      this.operator.destroy();
    } else if (this.mesh && this.scene) {
      this.scene.remove(this.mesh);
    }
    this.mesh = null;
    this.snapshotBuffer = [];
  }
}

class MultiplayerClient {
  constructor(scene, audio) {
    this.scene = scene;
    this.audio = audio;
    this.socket = null;
    this.connectingPromise = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.localPlayerId = null;
    this.currentRoomCode = null;
    this.reconnectToken = null;
    this.isHost = false;
    this.isReady = false;
    this.remotePlayers = new Map();
    this.confirmedShotIds = new Set();
    this.confirmedHitIds = new Set();

    // 30Hz network sync rate (~33.33ms)
    this.syncInterval = 33.33;
    this.lastSyncTime = 0;
    this.moveSeq = 0;
    this.fireSeq = 0;

    // Latency & Network Quality Stats
    this.currentPing = 0;
    this.lastPingSentTime = 0;
    this.lastRtt = 50;
    this.jitter = 0;
    this.pingInterval = null;
    this.serverTimeOffset = 0; // serverTime - performance.now()
    this.adaptiveInterpDelay = 100;

    // Packet Loss Tracking
    this.pingsSent = 0;
    this.pongsReceived = 0;

    this.eventsRegistered = false;
  }

  get isInRoom() {
    return Boolean(this.currentRoomCode);
  }

  /**
   * Connect to Authoritative Socket.IO backend on Port 4001
   * Returns a clean Promise resolved on 'connect'
   */
  connect(customUrl = "") {
    if (this.isConnected && this.socket && this.socket.connected) {
      return Promise.resolve(this.socket);
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    if (typeof io === 'undefined') {
      const err = new Error('Socket.IO client library not loaded.');
      console.warn('[SecureFPS Multiplayer]', err.message);
      return Promise.reject(err);
    }

    const host = window.location.hostname || '127.0.0.1';
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const port = window.location.port;
    const isDirectFlask = port === '5000';
    const isPublicOrProxy = protocol === 'https:' || port === '' || port === '80' || port === '443' || port === '8080';

    let savedUrl = localStorage.getItem('securefps_server_url');
    if (savedUrl && savedUrl.includes(':4000')) {
      savedUrl = savedUrl.replace(':4000', ':4001');
      localStorage.setItem('securefps_server_url', savedUrl);
    }
    if (savedUrl && (savedUrl.includes('localhost') || savedUrl.includes('127.0.0.1')) && host !== 'localhost' && host !== '127.0.0.1') {
      savedUrl = null;
    }

    // On Cloudflare Tunnel / Public HTTPS / Reverse Proxy, Socket.IO routes through the reverse proxy on window.location.origin
    // On direct local Flask port 5000 without proxy, fallback to :4001
    const defaultMultiplayerUrl = isPublicOrProxy
      ? window.location.origin
      : (isDirectFlask ? `${protocol}//${host}:4001` : window.location.origin);

    const primaryUrl = customUrl || window.SECUREFPS_MULTIPLAYER_URL || savedUrl || defaultMultiplayerUrl;
    const apiBase = window.SecureFPSGame?.telemetry?.apiBase || window.APP_CONFIG?.apiBase || (
      isPublicOrProxy || (isDirectFlask && window.location.origin)
        ? `${window.location.origin}/api`
        : `${protocol}//${host}:5000/api`
    );

    console.log(`[SecureFPS Multiplayer] Connecting to authoritative server at ${primaryUrl}...`);
    this.isConnecting = true;

    const fetchTicket = async () => {
      const response = await fetch(`${apiBase}/game/socket-ticket`, { credentials: 'include' });
      const body = await response.json();
      if (!response.ok || !body.socket_token) {
        throw new Error(body.message || 'Multiplayer sign-in is unavailable.');
      }
      return body.socket_token;
    };
    this.connectingPromise = (async () => {
      const serverHost = new URL(primaryUrl, window.location.origin).hostname;
      const bothLoopback = ['localhost', '127.0.0.1'].includes(host) && ['localhost', '127.0.0.1'].includes(serverHost);
      if (serverHost !== host && !bothLoopback) {
        throw new Error('Use the multiplayer service on the same host as the dashboard.');
      }
      return fetchTicket();
    })().then(authToken => new Promise((resolve, reject) => {
      let initialToken = authToken;
      const sock = io(primaryUrl, {
        reconnection: true,
        reconnectionAttempts: 8,
        reconnectionDelay: 1000,
        timeout: 6000,
        transports: ['websocket', 'polling'],
        auth: callback => {
          if (initialToken) {
            callback({ token: initialToken });
            initialToken = null;
          } else {
            fetchTicket().then(token => callback({ token })).catch(() => callback({}));
          }
        }
      });

      const onConnect = () => {
        sock.off('connect_error', onConnectError);
        this.socket = sock;
        this.isConnected = true;
        this.isConnecting = false;
        this.connectingPromise = null;
        this.localPlayerId = sock.id;
        console.log(`[SecureFPS Multiplayer] Connected (Socket ID: ${sock.id})`);

        this.setupSocketEvents();
        this.startPingHeartbeat();

        // Check if there is an in-progress session to resume
        const savedResume = sessionStorage.getItem('securefps_reconnect');
        if (savedResume) {
          try {
            const resumeData = JSON.parse(savedResume);
            if (resumeData.roomCode && resumeData.reconnectToken) {
              console.log(`[SecureFPS Multiplayer] Attempting session resume in room ${resumeData.roomCode}...`);
              sock.emit('session:resume', resumeData);
            }
          } catch (e) {
            sessionStorage.removeItem('securefps_reconnect');
          }
        }

        window.dispatchEvent(new CustomEvent('fps:mp_connected', { detail: { id: sock.id, url: primaryUrl } }));
        resolve(sock);
      };

      const onConnectError = (err) => {
        sock.disconnect();
        reject(err);
      };

      sock.on('connect', onConnect);
      sock.once('connect_error', onConnectError);
    })).catch(err => {
      window.dispatchEvent(new CustomEvent('fps:mp_error', { detail: { message: err.message } }));
      throw err;
    }).finally(() => {
      this.isConnecting = false;
      this.connectingPromise = null;
    });

    return this.connectingPromise;
  }

  setupSocketEvents() {
    if (!this.socket || this.eventsRegistered) return;
    this.eventsRegistered = true;

    const sock = this.socket;

    sock.on('disconnect', () => {
      this.isConnected = false;
      this.clearRemotePlayers();
      console.log('[SecureFPS Multiplayer] Disconnected from server.');
      window.dispatchEvent(new CustomEvent('fps:mp_disconnected'));
    });

    sock.on('player:disconnected_grace', (data) => {
      console.log(`[SecureFPS Multiplayer] Operator ${data.name} disconnected (90s grace active)`);
      window.dispatchEvent(new CustomEvent('fps:player_disconnected_grace', { detail: data }));
    });

    sock.on('player:reconnected', (data) => {
      console.log(`[SecureFPS Multiplayer] Operator ${data.name} reconnected!`);
      window.dispatchEvent(new CustomEvent('fps:player_reconnected', { detail: data }));
    });

    sock.on('game:reconnected', (data) => {
      this.currentRoomCode = data.roomCode;
      this.localPlayerId = sock.id;
      this.isHost = data.isHost;
      this.clearRemotePlayers();

      if (data.players) {
        data.players.forEach(p => {
          if (p.id !== sock.id) {
            this.addOrUpdatePlayer(p);
            const remote = this.remotePlayers.get(p.id);
            if (remote) {
              remote.health = p.health ?? remote.health;
              remote.kills = p.kills ?? 0;
              remote.deaths = p.deaths ?? 0;
              remote.assists = p.assists ?? 0;
            }
          }
        });
      }

      console.log(`[SecureFPS Multiplayer] Successfully resumed session in room ${data.roomCode}`);
      window.dispatchEvent(new CustomEvent('fps:game_reconnected', { detail: data }));
    });

    sock.on('session:resume_failed', (data) => {
      console.warn('[SecureFPS Multiplayer] Session resume failed:', data.message);
      sessionStorage.removeItem('securefps_reconnect');
    });

    // --- Lobby Protocol ---
    sock.on('lobby:created', (data) => {
      this.currentRoomCode = data.roomCode;
      this.reconnectToken = data.reconnectToken;
      this.localPlayerId = sock.id;
      this.isHost = true;
      this.isReady = true;

      sessionStorage.setItem('securefps_reconnect', JSON.stringify({
        roomCode: data.roomCode,
        reconnectToken: data.reconnectToken
      }));

      window.dispatchEvent(new CustomEvent('fps:lobby_created', { detail: data }));
    });

    sock.on('lobby:joined', (data) => {
      this.currentRoomCode = data.roomCode;
      this.reconnectToken = data.reconnectToken;
      this.localPlayerId = sock.id;
      this.isHost = data.isHost;
      this.isReady = false;

      sessionStorage.setItem('securefps_reconnect', JSON.stringify({
        roomCode: data.roomCode,
        reconnectToken: data.reconnectToken
      }));

      window.dispatchEvent(new CustomEvent('fps:lobby_joined', { detail: data }));
    });

    sock.on('lobby:host_changed', (data) => {
      if (data.newHostId === this.localPlayerId || data.newHostId === sock.id) {
        this.isHost = true;
        this.isReady = true;
      }
      window.dispatchEvent(new CustomEvent('fps:lobby_host_changed', { detail: data }));
    });

    sock.on('lobby:player_update', (data) => {
      const myId = this.localPlayerId || sock.id;
      const me = data.players?.find(p => p.id === myId);
      if (me) {
        this.isHost = me.isHost;
        this.isReady = me.isReady;
      }
      window.dispatchEvent(new CustomEvent('fps:lobby_player_update', { detail: data }));
    });

    sock.on('lobby:error', (data) => {
      window.dispatchEvent(new CustomEvent('fps:lobby_error', { detail: data }));
    });

    sock.on('lobby:left', () => {
      this.currentRoomCode = null;
      this.reconnectToken = null;
      this.isHost = false;
      this.isReady = false;
      sessionStorage.removeItem('securefps_reconnect');
      this.clearRemotePlayers();
      window.dispatchEvent(new CustomEvent('fps:lobby_left'));
    });

    // --- Synchronized Match Start ---
    sock.on('game:start', (data) => {
      console.log(`[SecureFPS Multiplayer] Match starting in room ${data.roomCode}!`);
      this.clearRemotePlayers();
      this.confirmedShotIds.clear();
      this.confirmedHitIds.clear();

      const myId = this.localPlayerId || sock.id;
      data.players.forEach(p => {
        if (p.id === myId) {
          this.isHost = p.isHost;
          if (window.SecureFPSGame?.controller) {
            window.SecureFPSGame.controller.respawn(new THREE.Vector3(p.x, p.y, p.z));
          }
        } else {
          this.addOrUpdatePlayer(p);
        }
      });

      this.startPingHeartbeat();
      window.dispatchEvent(new CustomEvent('fps:game_start', { detail: data }));
    });

    // --- Authoritative 30Hz World Snapshot ---
    sock.on('world:snapshot', (snapshot) => {
      const nowClient = performance.now();
      if (snapshot.serverTime) {
        this.serverTimeOffset = snapshot.serverTime - nowClient;
      }
      const gameMode = window.SecureFPSGame?.gameMode;
      if (gameMode?.currentMode === 'multiplayer' && gameMode.matchActive && Number.isFinite(snapshot.remainingMs)) {
        gameMode.timeRemaining = snapshot.remainingMs / 1000;
      }

      if (Array.isArray(snapshot.players)) {
        snapshot.players.forEach(p => {
          if (p.id === sock.id || p.id === this.localPlayerId) {
            // Local player acknowledged seq
            return;
          }
          let remote = this.remotePlayers.get(p.id);
          if (!remote) {
            this.addOrUpdatePlayer(p);
            remote = this.remotePlayers.get(p.id);
          }
          if (remote) {
            remote.kills = p.kills ?? 0;
            remote.deaths = p.deaths ?? 0;
            remote.addSnapshot(snapshot.serverTime || nowClient, p.x, p.y, p.z, p.yaw, p.pitch, p.crouch, p.hp);
            if (p.weaponKey) {
              remote.setWeapon(p.weaponKey);
            }
          }
        });
      }
    });

    // --- Server-Authoritative Rubberband Correction ---
    sock.on('player:rubberband', (data) => {
      console.warn('[Anti-Cheat] Position corrected by server (rubberband):', data);
      if (window.SecureFPSGame?.controller) {
        window.SecureFPSGame.controller.position.set(data.x, data.y, data.z);
        if (window.SecureFPSGame.controller.velocity) {
          window.SecureFPSGame.controller.velocity.set(0, 0, 0);
        }
      }
      this.moveSeq = data.seq || 0;
    });

    // --- Synchronized Respawn ---
    sock.on('player:respawned', (data) => {
      const myId = this.localPlayerId || sock.id;
      if (data.id === myId) {
        const game = window.SecureFPSGame;
        game?.gameMode?.respawnPlayer(game.controller, new THREE.Vector3(data.x, data.y, data.z));
      } else {
        const remote = this.remotePlayers.get(data.id);
        if (remote) {
          remote.position.set(data.x, data.y, data.z);
          remote.health = 100;
          remote.snapshotBuffer = [];
          if (Math.abs(data.z) > 10) {
            remote.currentRotation = data.z < 0 ? Math.PI : 0;
          } else if (Math.abs(data.x) > 10) {
            remote.currentRotation = data.x < 0 ? -Math.PI / 2 : Math.PI / 2;
          } else {
            remote.currentRotation = 0;
          }
          if (remote.operator && typeof remote.operator.respawn === 'function') {
            remote.operator.respawn(remote.position);
          }
          if (remote.mesh) {
            remote.mesh.position.set(data.x, data.y, data.z);
            remote.mesh.rotation.y = remote.currentRotation + Math.PI;
            remote.mesh.visible = true;
          }
        }
      }
    });

    // --- Remote Gunshot FX ---
    sock.on('player:fired', (data) => {
      if (data.id !== this.localPlayerId && data.id !== sock.id) {
        const remote = this.remotePlayers.get(data.id);
        if (remote) remote.triggerShoot();
        this.renderRemoteShot(data);
      }
    });

    // --- Latency Ping/Pong ---
    sock.on('player:pong', (clientTimestamp) => {
      this.pongsReceived++;
      const now = performance.now();
      const rtt = Math.max(1, Math.round(now - (clientTimestamp || this.lastPingSentTime || now)));
      this.jitter = Math.round(Math.abs(rtt - this.lastRtt));
      this.lastRtt = rtt;
      this.currentPing = rtt;

      // Adaptive interpolation delay: rtt + 2 * jitter (clamped 70ms to 220ms)
      this.adaptiveInterpDelay = Math.max(70, Math.min(220, rtt + this.jitter * 2));

      const loss = this.pingsSent > 0 ? Math.max(0, ((this.pingsSent - this.pongsReceived) / this.pingsSent) * 100) : 0;

      if (window.SecureFPSGame?.hud) {
        if (window.SecureFPSGame.hud.updateNetworkStats) {
          window.SecureFPSGame.hud.updateNetworkStats(rtt, this.jitter, loss);
        } else if (window.SecureFPSGame.hud.updatePing) {
          window.SecureFPSGame.hud.updatePing(rtt);
        }
      }
    });

    // --- Damage / Combat Events ---
    sock.on('player:shot_confirmed', (data) => {
      const shotId = data?.shotId;
      if (typeof shotId !== 'string' || this.confirmedShotIds.has(shotId)) return;
      this.confirmedShotIds.add(shotId);
      window.dispatchEvent(new CustomEvent('fps:telemetry_fire', {
        detail: { weapon: data.weaponKey, shot_id: shotId }
      }));
    });

    sock.on('player:hurt', (data) => {
      if (window.SecureFPSGame?.gameMode) {
        if (!window.SecureFPSGame.gameMode.matchActive) {
          window.SecureFPSGame.gameMode.matchActive = true;
          window.SecureFPSGame.gameMode.isDead = false;
        }
        window.SecureFPSGame.gameMode.hasSpawnProtection = false;
        const attackerPos = data.attackerPos ? new THREE.Vector3(data.attackerPos.x, data.attackerPos.y, data.attackerPos.z) : null;
        window.SecureFPSGame.gameMode.damagePlayer(data.damage, data.attackerName, window.SecureFPSGame.controller, attackerPos, data.currentHealth);
      }
    });

    sock.on('player:hit_confirmed', (data) => {
      const shotId = data?.shotId;
      if (typeof shotId !== 'string' || this.confirmedHitIds.has(shotId)) return;
      this.confirmedHitIds.add(shotId);
      if (this.audio) this.audio.playHitmarker(data.headshot);
      if (window.SecureFPSGame?.weapons) {
        window.SecureFPSGame.weapons.triggerHitmarkerHUD(data.headshot);
      }
      window.dispatchEvent(new CustomEvent('fps:telemetry_hit', {
        detail: {
          damage: data.damage,
          headshot: !!data.headshot,
          target: data.victimId,
          shot_id: shotId,
        }
      }));
      if (window.SecureFPSGame?.hud && data.damage) {
        const sx = window.innerWidth / 2 + (Math.random() * 40 - 20);
        const sy = window.innerHeight / 2 - 30 + (Math.random() * 20 - 10);
        window.SecureFPSGame.hud.showFloatingDamage(sx, sy, data.damage, data.headshot);
      }
    });

    sock.on('player:assist', (data) => {
      if (window.SecureFPSGame?.gameMode) {
        window.SecureFPSGame.gameMode.assists = (window.SecureFPSGame.gameMode.assists || 0) + 1;
        if (window.SecureFPSGame.hud?.updateAssists) {
          window.SecureFPSGame.hud.updateAssists(window.SecureFPSGame.gameMode.assists);
        }
        if (window.SecureFPSGame.hud?.showStreakBanner) {
          window.SecureFPSGame.hud.showStreakBanner("ASSIST CONFIRMED", `+50 PTS // Assist on ${data.victimName || 'Enemy Operator'}`);
        }
      }
    });

    sock.on('player:killed', (data) => {
      const myId = this.localPlayerId || sock.id;
      const isLocalKiller = (data.killerId === myId);
      const isLocalVictim = (data.victimId === myId);

      const victimRemote = this.remotePlayers.get(data.victimId);
      if (victimRemote) {
        victimRemote.health = 0;
        if (victimRemote.mesh) victimRemote.mesh.visible = false;
      }

      if (isLocalKiller) {
        if (window.SecureFPSGame?.hud?.showElimination) {
          window.SecureFPSGame.hud.showElimination(data.victimName, data.headshot);
        }
        if (this.audio?.playEliminationSound) {
          this.audio.playEliminationSound(data.headshot);
        }
        // Emit fps:kill once. GameModeManager listens to fps:kill and calls onKill(detail),
        // and TelemetryClient streams authoritative enemy_killed events for genuine combat stats.
        window.dispatchEvent(new CustomEvent('fps:kill', {
          detail: { victim: data.victimName, headshot: Boolean(data.headshot), weapon: data.weapon }
        }));
      }

      if (window.SecureFPSGame?.hud?.addKillFeedEntry) {
        window.SecureFPSGame.hud.addKillFeedEntry(
          data.killerName || 'Operator',
          data.victimName || 'Operator',
          data.weapon || 'P-24 Carbine',
          data.headshot,
          isLocalKiller,
          isLocalVictim
        );
      }
    });

    sock.on('player:left', (data) => {
      this.removePlayer(data.id);
    });

    sock.on('match:ended', (data) => {
      console.log(`[Match Lifecycle] Match ended (${data.reason}). Final scoreboard received:`, data.scoreboard);
      this.clearRemotePlayers();
      const gameMode = window.SecureFPSGame?.gameMode;
      if (gameMode?.currentMode !== 'multiplayer') return;

      const myId = this.localPlayerId || sock.id;
      const myName = (typeof sessionStorage !== 'undefined' && sessionStorage?.getItem('securefps_player_name')) || this.playerName;
      let local = data.scoreboard?.find(row => row.id === myId);
      if (!local && myName) {
        local = data.scoreboard?.find(row => row.name === myName);
      }
      if (!local && data.scoreboard?.length > 0) {
        local = data.scoreboard[0];
      }
      const winner = data.scoreboard?.find(row => row.isWinner) || data.scoreboard?.[0];
      const isVictory = local ? Boolean(local.isWinner) : (winner?.name === myName);

      gameMode.completeMatch(data.reason, {
        winner: winner?.name ?? (isVictory ? myName : 'Draw'),
        isVictory: isVictory,
        isDraw: !winner || (winner.kills === 0 && data.reason === 'time_expired'),
        kills: local?.kills ?? gameMode.kills,
        deaths: local?.deaths ?? gameMode.deaths,
        assists: local?.assists ?? gameMode.assists,
        completionToken: data.completionToken,
        shots: local?.shotsFired ?? gameMode.shotsFired,
        hits: local?.shotsHit ?? gameMode.shotsHit,
        accuracy: local?.accuracy ? (local.accuracy / 100) : (gameMode.shotsFired > 0 ? (gameMode.shotsHit / gameMode.shotsFired) : 0),
        kdr: local ? (local.deaths ? local.kills / local.deaths : local.kills) : (gameMode.deaths ? gameMode.kills / gameMode.deaths : gameMode.kills),
        score: local?.score ?? 0,
        duration: data.durationSeconds ?? Math.max(1, Math.round(gameMode.matchDuration - gameMode.timeRemaining)),
        mvp: data.scoreboard?.[0]
      });
    });
  }

  startPingHeartbeat() {
    this.stopPingHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.socket && this.socket.connected) {
        this.pingsSent++;
        this.lastPingSentTime = performance.now();
        this.socket.emit('player:ping', this.lastPingSentTime);
      }
    }, 2000);
  }

  stopPingHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  async createRoom(playerName, honourScore = 100, operator = 'vanguard') {
    playerName = (playerName || 'Operator_Host').trim();
    try {
      await this.connect();
      if (this.socket && this.socket.connected) {
        this.localPlayerId = this.socket.id;
        this.socket.emit('lobby:create', { name: playerName, honour_score: honourScore, operator });
      }
    } catch (err) {
      window.dispatchEvent(new CustomEvent('fps:lobby_error', {
        detail: { message: `Could not connect to multiplayer server: ${err.message}` }
      }));
    }
  }

  async joinRoom(roomCode, playerName, honourScore = 100, operator = 'vanguard') {
    playerName = (playerName || 'Operator').trim();
    roomCode = (roomCode || '').toUpperCase().trim();
    try {
      await this.connect();
      if (this.socket && this.socket.connected) {
        this.socket.emit('lobby:join', { roomCode, name: playerName, honour_score: honourScore, operator });
      }
    } catch (err) {
      window.dispatchEvent(new CustomEvent('fps:lobby_error', {
        detail: { message: `Could not connect to multiplayer server: ${err.message}` }
      }));
    }
  }

  setReady(isReady) {
    this.isReady = Boolean(isReady);
    if (this.isConnected && this.socket) {
      this.socket.emit('lobby:ready', { isReady: this.isReady });
    }
  }

  startMatch() {
    if (this.isConnected && this.socket) {
      this.socket.emit('lobby:start');
    }
  }

  leaveRoom() {
    this.stopPingHeartbeat();
    if (this.isConnected && this.socket) {
      this.socket.emit('lobby:leave');
    }
    this.currentRoomCode = null;
    this.reconnectToken = null;
    this.isHost = false;
    this.isReady = false;
    sessionStorage.removeItem('securefps_reconnect');
    this.clearRemotePlayers();
    window.dispatchEvent(new CustomEvent('fps:lobby_left'));
  }

  /**
   * Complete teardown of multiplayer client
   */
  disconnect() {
    this.stopPingHeartbeat();
    this.clearRemotePlayers();

    if (this.socket) {
      const registeredEvents = [
        'connect', 'connect_error', 'disconnect', 'player:disconnected_grace',
        'player:reconnected', 'game:reconnected', 'session:resume_failed',
        'lobby:created', 'lobby:joined', 'lobby:host_changed', 'lobby:player_update',
        'lobby:error', 'lobby:left', 'game:start', 'world:snapshot', 'player:rubberband',
        'player:respawned', 'player:fired', 'player:pong', 'player:hurt',
        'player:shot_confirmed', 'player:hit_confirmed', 'player:assist', 'player:killed', 'player:left',
        'match:ended'
      ];
      registeredEvents.forEach(evt => this.socket.removeAllListeners(evt));

      try {
        this.socket.disconnect();
      } catch (e) {
        // Safe ignore
      }
      this.socket = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.connectingPromise = null;
    this.eventsRegistered = false;
    this.currentRoomCode = null;
    this.reconnectToken = null;
  }

  addOrUpdatePlayer(data) {
    if (this.remotePlayers.has(data.id)) return;
    const posY = (data.y !== undefined) ? data.y : 0;
    const pos = new THREE.Vector3(data.x || 0, posY, data.z || 0);
    const isFemale = !!data.isFemale;
    const team = data.team || 'red';
    const remote = new RemotePlayer(data.id, data.name || 'Operator', pos, this.scene, isFemale, team);
    this.remotePlayers.set(data.id, remote);
  }

  removePlayer(id) {
    const remote = this.remotePlayers.get(id);
    if (remote) {
      remote.destroy();
      this.remotePlayers.delete(id);
    }
  }

  clearRemotePlayers() {
    this.remotePlayers.forEach(p => p.destroy());
    this.remotePlayers.clear();
  }

  getHitboxMeshes() {
    const hitboxes = [];
    this.remotePlayers.forEach(player => {
      if (player.headMesh) hitboxes.push(player.headMesh);
      if (player.bodyMesh) hitboxes.push(player.bodyMesh);
    });
    return hitboxes;
  }

  /**
   * Main render loop update
   * Fixes time-unit bug: uses performance.now() in ms for 30Hz network sync
   */
  update(delta, nowSeconds, controller) {
    const nowMs = performance.now();
    const currentEstimatedServerTime = nowMs + this.serverTimeOffset;

    // Snapshot interpolation for all remote operators
    this.remotePlayers.forEach(p => {
      p.updateInterpolation(delta, currentEstimatedServerTime, this.adaptiveInterpDelay);
    });

    // Authoritative 30Hz client position broadcast
    if (this.isConnected && this.socket && controller && this.currentRoomCode) {
      if (nowMs - this.lastSyncTime >= this.syncInterval) {
        this.lastSyncTime = nowMs;
        this.moveSeq++;

        this.socket.volatile.emit('player:move', {
          seq: this.moveSeq,
          clientTime: nowMs,
          x: Number(controller.position.x.toFixed(2)),
          y: Number(controller.position.y.toFixed(2)),
          z: Number(controller.position.z.toFixed(2)),
          yaw: Number(controller.yaw.toFixed(3)),
          pitch: Number((controller.pitch || 0).toFixed(3)),
          isSprinting: Boolean(controller.isSprinting),
          isCrouching: Boolean(controller.isCrouching)
        });
      }
    }
  }

  /**
   * Authoritative fire submission:
   * Client sends origin, direction, weaponKey, clientTime, and seq.
   * Hit detection and damage arbitration take place strictly on the server.
   */
  emitFire(origin, direction, weaponKey = 'carbine') {
    if (!this.isConnected || !this.socket) return;
    this.fireSeq++;

    const dirX = direction ? Number(direction.x.toFixed(4)) : 0;
    const dirY = direction ? Number(direction.y.toFixed(4)) : 0;
    const dirZ = direction ? Number(direction.z.toFixed(4)) : -1;

    this.socket.emit('player:fire', {
      seq: this.fireSeq,
      clientTime: performance.now(),
      origin: {
        x: Number(origin.x.toFixed(2)),
        y: Number(origin.y.toFixed(2)),
        z: Number(origin.z.toFixed(2))
      },
      direction: {
        x: dirX,
        y: dirY,
        z: dirZ
      },
      weaponKey: weaponKey
    });
  }

  renderRemoteShot(data) {
    if (this.audio) this.audio.playGunshot('rifle', true);

    const start = new THREE.Vector3(data.origin.x, data.origin.y, data.origin.z);
    const end = new THREE.Vector3(data.target.x, data.target.y, data.target.z);
    const dist = Math.max(0.5, start.distanceTo(end));

    const geo = new THREE.CylinderGeometry(0.012, 0.012, dist, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.85 });
    const tracer = new THREE.Mesh(geo, mat);
    tracer.position.copy(start).add(end).multiplyScalar(0.5);
    tracer.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());

    this.scene.add(tracer);
    setTimeout(() => {
      this.scene.remove(tracer);
      geo.dispose();
      mat.dispose();
    }, 60);
  }
}

window.MultiplayerClient = MultiplayerClient;
