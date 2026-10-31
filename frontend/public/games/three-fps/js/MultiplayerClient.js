/**
 * SecureFPS: Real-Time Multiplayer Networking Client
 * Integrates Socket.IO for authoritative room matchmaking, player synchronization,
 * remote player rendering, linear interpolation, shooting, and hit registration.
 * Authoritative Server Port: 4001
 */

class RemotePlayer {
  constructor(id, name, position, scene, isFemale = false, team = 'red') {
    this.id = id;
    this.name = name;
    this.scene = scene;
    this.position = position ? position.clone() : new THREE.Vector3();
    this.targetPosition = this.position.clone();
    this.targetRotation = 0;
    this.currentRotation = 0;
    this.isFemale = isFemale;
    this.team = team;
    this.health = 100;

    this.mesh = null;
    this.headMesh = null;
    this.bodyMesh = null;
    this.nameTag = null;
    this.initMesh();
  }

  initMesh() {
    if (!this.scene) return;
    const group = new THREE.Group();
    group.userData.remotePlayer = this;

    const armorColor = this.team === 'blue' ? 0x0284c7 : 0xdc2626;
    const armorMat = new THREE.MeshStandardMaterial({
      color: armorColor,
      roughness: 0.5,
      metalness: 0.5
    });

    const innerMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.8,
      metalness: 0.2
    });

    // Torso
    const torsoGeo = new THREE.BoxGeometry(0.55, 0.75, 0.35);
    const torso = new THREE.Mesh(torsoGeo, armorMat);
    torso.position.set(0, 1.15, 0);
    torso.castShadow = true;
    group.add(torso);
    this.bodyMesh = torso;

    // Head
    const headGeo = new THREE.BoxGeometry(0.32, 0.32, 0.32);
    const head = new THREE.Mesh(headGeo, armorMat);
    head.position.set(0, 1.72, 0);
    head.castShadow = true;
    group.add(head);
    this.headMesh = head;

    // Glowing Visor
    const visorGeo = new THREE.BoxGeometry(0.24, 0.08, 0.04);
    const visor = new THREE.Mesh(visorGeo, new THREE.MeshBasicMaterial({ color: 0x00f0ff }));
    visor.position.set(0, 1.72, 0.17);
    group.add(visor);

    // Legs
    const legGeo = new THREE.BoxGeometry(0.2, 0.78, 0.22);
    const lLeg = new THREE.Mesh(legGeo, innerMat);
    lLeg.position.set(-0.16, 0.39, 0);
    lLeg.castShadow = true;
    group.add(lLeg);

    const rLeg = new THREE.Mesh(legGeo, innerMat);
    rLeg.position.set(0.16, 0.39, 0);
    rLeg.castShadow = true;
    group.add(rLeg);

    // Gun
    const gunGeo = new THREE.BoxGeometry(0.08, 0.1, 0.5);
    const gun = new THREE.Mesh(gunGeo, innerMat);
    gun.position.set(0.32, 1.15, 0.35);
    group.add(gun);

    // Overhead 3D Nameplate Canvas
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
        if (ctx.roundRect) ctx.roundRect(10, 10, 236, 44, 8);
        else ctx.fillRect(10, 10, 236, 44);
        ctx.fill();
        ctx.font = 'bold 22px system-ui, sans-serif';
        ctx.fillStyle = '#00f0ff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.name, 128, 32);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.position.set(0, 2.2, 0);
        sprite.raycast = () => {};
        sprite.scale.set(1.6, 0.4, 1.0);
        group.add(sprite);
        this.nameTag = sprite;
      }
    } catch (e) {
      console.warn('[RemotePlayer] Nametag creation omitted:', e);
    }

    // Attach remotePlayer reference to all meshes in group
    group.traverse((child) => {
      if (child.isMesh) {
        child.userData.remotePlayer = this;
      }
    });
    if (this.headMesh) this.headMesh.userData.isHead = true;

    group.position.copy(this.position);
    this.scene.add(group);
    this.mesh = group;
  }

  updateInterpolation(delta, camera) {
    if (!this.mesh) return;

    // Linear Interpolation (LERP) for smooth movement
    const lerpFactor = Math.min(1.0, (delta || 0.016) * 14);
    this.position.lerp(this.targetPosition, lerpFactor);
    this.mesh.position.copy(this.position);

    // Rotation Interpolation
    let rotDiff = this.targetRotation - this.currentRotation;
    while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
    while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
    this.currentRotation += rotDiff * lerpFactor;
    this.mesh.rotation.y = this.currentRotation;
  }

  triggerShoot() {
    // Visual flash could be added here if desired
  }

  destroy() {
    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh);
      this.mesh.traverse((node) => {
        if (node.geometry && typeof node.geometry.dispose === 'function') node.geometry.dispose();
        if (node.material) {
          if (Array.isArray(node.material)) node.material.forEach(m => m.dispose && m.dispose());
          else if (typeof node.material.dispose === 'function') node.material.dispose();
        }
      });
      this.mesh = null;
    }
  }
}

class MultiplayerClient {
  constructor(scene, audio) {
    this.scene = scene;
    this.audio = audio;
    this.socket = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.localPlayerId = null;
    this.currentRoomCode = null;
    this.isHost = false;
    this.isReady = false;
    this.remotePlayers = new Map();
    this.syncInterval = 33; // ~30 updates/sec
    this.lastSyncTime = 0;
    this.currentPing = 0;
    this.lastPingSentTime = 0;
    this.pingInterval = null;
  }

  /**
   * Connect to Authoritative Socket.IO backend on Port 4001
   * Supports custom WAN / Tunnel URLs passed from settings
   */
  connect(customUrl = "") {
    if (this.socket && (this.isConnected || this.isConnecting)) return;
    this.isConnecting = true;

    if (typeof io === 'undefined') {
      console.warn('[SecureFPS Multiplayer] Socket.IO client library not loaded. Local mode only.');
      this.isConnecting = false;
      return;
    }

    const host = window.location.hostname || '127.0.0.1';
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';

    // Auto-migrate any stale :4000 references stored in localStorage
    let savedUrl = localStorage.getItem('securefps_server_url');
    if (savedUrl && (savedUrl.includes(':4000') || savedUrl.includes('4000'))) {
      savedUrl = savedUrl.replace(':4000', ':4001');
      localStorage.setItem('securefps_server_url', savedUrl);
    }
    // If savedUrl is pointing to localhost / 127.0.0.1 but the current page is on a remote host (e.g. 10.1.4.95), ignore stale localhost savedUrl
    if (savedUrl && (savedUrl.includes('localhost') || savedUrl.includes('127.0.0.1')) && host !== 'localhost' && host !== '127.0.0.1') {
      savedUrl = null;
    }
    const primaryUrl = customUrl || savedUrl || `${protocol}//${host}:4001`;

    console.log(`[SecureFPS Multiplayer] Connecting to authoritative server at ${primaryUrl}...`);

    const sock = io(primaryUrl, {
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 1000,
      timeout: 6000,
      transports: ['websocket', 'polling']
    });

    sock.on('connect', () => {
      this.socket = sock;
      this.isConnected = true;
      this.isConnecting = false;
      this.localPlayerId = sock.id;
      console.log(`[SecureFPS Multiplayer] Connected to authoritative server at ${primaryUrl} (Socket ID: ${sock.id})`);
      this.setupSocketEvents();
      window.dispatchEvent(new CustomEvent('fps:mp_connected', { detail: { id: sock.id, url: primaryUrl } }));
    });

    sock.on('connect_error', (err) => {
      this.isConnecting = false;
      console.warn(`[SecureFPS Multiplayer] Port 4001 connection failed: ${err.message}`);
      window.dispatchEvent(new CustomEvent('fps:mp_error', {
        detail: { message: `Multiplayer server offline (:4001). Error: ${err.message}` }
      }));
    });
  }

  setupSocketEvents() {
    if (!this.socket) return;

    // Prevent duplicate event handlers on reconnection
    const eventNames = [
      'disconnect', 'lobby:created', 'lobby:joined', 'lobby:host_changed',
      'lobby:player_update', 'lobby:error', 'game:start', 'player:moved',
      'player:fired', 'player:hurt', 'player:hit_confirmed', 'player:killed',
      'player:respawned', 'player:left'
    ];
    eventNames.forEach(evt => {
      if (typeof this.socket.removeAllListeners === 'function') {
        this.socket.removeAllListeners(evt);
      }
    });

    this.socket.on('player:disconnected_grace', (data) => {
      console.log(`[SecureFPS Multiplayer] Player ${data.name} disconnected (90s grace period active)`);
      window.dispatchEvent(new CustomEvent('fps:player_disconnected_grace', { detail: data }));
    });

    this.socket.on('player:reconnected', (data) => {
      console.log(`[SecureFPS Multiplayer] Player ${data.name} reconnected!`);
      window.dispatchEvent(new CustomEvent('fps:player_reconnected', { detail: data }));
    });

    this.socket.on('game:reconnected', (data) => {
      this.currentRoomCode = data.roomCode;
      this.localPlayerId = this.socket?.id;
      this.isHost = data.isHost;
      console.log(`[SecureFPS Multiplayer] Successfully reconnected to game in room ${data.roomCode}`);
      window.dispatchEvent(new CustomEvent('fps:game_reconnected', { detail: data }));
    });

    this.socket.on('disconnect', () => {
      this.isConnected = false;
      this.clearRemotePlayers();
      console.log('[SecureFPS Multiplayer] Disconnected from server.');
      window.dispatchEvent(new CustomEvent('fps:mp_disconnected'));
    });

    // --- Lobby Protocol Events ---
    this.socket.on('lobby:created', (data) => {
      this.currentRoomCode = data.roomCode;
      this.localPlayerId = this.socket?.id || data.players?.find(p => p.isHost)?.id;
      this.isHost = true;
      this.isReady = true;
      window.dispatchEvent(new CustomEvent('fps:lobby_created', { detail: data }));
    });

    this.socket.on('lobby:joined', (data) => {
      this.currentRoomCode = data.roomCode;
      this.localPlayerId = this.socket?.id;
      this.isHost = data.isHost;
      this.isReady = false;
      window.dispatchEvent(new CustomEvent('fps:lobby_joined', { detail: data }));
    });

    this.socket.on('lobby:host_changed', (data) => {
      const myId = this.localPlayerId || this.socket?.id;
      if (data.newHostId === myId) {
        this.isHost = true;
        this.isReady = true;
      }
      window.dispatchEvent(new CustomEvent('fps:lobby_host_changed', { detail: data }));
    });

    this.socket.on('lobby:player_update', (data) => {
      const myId = this.localPlayerId || this.socket?.id;
      const me = data.players?.find(p => p.id === myId);
      if (me) {
        this.isHost = me.isHost;
        this.isReady = me.isReady;
      }
      window.dispatchEvent(new CustomEvent('fps:lobby_player_update', { detail: data }));
    });

    this.socket.on('lobby:error', (data) => {
      window.dispatchEvent(new CustomEvent('fps:lobby_error', { detail: data }));
    });

    this.socket.on('lobby:left', (data) => {
      this.currentRoomCode = null;
      this.isHost = false;
      this.isReady = false;
      this.clearRemotePlayers();
      window.dispatchEvent(new CustomEvent('fps:lobby_left', { detail: data }));
    });

    // --- Synchronized Match Start ---
    this.socket.on('game:start', (data) => {
      console.log(`[SecureFPS Multiplayer] Match starting in room ${data.roomCode}! Synchronizing ${data.players.length} operators...`);
      this.clearRemotePlayers();

      const myId = this.localPlayerId || this.socket?.id;
      data.players.forEach(p => {
        if (p.id === myId) {
          this.isHost = p.isHost;
          if (window.SecureFPSGame?.controller) {
            window.SecureFPSGame.controller.respawn(new THREE.Vector3(p.x, 0, p.z));
          }
        } else {
          this.addOrUpdatePlayer(p);
        }
      });

      this.startPingHeartbeat();
      window.dispatchEvent(new CustomEvent('fps:game_start', { detail: data }));
    });

    // --- Synchronized Player Respawn ---
    this.socket.on('player:respawned', (data) => {
      const myId = this.localPlayerId || this.socket?.id;
      if (data.id === myId) {
        if (window.SecureFPSGame?.controller) {
          window.SecureFPSGame.controller.respawn(new THREE.Vector3(data.x, 0, data.z));
        }
        if (window.SecureFPSGame?.gameMode) {
          window.SecureFPSGame.gameMode.respawnPlayer(window.SecureFPSGame.controller);
        }
      } else {
        const remote = this.remotePlayers.get(data.id);
        if (remote) {
          remote.position.set(data.x, data.y || 0, data.z);
          remote.targetPosition.set(data.x, data.y || 0, data.z);
          remote.health = 100;
          if (remote.mesh) {
            remote.mesh.position.set(data.x, data.y || 0, data.z);
            remote.mesh.visible = true;
          }
        }
      }
    });

    // --- In-Game 30Hz Movement Sync ---
    this.socket.on('player:moved', (data) => {
      const remote = this.remotePlayers.get(data.id);
      if (remote) {
        remote.targetPosition.set(data.x, data.y, data.z);
        remote.targetRotation = data.yaw;
      }
    });

    // --- Remote Firing FX ---
    this.socket.on('player:fired', (data) => {
      if (data.id !== this.localPlayerId) {
        const remote = this.remotePlayers.get(data.id);
        if (remote) remote.triggerShoot();
        this.renderRemoteShot(data);
      }
    });

    // --- Latency Ping/Pong ---
    this.socket.on('player:pong', (clientTimestamp) => {
      const ping = Math.round(performance.now() - (clientTimestamp || this.lastPingSentTime || performance.now()));
      this.currentPing = ping;
      if (window.SecureFPSGame?.hud?.updatePing) {
        window.SecureFPSGame.hud.updatePing(ping);
      }
    });

    // --- Damage / Hit Arbitrated Events ---
    this.socket.on('player:hurt', (data) => {
      if (window.SecureFPSGame?.gameMode) {
        if (!window.SecureFPSGame.gameMode.matchActive) {
          window.SecureFPSGame.gameMode.matchActive = true;
          window.SecureFPSGame.gameMode.isDead = false;
        }
        window.SecureFPSGame.gameMode.hasSpawnProtection = false;
        const attackerPos = data.attackerPos ? new THREE.Vector3(data.attackerPos.x, data.attackerPos.y, data.attackerPos.z) : null;
        window.SecureFPSGame.gameMode.damagePlayer(data.damage, data.attackerName, window.SecureFPSGame.controller, attackerPos);
      }
    });

    this.socket.on('player:hit_confirmed', (data) => {
      if (this.audio) this.audio.playHitmarker(data.headshot);
      if (window.SecureFPSGame?.weapons) {
        window.SecureFPSGame.weapons.triggerHitmarkerHUD(data.headshot);
      }
      if (window.SecureFPSGame?.hud && data.damage) {
        const sx = window.innerWidth / 2 + (Math.random() * 40 - 20);
        const sy = window.innerHeight / 2 - 30 + (Math.random() * 20 - 10);
        window.SecureFPSGame.hud.showFloatingDamage(sx, sy, data.damage, data.headshot);
      }
    });

    this.socket.on('player:assist', (data) => {
      if (window.SecureFPSGame?.gameMode) {
        window.SecureFPSGame.gameMode.assists++;
        if (window.SecureFPSGame.hud?.updateAssists) {
          window.SecureFPSGame.hud.updateAssists(window.SecureFPSGame.gameMode.assists);
        }
        if (window.SecureFPSGame.hud?.showStreakBanner) {
          window.SecureFPSGame.hud.showStreakBanner("ASSIST CONFIRMED", `+50 PTS // Assist on ${data.victimName || 'Enemy Operator'}`);
        }
      }
    });

    this.socket.on('player:killed', (data) => {
      const isLocalKiller = (data.killerId === this.localPlayerId);
      const isLocalVictim = (data.victimId === this.localPlayerId);

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
        if (window.SecureFPSGame?.gameMode) {
          window.SecureFPSGame.gameMode.onKill({ victim: data.victimName, headshot: data.headshot, weapon: data.weapon });
        }
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
      } else if (window.SecureFPSGame?.gameMode) {
        window.SecureFPSGame.gameMode.addKillfeed(data.killerName, data.victimName, data.headshot);
      }
    });

    this.socket.on('player:left', (data) => {
      this.removePlayer(data.id);
    });
  }

  startPingHeartbeat() {
    this.stopPingHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.socket && this.socket.connected) {
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

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  createRoom(playerName, honourScore = 100) {
    playerName = (playerName || 'Operator_Host').trim();

    if (this.isConnected && this.socket) {
      this.localPlayerId = this.socket.id;
      this.socket.emit('lobby:create', { name: playerName, honour_score: honourScore });
      return;
    }

    this.connect();
    setTimeout(() => {
      if (this.isConnected && this.socket) {
        this.localPlayerId = this.socket.id;
        this.socket.emit('lobby:create', { name: playerName, honour_score: honourScore });
      } else {
        window.dispatchEvent(new CustomEvent('fps:lobby_error', {
          detail: { message: 'Connecting to multiplayer server (:4001)... please retry in a moment.' }
        }));
      }
    }, 600);
  }

  joinRoom(roomCode, playerName, honourScore = 100) {
    playerName = (playerName || 'Operator').trim();
    roomCode = (roomCode || '').toUpperCase().trim();

    if (!this.isConnected || !this.socket) {
      this.connect();
      setTimeout(() => {
        if (this.isConnected && this.socket) {
          this.socket.emit('lobby:join', { roomCode, name: playerName, honour_score: honourScore });
        } else {
          window.dispatchEvent(new CustomEvent('fps:lobby_error', {
            detail: { message: 'Multiplayer server is offline (:4001). Please run "node server.js".' }
          }));
        }
      }, 700);
      return;
    }
    this.socket.emit('lobby:join', { roomCode, name: playerName, honour_score: honourScore });
  }

  setReady(isReady) {
    this.isReady = isReady;
    if (this.isConnected && this.socket) {
      this.socket.emit('lobby:ready', { isReady });
    } else {
      window.dispatchEvent(new CustomEvent('fps:lobby_player_update', {
        detail: {
          players: [
            {
              id: this.localPlayerId || 'local_host',
              name: sessionStorage.getItem('securefps_player_name') || 'Host_Operator',
              isHost: this.isHost,
              isReady: this.isReady
            }
          ]
        }
      }));
    }
  }

  startMatch() {
    if (this.isConnected && this.socket) {
      this.socket.emit('lobby:start');
    } else {
      window.dispatchEvent(new CustomEvent('fps:game_start', {
        detail: {
          roomCode: this.currentRoomCode || 'LOCAL1',
          players: [
            {
              id: this.localPlayerId || 'local_host',
              name: sessionStorage.getItem('securefps_player_name') || 'Host_Operator',
              isHost: true,
              isReady: true,
              x: 0,
              y: 0,
              z: 28
            }
          ]
        }
      }));
    }
  }

  leaveRoom() {
    this.stopPingHeartbeat();
    if (this.isConnected && this.socket) {
      this.socket.emit('lobby:leave');
    }
    this.currentRoomCode = null;
    this.isHost = false;
    this.isReady = false;
    this.clearRemotePlayers();
    window.dispatchEvent(new CustomEvent('fps:lobby_left'));
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

  update(delta, now, controller) {
    const camera = window.SecureFPSGame?.camera;

    // Interpolate remote player positions
    this.remotePlayers.forEach(p => {
      p.updateInterpolation(delta, camera);
    });

    // Authoritative 30Hz position packet broadcast
    if (this.isConnected && this.socket && controller) {
      if (now - this.lastSyncTime >= this.syncInterval) {
        this.lastSyncTime = now;
        this.socket.emit('player:move', {
          x: parseFloat(controller.position.x.toFixed(2)),
          y: parseFloat(controller.position.y.toFixed(2)),
          z: parseFloat(controller.position.z.toFixed(2)),
          yaw: parseFloat(controller.yaw.toFixed(3)),
          isSprinting: controller.isSprinting,
          isCrouching: controller.isCrouching
        });
      }
    }
  }

  emitFire(start, end, hitPlayerId = null, headshot = false, weaponKey = 'carbine') {
    if (!this.isConnected || !this.socket) return;
    this.socket.emit('player:fire', {
      origin: { x: start.x, y: start.y, z: start.z },
      target: { x: end.x, y: end.y, z: end.z },
      hitPlayerId: hitPlayerId,
      headshot: headshot,
      weaponKey: weaponKey
    });
  }

  renderRemoteShot(data) {
    if (this.audio) this.audio.playGunshot('rifle', true);

    const start = new THREE.Vector3(data.origin.x, data.origin.y, data.origin.z);
    const end = new THREE.Vector3(data.target.x, data.target.y, data.target.z);
    const dist = start.distanceTo(end);

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
