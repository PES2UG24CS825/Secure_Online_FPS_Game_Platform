/**
 * SecureFPS: Real Gameplay Telemetry & ML Anti-Cheat Client
 * Streams authentic player kinematics, aiming angular deltas, and combat
 * events to Flask /api/game-events and processes live ML risk scores.
 */
class TelemetryClient {
  constructor(apiBase = "") {
    this.apiBase = apiBase || (window.location.port === "5000"
      ? `${window.location.origin}/api`
      : `http://${window.location.hostname || "127.0.0.1"}:5000/api`);

    this.sessionId = null;
    this.gameToken = null;
    this.isSessionActive = false;
    this.lastMovementSampleTime = 0;
    this.lastAimSampleTime = 0;
    this.lastYaw = 0;
    this.lastPitch = 0;
    this.movementInterval = 2.0; // Every 2.0 seconds (matches Unity PlayerTelemetry.cs)
    this.aimInterval = 0.5;      // Every 0.5 seconds (matches Unity PlayerTelemetry.cs)

    this.initEvents();
  }

  initEvents() {
    // Listen to in-game combat and movement events
    window.addEventListener('fps:telemetry_fire', (e) => {
      this.sendEvent('weapon_fire', {
        weapon: e.detail?.weapon || 'P-24 Carbine',
        timestamp: performance.now() / 1000
      });
    });

    window.addEventListener('fps:telemetry_hit', (e) => {
      this.sendEvent('enemy_hit', {
        target_id: e.detail?.target || 'bot_target',
        damage: e.detail?.damage || 34,
        headshot: !!e.detail?.headshot,
        timestamp: performance.now() / 1000
      });
    });

    window.addEventListener('fps:kill', (e) => {
      this.sendEvent('enemy_killed', {
        enemy: e.detail?.victim || 'bot_target'
      });
    });

    window.addEventListener('fps:telemetry_death', (e) => {
      this.sendEvent('player_death', {});
    });

    window.addEventListener('fps:game_completed', async (e) => {
      // Immediately stop streaming further kinematic/aim samples
      this.isSessionActive = false;
      // Send final match completion event with verified combat metrics
      await this.sendEvent('game_completed', {
        kills: e.detail?.kills || 0,
        deaths: e.detail?.deaths || 0,
        shots: e.detail?.shots || 0,
        hits: e.detail?.hits || 0,
        accuracy: e.detail?.accuracy || 0,
        kdr: e.detail?.kdr || 0,
        winner: e.detail?.winner || 'Operator'
      });
      // Then finalize backend game session as completed
      await this.endGameSession(true, e.detail || {});
    });
  }

  async startSession() {
    try {
      if (this.isSessionActive && this.sessionId) {
        await this.endGameSession(false);
      }
      this.isSessionActive = false;
      this.sessionId = null;
      this.gameToken = null;
      const response = await fetch(`${this.apiBase}/game/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: 'CyberStrike_3D' })
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
        console.log(`[SecureFPS Telemetry] Authenticated session started: ${this.sessionId}`);

        // Emit game_started event
        this.sendEvent('game_started', {});
        return true;
      }
    } catch (err) {
      console.warn('[SecureFPS Telemetry] Could not reach Flask backend:', err.message);
    }
    return false;
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
        integratedSpeed = deltaDist / deltaTime;
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

    // 2. Aim Angular Telemetry (every 0.5 seconds)
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

    const payload = {
      session_id: this.sessionId,
      game_token: this.gameToken,
      event_type: eventType,
      game: 'CyberStrike_3D',
      telemetry: telemetryData
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${this.apiBase}/game-events`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        this.handleDetectionResponse(data);
      }
    } catch (err) {
      // Non-blocking telemetry network logging - never disrupts gameplay
    }
  }

  handleDetectionResponse(data) {
    if (!data) return;

    // Check ML Real-time Anti-Cheat Alerts
    const detection = data.realtime_detection || (data.analysis && data.analysis.result);
    if (detection) {
      const riskScore = detection.risk_score;
      const alertTriggered = detection.alert_triggered;
      const isRestricted = data.enforcement_state === 'restricted' || detection.enforcement_state === 'restricted';

      if (alertTriggered || isRestricted) {
        const banner = document.getElementById('cheat-alert-banner');
        if (banner) {
          banner.style.display = 'block';
          banner.textContent = isRestricted
            ? `SESSION RESTRICTED: Anti-Cheat flagged suspicious gameplay (Risk: ${riskScore || 85}/100)`
            : `SUSPICIOUS GAMEPLAY DETECTED: Risk Score ${riskScore || 50}/100. Session is under review.`;
        }

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
    this.sessionId = null;
    this.gameToken = null;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      await fetch(`${this.apiBase}/game/end`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessId,
          completed: completed,
          reason: completed ? 'match_completed' : 'player_exit',
          kills: details.kills || 0,
          deaths: details.deaths || 0,
          accuracy: details.accuracy || 0
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      console.log('[SecureFPS Telemetry] Match session successfully finalized (completed=' + completed + ').');
    } catch (e) {
      console.warn('[SecureFPS Telemetry] Error ending game session:', e);
    }
  }
}
