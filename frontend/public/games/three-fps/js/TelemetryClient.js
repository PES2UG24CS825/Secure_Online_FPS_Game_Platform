/**
 * SecureFPS: Real Gameplay Telemetry & ML Anti-Cheat Client
 * Streams authentic player kinematics, aiming angular deltas, and combat
 * events to Flask /api/game-events and processes live ML risk scores.
 * Phase 1 additions: 10Hz aim_sample, target_acquired, weapon_fire aim_error, hit_detail.
 */
class TelemetryClient {
  constructor(apiBase = "") {
    this.apiBase = apiBase || window.APP_CONFIG?.apiBase || (
      (window.location.port === "5000" || window.location.port === "" || window.location.protocol === "https:" || window.location.port === "8080")
        ? `${window.location.origin}/api`
        : `http://${window.location.hostname || "127.0.0.1"}:5000/api`
    );

    this.sessionId = null;
    this.gameToken = null;
    this.isSessionActive = false;
    this.sessionStartPerfTime = null;
    this.alertedViolationTypes = new Set();
    this.sessionStorageKey = 'securefps_telemetry_session_id';
    this.lastMovementSampleTime = 0;
    this.lastAimSampleTime = 0;
    this.lastYaw = 0;
    this.lastPitch = 0;
    this.movementInterval = 2.0; // Every 2.0 seconds (matches Unity PlayerTelemetry.cs)
    this.aimInterval = 0.5;      // Every 0.5 seconds (matches Unity PlayerTelemetry.cs)
    this.aimSampleInterval = 0.1;// Every 0.1 seconds (Phase 1 10Hz kinematics)
    this.lastAimSample10HzTime = 0;
    this.lastSampleYawDeg = 0;
    this.lastSamplePitchDeg = 0;
    this.eventSequence = 0;
    this.eventQueue = [];
    this.batchFlushInterval = 1500;
    this.batchTimer = setInterval(() => this.flushQueue(), this.batchFlushInterval);

    this.initEvents();
  }

  initEvents() {
    // Listen to in-game combat and movement events
    window.addEventListener('fps:telemetry_fire', (e) => {
      this.sendEvent('weapon_fire', {
        weapon: e.detail?.weapon || 'P-24 Carbine',
        shot_id: e.detail?.shot_id || null,
        aim_error_deg: e.detail?.aim_error_deg != null ? Number(e.detail.aim_error_deg) : null,
        target_id: e.detail?.target_id || null
      });
    });

    window.addEventListener('fps:telemetry_hit', (e) => {
      this.sendEvent('enemy_hit', {
        target_id: e.detail?.target || 'bot_target',
        damage: e.detail?.damage || 34,
        headshot: !!e.detail?.headshot,
        shot_id: e.detail?.shot_id || null,
        distance: e.detail?.distance != null ? Number(e.detail.distance) : 10.0,
        visible_through_wall: !!e.detail?.visible_through_wall,
        through_obstacle: !!e.detail?.through_obstacle,
        impossible_hit: !!e.detail?.impossible_hit,
        line_of_sight: e.detail?.line_of_sight !== false,
        player_position: e.detail?.player_position || null,
        target_position: e.detail?.target_position || null
      });
    });

    window.addEventListener('fps:telemetry_hit_detail', (e) => {
      this.sendEvent('hit_detail', {
        target_id: e.detail?.target_id || 'bot_target',
        body_part: e.detail?.body_part || 'body',
        distance: e.detail?.distance != null ? Number(e.detail.distance) : 10.0,
        damage: e.detail?.damage != null ? Number(e.detail.damage) : 34
      });
    });

    window.addEventListener('fps:telemetry_target_acquired', (e) => {
      this.sendEvent('target_acquired', {
        enemy_id: e.detail?.enemy_id || 'bot_target',
        distance: e.detail?.distance != null ? Number(e.detail.distance) : 10.0,
        visible_through_wall: !!e.detail?.visible_through_wall
      });
    });

    window.addEventListener('fps:kill', (e) => {
      this.sendEvent('enemy_killed', {
        enemy: e.detail?.victim || 'bot_target',
        headshot: !!e.detail?.headshot,
        weapon: e.detail?.weapon || null,
        body_part: e.detail?.headshot ? 'head' : (e.detail?.body_part || 'body')
      });
    });

    window.addEventListener("fps:telemetry_death", (e) => {
      this.sendEvent("player_death", {});
      // Reset tracking so respawn jump across map is never calculated as player speed
      this.lastPositionX = undefined;
      this.lastPositionZ = undefined;
      this.lastMovementSampleTime = 0;
    });

    window.addEventListener('fps:game_completed', async (e) => {
      // Immediately stop streaming further kinematic/aim samples
      this.isSessionActive = false;
      // Send final match completion event with verified combat metrics
      if (!e.detail?.completionToken) await this.sendEvent('game_completed', {
        kills: e.detail?.kills || 0,
        deaths: e.detail?.deaths || 0,
        shots: e.detail?.shots || 0,
        hits: e.detail?.hits || 0,
        accuracy: e.detail?.accuracy || 0,
        headshots: e.detail?.headshots || 0,
        kdr: e.detail?.kdr || 0,
        winner: e.detail?.winner || 'Operator'
      });
      // Then finalize backend game session as completed
      await this.endGameSession(true, e.detail || {});
    });
  }

  async startSession(mode = "bots", difficulty = "normal") {
    try {
      if (!this.isSessionActive && sessionStorage.getItem(this.sessionStorageKey)) {
        await this.resumeSession();
      }
      if (this.isSessionActive && this.sessionId) {
        await this.endGameSession(false);
      }
      this.isSessionActive = false;
      this.sessionId = null;
      this.gameToken = null;
      this.eventSequence = 0;
      const response = await fetch(`${this.apiBase}/game/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: 'CyberStrike_3D', mode, difficulty })
      });

      if (!response.ok) {
        console.warn(`[SecureFPS Telemetry] /game/start returned HTTP ${response.status}. Operating in local sandbox mode.`);
        return false;
      }

      const data = await response.json();
      if (data.session_id && data.game_token) {
        this.sessionId = data.session_id;
        this.gameToken = data.game_token;
        this.isSessionActive = true;
        this.sessionStartPerfTime = performance.now() / 1000;
        this.alertedViolationTypes = new Set();
        this.eventSequence = 0;
        sessionStorage.setItem(this.sessionStorageKey, this.sessionId);
        sessionStorage.setItem(`${this.sessionStorageKey}:sequence`, '0');
        console.log(`[SecureFPS Telemetry] Authenticated session started: ${this.sessionId}`);

        // Emit game_started event
        this.sendEvent('game_started', { timestamp: 0 });
        return true;
      }
    } catch (err) {
      console.warn('[SecureFPS Telemetry] Could not reach Flask backend:', err.message);
    }
    return false;
  }

  async resumeSession() {
    if (this.isSessionActive && this.sessionId && this.gameToken) return true;
    const savedSessionId = sessionStorage.getItem(this.sessionStorageKey);
    if (!savedSessionId) return false;

    try {
      const response = await fetch(`${this.apiBase}/game/resume`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: savedSessionId })
      });
      if (response.status === 404) {
        sessionStorage.removeItem(this.sessionStorageKey);
        sessionStorage.removeItem(`${this.sessionStorageKey}:sequence`);
        return false;
      }
      if (!response.ok) throw new Error(`Session resume returned HTTP ${response.status}`);
      const data = await response.json();
      this.sessionId = data.session_id;
      this.gameToken = data.game_token;
      this.eventSequence = Math.max(
        Number(data.event_sequence) || 0,
        Number(sessionStorage.getItem(`${this.sessionStorageKey}:sequence`)) || 0,
      );
      this.isSessionActive = true;
      return true;
    } catch (error) {
      console.warn('[SecureFPS Telemetry] Could not resume the active telemetry session:', error.message);
      return false;
    }
  }

  update(now, controller) {
    if (!this.isSessionActive || !controller) return;

    // 1. Movement Telemetry (sampled every 2.0s with window displacement integration)
    if (now - this.lastMovementSampleTime >= this.movementInterval) {
      const instantaneousSpeed = Math.sqrt(
        controller.velocity.x * controller.velocity.x +
        controller.velocity.z * controller.velocity.z
      );

      // Measure actual ground displacement between sample intervals to prevent zero-readings during micro-pauses
      let integratedSpeed = 0;
      if (this.lastPositionX !== undefined && this.lastPositionZ !== undefined && this.lastMovementSampleTime > 0) {
        const deltaDist = Math.hypot(
          controller.position.x - this.lastPositionX,
          controller.position.z - this.lastPositionZ
        );
        const deltaTime = Math.max(0.001, now - this.lastMovementSampleTime);
        // Integrate continuous movement up to fast sprint/cheat threshold (<= 200 meters per sample)
        const maxDist = (controller.speedMultiplier && controller.speedMultiplier > 1.0) ? 200.0 : 35.0;
        if (deltaDist <= maxDist) {
          integratedSpeed = deltaDist / deltaTime;
        }
      }

      this.lastPositionX = controller.position.x;
      this.lastPositionZ = controller.position.z;
      this.lastMovementSampleTime = now;

      const effectiveSpeed = Math.max(instantaneousSpeed, integratedSpeed);

      this.sendEvent('player_behavior', {
        speed: parseFloat(effectiveSpeed.toFixed(2)),
        position: {
          x: parseFloat(controller.position.x.toFixed(2)),
          y: parseFloat(controller.position.y.toFixed(2)),
          z: parseFloat(controller.position.z.toFixed(2))
        },
        grounded: controller.isGrounded
      });
    }

    // 1b. Fast 10Hz Aim Sampling (every 0.1s, angles in degrees)
    if (now - this.lastAimSample10HzTime >= this.aimSampleInterval) {
      const dt = Math.max(0.001, now - this.lastAimSample10HzTime);
      this.lastAimSample10HzTime = now;
      const yawDeg = ((controller.yaw * (180 / Math.PI)) % 360 + 360) % 360;
      const pitchDeg = Math.max(-90, Math.min(90, controller.pitch * (180 / Math.PI)));
      let dYaw = Math.abs(yawDeg - this.lastSampleYawDeg);
      if (dYaw > 180) dYaw = 360 - dYaw;
      const dPitch = Math.abs(pitchDeg - this.lastSamplePitchDeg);
      const angVel = Math.hypot(dYaw, dPitch) / dt;
      this.lastSampleYawDeg = yawDeg;
      this.lastSamplePitchDeg = pitchDeg;
      this.sendEvent('aim_sample', {
        angular_velocity_deg_s: parseFloat(angVel.toFixed(2)),
        yaw: parseFloat(yawDeg.toFixed(2)),
        pitch: parseFloat(pitchDeg.toFixed(2))
      });
    }

    // 2. Legacy Aim Angular Telemetry (every 0.5 seconds)
    if (now - this.lastAimSampleTime >= this.aimInterval) {
      this.lastAimSampleTime = now;
      const deltaYaw = Math.abs(controller.yaw - this.lastYaw);
      const deltaPitch = Math.abs(controller.pitch - this.lastPitch);
      const rotationChange = deltaYaw + deltaPitch;

      this.lastYaw = controller.yaw;
      this.lastPitch = controller.pitch;

      this.sendEvent('aim_behavior', {
        rotation_change: parseFloat(rotationChange.toFixed(4))
      });
    }
  }

  async sendEvent(eventType, telemetryData = {}) {
    if ((!this.isSessionActive && eventType !== 'game_completed' && eventType !== 'game_started') || !this.sessionId || !this.gameToken) {
      return;
    }

    this.eventSequence = (this.eventSequence || 0) + 1;
    sessionStorage.setItem(`${this.sessionStorageKey}:sequence`, String(this.eventSequence));
    telemetryData.seq = this.eventSequence;
    if (telemetryData.timestamp === undefined) {
      const nowSec = performance.now() / 1000;
      const baseSec = this.sessionStartPerfTime != null ? this.sessionStartPerfTime : nowSec;
      telemetryData.timestamp = parseFloat(Math.max(0, nowSec - baseSec).toFixed(4));
    }

    // Critical match lifecycle events flush and send immediately
    if (eventType === 'game_completed' || eventType === 'game_started') {
      await this.flushQueue();
      const payload = {
        session_id: this.sessionId,
        game_token: this.gameToken,
        event_type: eventType,
        game: 'CyberStrike_3D',
        seq: this.eventSequence,
        timestamp: telemetryData.timestamp,
        telemetry: telemetryData
      };
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        await fetch(`${this.apiBase}/game-events`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
      } catch (e) {}
      return;
    }

    // Queue standard telemetry for batch transmission
    this.eventQueue.push({
      event_type: eventType,
      telemetry: telemetryData,
      seq: this.eventSequence,
      timestamp: telemetryData.timestamp
    });

    const isCriticalCombatEvent = eventType === 'enemy_killed' || eventType === 'player_death' || eventType === 'respawn' || telemetryData.impossible_hit || telemetryData.through_obstacle;
    if (this.eventQueue.length >= 20 || isCriticalCombatEvent) {
      this.flushQueue();
    }
  }

  async flushQueue() {
    if (!this.sessionId || !this.gameToken || this.eventQueue.length === 0) return;
    const batch = this.eventQueue.splice(0, this.eventQueue.length);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      const response = await fetch(`${this.apiBase}/game-events`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.sessionId,
          game_token: this.gameToken,
          game: 'CyberStrike_3D',
          events: batch
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (response.ok) {
        const data = await response.json();
        this.handleDetectionResponse(data);
      } else if (response.status === 429 || response.status >= 500) {
        const critical = batch.filter(ev => ['enemy_killed', 'player_death', 'respawn', 'enemy_hit'].includes(ev.event_type));
        if (critical.length > 0) this.eventQueue.unshift(...critical);
      }
    } catch (err) {
      const critical = batch.filter(ev => ['enemy_killed', 'player_death', 'respawn', 'enemy_hit'].includes(ev.event_type));
      if (critical.length > 0) this.eventQueue.unshift(...critical);
    }
  }

  handleDetectionResponse(data) {
    if (!data) return;

    if (data.banned || data.account_status === 'banned' || data.enforcement_state === 'banned') {
      this.isSessionActive = false;
      window.dispatchEvent(new CustomEvent('fps:cheat_enforce'));
      if (document.exitPointerLock) {
        try { document.exitPointerLock(); } catch (_) {}
      }
      window.location.replace('/login.html?banned=1');
      return;
    }

    // Check Server-Rule Violations & ML Real-time Anti-Cheat Alerts
    const violationMessages = {
      headshot_anomaly: 'Abnormal headshot activity detected.',
      abnormal_speed: 'Abnormal movement speed detected.',
      movement_anomaly: 'Abnormal movement speed detected.',
      impossible_hit: 'Invalid through-wall hit detected.',
      abnormal_fire_rate: 'Abnormal firing rate detected.',
    };

    if (Array.isArray(data.detected_violations) && data.detected_violations.length > 0) {
      for (const v of data.detected_violations) {
        const vType = String(v?.type || 'suspicious_activity');
        if (!this.alertedViolationTypes.has(vType)) {
          this.alertedViolationTypes.add(vType);
          const msg = violationMessages[vType] || 'Suspicious gameplay activity detected.';
          window.updateSecurityAlertBanner?.('server', msg);
        }
      }
    }

    const detection = data.realtime_detection || (data.analysis && data.analysis.result);
    if (detection) {
      window.dispatchEvent(new CustomEvent('fps:ml_risk_update', { detail: detection }));
      const alertTriggered = detection.alert_triggered;
      const isRestricted = data.enforcement_state === 'restricted' || detection.enforcement_state === 'restricted';

      if ((alertTriggered || isRestricted) && !this.alertedViolationTypes.has('ml_realtime_alert')) {
        this.alertedViolationTypes.add('ml_realtime_alert');
        window.updateSecurityAlertBanner?.('server', 'Suspicious gameplay activity detected.');

        if (isRestricted) {
          // Freeze game time on enforcement
          window.dispatchEvent(new CustomEvent('fps:cheat_enforce'));
        }
      }
    }
  }

  async voluntaryExitMatch() {
    if (!this.sessionId) return { success: true, already_closed: true };
    const sessId = this.sessionId;
    this.isSessionActive = false;
    this.sessionId = null;
    this.gameToken = null;
    try {
      const response = await fetch(`${this.apiBase}/game/voluntary-exit`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessId,
          reason: 'voluntary_match_exit'
        })
      });
      const data = await response.json();
      if (response.ok) {
        sessionStorage.removeItem(this.sessionStorageKey);
        sessionStorage.removeItem(`${this.sessionStorageKey}:sequence`);
      }
      console.log('[SecureFPS Telemetry] Voluntary exit processed:', data);
      return data;
    } catch (e) {
      console.warn('[SecureFPS Telemetry] Error processing voluntary exit:', e);
      return { success: false, error: e.message };
    }
  }

  async endGameSession(completed = false, details = {}) {
    if (!this.sessionId) return;
    const sessId = this.sessionId;
    this.isSessionActive = false;

    // Ensure all pending queued telemetry events are flushed to backend before ending session
    try {
      await this.flushQueue();
    } catch (_) {}

    this.sessionId = null;
    this.gameToken = null;
    const body = JSON.stringify({
      session_id: sessId,
      completed,
      completion_token: details.completionToken,
      reason: completed ? 'match_completed' : 'player_exit',
      kills: details.kills || 0,
      deaths: details.deaths || 0,
      shots: details.shots || 0,
      hits: details.hits || 0,
      headshots: details.headshots || 0,
      winner: details.winner,
    });
    const submit = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      try {
        return await fetch(`${this.apiBase}/game/end`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }
    };
    try {
      let response = await submit().catch(error => {
        if (!details.completionToken) throw error;
        return null;
      });
      if (!response || (details.completionToken && response.status >= 500)) response = await submit();
      if (!response.ok) throw new Error(`Match submission returned HTTP ${response.status}`);
      if (sessionStorage.getItem(this.sessionStorageKey) === sessId) {
        sessionStorage.removeItem(this.sessionStorageKey);
        sessionStorage.removeItem(`${this.sessionStorageKey}:sequence`);
      }
      console.log('[SecureFPS Telemetry] Match session successfully finalized (completed=' + completed + ').');
    } catch (e) {
      console.warn('[SecureFPS Telemetry] Error ending game session:', e);
    }
  }
}
