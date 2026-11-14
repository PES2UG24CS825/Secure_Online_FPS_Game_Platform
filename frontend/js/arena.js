/**
 * SecureFPS: WebGL Arena Telemetry & Relay Client (frontend/js/arena.js)
 * Manages client-side kinematic tracking, angular rate sampling (10Hz),
 * view-cone target acquisition, and weapon hit telemetry.
 * All angles in DEGREES, all times in SECONDS.
 */

class ArenaTelemetryClient {
  constructor(options = {}) {
    this.apiBase = options.apiBase || (window.location && window.location.port === "5000"
      ? `${window.location.origin}/api`
      : `http://${(window.location && window.location.hostname) || "127.0.0.1"}:5000/api`);
    this.relayWsUrl = options.relayWsUrl || `ws://${(window.location && window.location.hostname) || "127.0.0.1"}:8765`;

    this.sessionId = options.sessionId || null;
    this.gameToken = options.gameToken || null;
    this.userId = options.userId || null;
    this.playerGroup = options.playerGroup || "default_group";
    this.recordSession = !!options.recordSession;

    this.isSessionActive = false;
    this.seq = 0;
    this.ws = null;
    this.useRelay = !!options.useRelay;

    // Sampling intervals (seconds)
    this.aimSampleInterval = 0.1; // 100ms (10Hz)
    this.movementInterval = 2.0;
    this.legacyAimInterval = 0.5;

    // Trackers
    this.lastAimSampleTime = 0;
    this.lastMovementSampleTime = 0;
    this.lastLegacyAimTime = 0;
    this.lastYawDeg = 0;
    this.lastPitchDeg = 0;
    this.lastPosX = undefined;
    this.lastPosY = undefined;
    this.lastPosZ = undefined;

    // Target tracking set
    this.acquiredTargets = new Set();

    this.initEvents();
  }

  initEvents() {
    if (typeof window === "undefined") return;

    window.addEventListener("arena:fire", (e) => {
      this.sendWeaponFire(
        e.detail?.weapon || "P-24 Carbine",
        e.detail?.aim_error_deg != null ? Number(e.detail.aim_error_deg) : null,
        e.detail?.target_id || null
      );
    });

    window.addEventListener("arena:hit_detail", (e) => {
      this.sendHitDetail(
        e.detail?.target_id || "enemy",
        e.detail?.body_part || "body",
        Number(e.detail?.distance || 0),
        Number(e.detail?.damage || 0)
      );
    });

    window.addEventListener("arena:target_acquired", (e) => {
      this.sendTargetAcquired(
        e.detail?.enemy_id || "enemy",
        Number(e.detail?.distance || 0),
        !!e.detail?.visible_through_wall
      );
    });

    window.addEventListener("arena:player_death", () => {
      this.sendEvent("player_death", {});
      this.lastPosX = undefined;
      this.lastPosZ = undefined;
    });

    window.addEventListener("arena:game_completed", async (e) => {
      this.isSessionActive = false;
      await this.sendEvent("game_completed", {
        kills: e.detail?.kills || 0,
        deaths: e.detail?.deaths || 0,
        shots: e.detail?.shots || 0,
        hits: e.detail?.hits || 0,
        accuracy: e.detail?.accuracy || 0,
        kdr: e.detail?.kdr || 0
      });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
    });
  }

  async startSession(record = false) {
    this.recordSession = record;
    this.seq = 0;
    this.acquiredTargets.clear();

    try {
      const response = await fetch(`${this.apiBase}/game/start`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game: "WebGL_Arena",
          record_session: this.recordSession
        })
      });

      if (!response.ok) {
        console.warn(`[ArenaTelemetry] /game/start failed with status ${response.status}`);
        return false;
      }

      const data = await response.json();
      if (data.session_id && data.game_token) {
        this.sessionId = data.session_id;
        this.gameToken = data.game_token;
        this.isSessionActive = true;

        if (this.useRelay && typeof WebSocket !== "undefined") {
          this.connectRelay();
        }

        await this.sendEvent("game_started", {});
        return true;
      }
    } catch (err) {
      console.warn("[ArenaTelemetry] Backend connection error:", err.message);
    }
    return false;
  }

  connectRelay() {
    try {
      this.ws = new WebSocket(this.relayWsUrl);
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({
          action: "register_session",
          session_id: this.sessionId,
          user_id: this.userId,
          player_group: this.playerGroup,
          record_session: this.recordSession
        }));
      };
    } catch (e) {
      console.warn("[ArenaTelemetry] WebSocket relay connection failed:", e);
    }
  }

  update(nowSeconds, controller) {
    if (!this.isSessionActive || !controller) return;

    // 1. AIM SAMPLE every 0.1 seconds (10 Hz)
    // Angles in DEGREES, angular velocity in DEG/S
    if (nowSeconds - this.lastAimSampleTime >= this.aimSampleInterval) {
      const dt = Math.max(0.001, nowSeconds - this.lastAimSampleTime);
      this.lastAimSampleTime = nowSeconds;

      const yawDeg = ((controller.yaw * (180 / Math.PI)) % 360 + 360) % 360;
      const pitchDeg = Math.max(-90, Math.min(90, controller.pitch * (180 / Math.PI)));

      let deltaYaw = Math.abs(yawDeg - this.lastYawDeg);
      if (deltaYaw > 180) deltaYaw = 360 - deltaYaw;
      const deltaPitch = Math.abs(pitchDeg - this.lastPitchDeg);

      const angularDistDeg = Math.hypot(deltaYaw, deltaPitch);
      const angularVelocityDegS = angularDistDeg / dt;

      this.lastYawDeg = yawDeg;
      this.lastPitchDeg = pitchDeg;

      this.sendAimSample(angularVelocityDegS, yawDeg, pitchDeg);
    }

    // 2. Legacy AIM BEHAVIOR (every 0.5s) for backward compatibility
    if (nowSeconds - this.lastLegacyAimTime >= this.legacyAimInterval) {
      this.lastLegacyAimTime = nowSeconds;
      const rotChange = Math.abs(controller.yaw - (this.lastLegacyYaw || 0)) +
                        Math.abs(controller.pitch - (this.lastLegacyPitch || 0));
      this.lastLegacyYaw = controller.yaw;
      this.lastLegacyPitch = controller.pitch;
      this.sendEvent("aim_behavior", {
        rotation_change: parseFloat(rotChange.toFixed(4))
      });
    }

    // 3. MOVEMENT BEHAVIOR (every 2.0s)
    if (nowSeconds - this.lastMovementSampleTime >= this.movementInterval) {
      const dt = Math.max(0.001, nowSeconds - this.lastMovementSampleTime);
      this.lastMovementSampleTime = nowSeconds;

      const currX = controller.position?.x || 0;
      const currY = controller.position?.y || 0;
      const currZ = controller.position?.z || 0;

      let speed = 0;
      if (this.lastPosX !== undefined) {
        const dist = Math.hypot(currX - this.lastPosX, currZ - this.lastPosZ);
        speed = dist / dt;
      }

      this.lastPosX = currX;
      this.lastPosY = currY;
      this.lastPosZ = currZ;

      this.sendEvent("player_behavior", {
        speed: parseFloat(speed.toFixed(2)),
        position: {
          x: parseFloat(currX.toFixed(2)),
          y: parseFloat(currY.toFixed(2)),
          z: parseFloat(currZ.toFixed(2))
        },
        grounded: controller.isGrounded !== false
      });
    }
  }

  sendAimSample(angularVelocityDegS, yawDeg, pitchDeg) {
    this.sendEvent("aim_sample", {
      angular_velocity_deg_s: parseFloat(angularVelocityDegS.toFixed(2)),
      yaw: parseFloat(yawDeg.toFixed(2)),
      pitch: parseFloat(pitchDeg.toFixed(2))
    });
  }

  sendTargetAcquired(enemyId, distance, visibleThroughWall = false) {
    this.sendEvent("target_acquired", {
      enemy_id: String(enemyId),
      distance: parseFloat(distance.toFixed(2)),
      visible_through_wall: Boolean(visibleThroughWall)
    });
  }

  sendWeaponFire(weaponName = "P-24 Carbine", aimErrorDeg = null, targetId = null) {
    this.sendEvent("weapon_fire", {
      weapon: String(weaponName),
      aim_error_deg: aimErrorDeg != null ? parseFloat(Number(aimErrorDeg).toFixed(2)) : null,
      target_id: targetId ? String(targetId) : null
    });
  }

  sendHitDetail(targetId, bodyPart = "body", distance = 10.0, damage = 34.0) {
    const validParts = ["head", "body", "limb"];
    const bp = validParts.includes(bodyPart) ? bodyPart : "body";

    this.sendEvent("hit_detail", {
      target_id: String(targetId),
      body_part: bp,
      distance: parseFloat(Number(distance).toFixed(2)),
      damage: parseFloat(Number(damage).toFixed(2))
    });

    // Also dispatch legacy enemy_hit for backward compatibility
    this.sendEvent("enemy_hit", {
      target_id: String(targetId),
      damage: parseFloat(Number(damage).toFixed(2)),
      headshot: bp === "head"
    });
  }

  async sendEvent(eventType, telemetryData = {}) {
    if (!this.isSessionActive && eventType !== "game_completed" && eventType !== "game_started") {
      return;
    }

    this.seq += 1;
    const nowSec = typeof performance !== "undefined" ? performance.now() / 1000 : Date.now() / 1000;
    telemetryData.seq = this.seq;
    telemetryData.timestamp = parseFloat(nowSec.toFixed(4));

    // Relay WebSocket send if connected
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        action: "telemetry_event",
        session_id: this.sessionId,
        event_type: eventType,
        telemetry: telemetryData
      }));
    }

    // HTTP /api/game-events post
    if (!this.sessionId || !this.gameToken) return;

    const payload = {
      session_id: this.sessionId,
      game_token: this.gameToken,
      event_type: eventType,
      game: "WebGL_Arena",
      seq: this.seq,
      timestamp: telemetryData.timestamp,
      telemetry: telemetryData
    };

    try {
      await fetch(`${this.apiBase}/game-events`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      // Non-blocking telemetry
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ArenaTelemetryClient };
} else if (typeof window !== "undefined") {
  window.ArenaTelemetryClient = ArenaTelemetryClient;
}
