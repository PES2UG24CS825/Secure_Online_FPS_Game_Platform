/**
 * SecureFPS: Intelligent Balanced Dataset-Driven Bot Engine
 * ========================================================
 * Implements humanlike, dataset-grounded bot behavior:
 * - Calibrated from empirical human distributions (cheating_detection_dataset (1).csv, Label == 0).
 * - Personas across 3 skill bands: Easy (~p10-p35), Normal (~p35-p70), Hard (~p70-p95).
 * - Human motor reaction delays (clamped >=150ms with per-engagement jitter).
 * - Humanlike aim tracking with angular turn-rate, overshoot, and convergence over time.
 * - Dynamic combat strafing (bots shoot while moving and strafing, never frozen like robots).
 * - Multi-weapon support (carbine, smg, sniper, pistol) matching character roles.
 * - Positional gunshot audio, muzzle flashes, ballistic tracers, wall impact sparks, and whiz-by audio.
 * - Role-specific behaviors: Flanker (perimeter angles), Marksman (elevated crouch-sniping),
 *   Pointman (aggressive pushes), Scout (rapid roaming).
 * - Non-identical waypoint routes, random pauses, looking around, last-seen position investigation,
 *   and reaction to nearby gunfire.
 * - Free-For-All target arbitration (bots target each other as well as the player).
 * - Debug diagnostics and onPlayerHurt verification counters.
 */

const TACTICAL_ARENA_WAYPOINTS = [
  new THREE.Vector3(-24, 0, -20),  // 0: NW Warehouse entry
  new THREE.Vector3(-14, 0, -22),  // 1: N Perimeter
  new THREE.Vector3(0, 0, -24),    // 2: N Lane
  new THREE.Vector3(14, 0, -22),   // 3: NE Lane
  new THREE.Vector3(26, 0, -18),   // 4: NE Parkour approach
  new THREE.Vector3(26, 0, 0),     // 5: E Perimeter Lane
  new THREE.Vector3(26, 0, 16),    // 6: SE Lane
  new THREE.Vector3(14, 0, 22),    // 7: S Perimeter
  new THREE.Vector3(0, 0, 24),     // 8: S Lane
  new THREE.Vector3(-14, 0, 22),   // 9: SW Lane
  new THREE.Vector3(-26, 0, 16),   // 10: W Shooting range approach
  new THREE.Vector3(-26, 0, 0),    // 11: W Perimeter Lane
  new THREE.Vector3(-12, 0, 0),    // 12: W Courtyard
  new THREE.Vector3(0, 0, -11),    // 13: N Ramp approach
  new THREE.Vector3(0, 2.0, 0),    // 14: Central elevated compound
  new THREE.Vector3(0, 0, 11)      // 15: S Ramp approach
];

const TACTICAL_SPAWN_POINTS = [
  new THREE.Vector3(-22, 0, -18),  // NW Compound
  new THREE.Vector3(22, 0, -18),   // NE Warehouse
  new THREE.Vector3(0, 0, -25),    // Far North Wall
  new THREE.Vector3(-25, 0, 0),    // West Flank
  new THREE.Vector3(25, 0, 0),     // East Flank
  new THREE.Vector3(14, 0, -14),   // NE Courtyard
  new THREE.Vector3(-14, 0, -14),  // NW Courtyard
  new THREE.Vector3(0, 0, -12),    // North Center Corridor
  new THREE.Vector3(-18, 0, -6),   // West Mid Approach
  new THREE.Vector3(18, 0, -6)     // East Mid Approach
];

// Built-in dataset-grounded persona fallback bank
const BUILTIN_FALLBACK_PERSONAS = {
  easy: [
    { id: "p_e1", name: "Specter", role: "pointman", reaction_time_ms: 275, accuracy_pct: 46.5, headshot_ratio_pct: 12.0, fire_rate_s: 5.2, movement_speed_ms: 4.15, aim_smoothness: 0.81, burst_count: 2, burst_interval_s: 0.22, burst_cooldown_s: 2.2 },
    { id: "p_e2", name: "Nomad", role: "flanker", reaction_time_ms: 285, accuracy_pct: 44.0, headshot_ratio_pct: 10.5, fire_rate_s: 5.8, movement_speed_ms: 4.25, aim_smoothness: 0.80, burst_count: 2, burst_interval_s: 0.20, burst_cooldown_s: 2.3 },
    { id: "p_e3", name: "Ranger", role: "marksman", reaction_time_ms: 295, accuracy_pct: 48.0, headshot_ratio_pct: 14.0, fire_rate_s: 4.2, movement_speed_ms: 3.95, aim_smoothness: 0.82, burst_count: 2, burst_interval_s: 0.25, burst_cooldown_s: 2.4 },
    { id: "p_e4", name: "Echo", role: "scout", reaction_time_ms: 270, accuracy_pct: 43.5, headshot_ratio_pct: 11.0, fire_rate_s: 6.0, movement_speed_ms: 4.30, aim_smoothness: 0.81, burst_count: 2, burst_interval_s: 0.19, burst_cooldown_s: 2.1 }
  ],
  normal: [
    { id: "p_n1", name: "Viper", role: "flanker", reaction_time_ms: 245, accuracy_pct: 54.5, headshot_ratio_pct: 19.5, fire_rate_s: 6.0, movement_speed_ms: 4.50, aim_smoothness: 0.85, burst_count: 3, burst_interval_s: 0.17, burst_cooldown_s: 1.6 },
    { id: "p_n2", name: "Valkyrie", role: "marksman", reaction_time_ms: 255, accuracy_pct: 58.0, headshot_ratio_pct: 22.0, fire_rate_s: 4.8, movement_speed_ms: 4.35, aim_smoothness: 0.87, burst_count: 3, burst_interval_s: 0.21, burst_cooldown_s: 1.7 },
    { id: "p_n3", name: "Apex", role: "pointman", reaction_time_ms: 240, accuracy_pct: 53.0, headshot_ratio_pct: 18.0, fire_rate_s: 6.4, movement_speed_ms: 4.55, aim_smoothness: 0.84, burst_count: 3, burst_interval_s: 0.16, burst_cooldown_s: 1.5 },
    { id: "p_n4", name: "Raven", role: "scout", reaction_time_ms: 235, accuracy_pct: 52.0, headshot_ratio_pct: 17.5, fire_rate_s: 6.8, movement_speed_ms: 4.65, aim_smoothness: 0.86, burst_count: 3, burst_interval_s: 0.15, burst_cooldown_s: 1.5 }
  ],
  hard: [
    { id: "p_h1", name: "Reaper", role: "pointman", reaction_time_ms: 195, accuracy_pct: 64.0, headshot_ratio_pct: 26.5, fire_rate_s: 7.2, movement_speed_ms: 4.85, aim_smoothness: 0.90, burst_count: 4, burst_interval_s: 0.14, burst_cooldown_s: 1.2 },
    { id: "p_h2", name: "Wraith", role: "flanker", reaction_time_ms: 185, accuracy_pct: 62.5, headshot_ratio_pct: 25.0, fire_rate_s: 7.5, movement_speed_ms: 4.90, aim_smoothness: 0.89, burst_count: 4, burst_interval_s: 0.13, burst_cooldown_s: 1.1 },
    { id: "p_h3", name: "Titan", role: "marksman", reaction_time_ms: 205, accuracy_pct: 67.5, headshot_ratio_pct: 29.0, fire_rate_s: 5.5, movement_speed_ms: 4.65, aim_smoothness: 0.92, burst_count: 3, burst_interval_s: 0.18, burst_cooldown_s: 1.2 },
    { id: "p_h4", name: "Blitz", role: "scout", reaction_time_ms: 190, accuracy_pct: 61.0, headshot_ratio_pct: 24.0, fire_rate_s: 7.8, movement_speed_ms: 5.00, aim_smoothness: 0.91, burst_count: 4, burst_interval_s: 0.13, burst_cooldown_s: 1.1 }
  ]
};

class Bot {
  constructor(id, name, spawnPos, scene, arena, audio, botManager, isFemale = false, team = 'red', role = 'pointman') {
    this.id = id;
    this.name = name;
    this.isFemale = isFemale;
    this.team = team;
    this.role = role;
    this.spawnPos = spawnPos.clone();
    this.position = spawnPos.clone();
    this.scene = scene;
    this.arena = arena;
    this.audio = audio;
    this.botManager = botManager;

    if (this.arena && typeof this.arena.getGroundHeight === 'function') {
      this.spawnPos.y = this.arena.getGroundHeight(this.spawnPos.x, this.spawnPos.z);
      this.position.y = this.spawnPos.y;
    }

    // Combat Vitals
    this.maxHealth = 100;
    this.health = 100;
    this.isDead = false;
    this.respawnTimer = 0;
    this.respawnDuration = 4.0;
    this.spawnProtectionTimer = 2.5;

    // AI State Machine
    // 'PATROL' | 'INVESTIGATE' | 'ACQUIRING' | 'ENGAGE' | 'ATTACK' | 'RELOAD' | 'DEAD'
    this.state = 'PATROL';
    this.currentSpeed = 0;
    this.targetSpeed = 0;
    this.currentRotation = 0;
    this.targetRotation = 0;

    // Tactical Memory & Hearing
    this.lastSeenPos = null;
    this.lastSeenTimer = 0;
    this.investigateTarget = null;
    this.currentTarget = null;
    this.alertTimer = 0;

    // Tactical Movement & Dynamic Strafing
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 1.0 + Math.random() * 0.8;
    this.pauseTimer = 0;
    this.lookAroundYaw = 0;
    this.lookAroundTimer = 2.0;

    // Combat Cadence & Aim Convergence
    this.reactionTimer = 0;
    this.hasReactionLock = false;
    this.trackingDuration = 0; // Tracks player continuously, tightens aim spread
    this.burstShotsRemaining = 0;
    this.burstShotTimer = 0;
    this.burstCooldownTimer = 0;

    // Magazine & Reload
    this.magCapacity = 30;
    this.currentAmmo = 30;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.reloadDuration = 2.2;

    // Role-specific weapon key
    this.weaponKey = this.role === 'marksman' ? 'sniper' : (this.role === 'flanker' ? 'smg' : 'carbine');

    // Visual Projectile Tracers
    this.activeBotTracers = [];
    this.impactParticles = [];

    // Assign Initial Persona from BotManager Bank
    this.applyPersona(this.botManager.getPersonaForBot(this.id, this.role));

    // Waypoint Routing (Each bot receives a distinct sequence)
    this.setupWaypointRoute();

    // High-Fidelity Tactical Operator 3D Model
    this.operator = new TacticalOperator(this.scene, {
      isEnemy: true,
      team: this.team,
      callsign: this.persona?.callsign ? `${this.persona.callsign}-${this.id.slice(-2)}` : this.name,
      isFemale: this.isFemale,
      position: this.position
    });

    this.operator.bot = this;
    this.operator.root.userData.bot = this;
    this.operator.setWeapon(this.weaponKey);

    this.mesh = this.operator.root;
    this.headMesh = this.operator.headMesh;
    if (this.headMesh) this.headMesh.userData = { bot: this, isHead: true, operator: this.operator };
    this.bodyMesh = this.operator.bodyMesh;
    if (this.bodyMesh) this.bodyMesh.userData = { bot: this, isHead: false, isBody: true, operator: this.operator };
  }

  setupWaypointRoute() {
    // Role-tailored routes preventing all bots walking the same loop
    if (this.role === 'flanker') {
      // Perimeter lane loop (clockwise outer circle)
      this.waypoints = [
        TACTICAL_ARENA_WAYPOINTS[0], TACTICAL_ARENA_WAYPOINTS[1], TACTICAL_ARENA_WAYPOINTS[3],
        TACTICAL_ARENA_WAYPOINTS[4], TACTICAL_ARENA_WAYPOINTS[5], TACTICAL_ARENA_WAYPOINTS[6],
        TACTICAL_ARENA_WAYPOINTS[7], TACTICAL_ARENA_WAYPOINTS[9], TACTICAL_ARENA_WAYPOINTS[10],
        TACTICAL_ARENA_WAYPOINTS[11]
      ];
    } else if (this.role === 'marksman') {
      // Long corridor angles & central elevated compound
      this.waypoints = [
        TACTICAL_ARENA_WAYPOINTS[14], // Central elevated platform
        TACTICAL_ARENA_WAYPOINTS[13], // N Ramp
        TACTICAL_ARENA_WAYPOINTS[2],  // North Lane view
        TACTICAL_ARENA_WAYPOINTS[15], // S Ramp
        TACTICAL_ARENA_WAYPOINTS[8]   // South Lane view
      ];
    } else if (this.role === 'scout') {
      // Rapid zig-zag cross route
      this.waypoints = [
        TACTICAL_ARENA_WAYPOINTS[12], TACTICAL_ARENA_WAYPOINTS[0], TACTICAL_ARENA_WAYPOINTS[13],
        TACTICAL_ARENA_WAYPOINTS[4], TACTICAL_ARENA_WAYPOINTS[14], TACTICAL_ARENA_WAYPOINTS[6],
        TACTICAL_ARENA_WAYPOINTS[15], TACTICAL_ARENA_WAYPOINTS[10]
      ];
    } else {
      // Pointman: Aggressive courtyard & central pushes
      this.waypoints = [
        TACTICAL_ARENA_WAYPOINTS[12], TACTICAL_ARENA_WAYPOINTS[13], TACTICAL_ARENA_WAYPOINTS[14],
        TACTICAL_ARENA_WAYPOINTS[15], TACTICAL_ARENA_WAYPOINTS[8], TACTICAL_ARENA_WAYPOINTS[2]
      ];
    }
    this.currentWaypointIndex = Math.floor(Math.random() * this.waypoints.length);
  }

  applyPersona(persona) {
    this.persona = persona;
    if (!persona) return;

    // Motor reaction time in seconds (clamped >= 150ms)
    this.baseReactionTime = Math.max(0.15, (persona.reaction_time_ms || 240) / 1000.0);
    this.baseAccuracy = (persona.accuracy_pct || 52) / 100.0;
    this.headshotRatio = (persona.headshot_ratio_pct || 18) / 100.0;
    this.fireRate = persona.fire_rate_s || 6.0;
    this.runSpeed = persona.movement_speed_ms || 4.5;
    this.moveSpeed = this.runSpeed * 0.72;
    this.aimSmoothness = persona.aim_smoothness || 0.85;

    this.burstCount = persona.burst_count || 3;
    this.burstInterval = persona.burst_interval_s || 0.16;
    this.burstCooldown = persona.burst_cooldown_s || 1.6;

    if (this.role === 'marksman') {
      this.weaponKey = 'sniper';
      this.burstCount = 1;
      this.burstInterval = 0.8;
      this.burstCooldown = 1.8;
      this.magCapacity = 10;
    } else if (this.role === 'flanker') {
      this.weaponKey = 'smg';
      this.magCapacity = 35;
    } else {
      this.weaponKey = 'carbine';
      this.magCapacity = 30;
    }
    this.currentAmmo = this.magCapacity;
    if (this.operator && typeof this.operator.setWeapon === 'function') {
      this.operator.setWeapon(this.weaponKey);
    }
  }

  notifyHeardGunshot(shotOrigin) {
    if (this.isDead || this.state === 'ATTACK' || this.state === 'ENGAGE') return;
    const dist = this.position.distanceTo(shotOrigin);
    if (dist <= 36.0) {
      // Turn towards sound and enter alert investigation state
      this.investigateTarget = shotOrigin.clone();
      this.alertTimer = 4.5;
      this.state = 'INVESTIGATE';
      this.aimAt(shotOrigin, 1.0);
    }
  }

  updateTracers(delta) {
    for (let i = this.activeBotTracers.length - 1; i >= 0; i--) {
      const tr = this.activeBotTracers[i];
      if (!tr || !tr.mesh) {
        this.activeBotTracers.splice(i, 1);
        continue;
      }
      tr.traveled += tr.speed * delta;
      if (tr.traveled >= tr.totalDistance) {
        if (this.scene) this.scene.remove(tr.mesh);
        if (tr.geo) tr.geo.dispose();
        if (tr.mat) tr.mat.dispose();
        this.activeBotTracers.splice(i, 1);
      } else {
        tr.mesh.position.copy(tr.start).addScaledVector(tr.direction, tr.traveled);
      }
    }

    for (let i = this.impactParticles.length - 1; i >= 0; i--) {
      const p = this.impactParticles[i];
      p.life -= delta;
      if (p.life <= 0) {
        if (this.scene) this.scene.remove(p.mesh);
        if (p.mesh.geometry) p.mesh.geometry.dispose();
        if (p.mesh.material) p.mesh.material.dispose();
        this.impactParticles.splice(i, 1);
      } else {
        p.vel.y -= 9.8 * delta;
        p.mesh.position.addScaledVector(p.vel, delta);
      }
    }
  }

  spawnImpactSpark(point, normal) {
    if (!this.scene || !point) return;
    for (let i = 0; i < 4; i++) {
      const geo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffb703 });
      const p = new THREE.Mesh(geo, mat);
      p.position.copy(point);

      const norm = normal || new THREE.Vector3(0, 1, 0);
      const vel = norm.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 1.5,
        Math.random() * 1.5,
        (Math.random() - 0.5) * 1.5
      )).normalize().multiplyScalar(3.5 + Math.random() * 3.0);

      this.scene.add(p);
      this.impactParticles.push({ mesh: p, vel: vel, life: 0.22 });
    }
  }

  update(delta, playerPos, playerController, camera, gameModeManager, onPlayerHurt) {
    this.updateTracers(delta);

    if (this.botManager.isStopped || (gameModeManager && gameModeManager.isMatchCompleted)) {
      this.currentSpeed = 0;
      this.operator.updateAnimation(delta, 0, true, camera, false, 0);
      return;
    }

    if (this.isDead) {
      this.respawnTimer -= delta;
      this.operator.updateAnimation(delta, 0, true, camera, false, 0);
      if (this.respawnTimer <= 0) {
        this.respawn(playerPos);
      }
      return;
    }

    if (this.spawnProtectionTimer > 0) {
      this.spawnProtectionTimer -= delta;
    }

    // Always clamp to terrain elevation
    if (this.arena && typeof this.arena.getGroundHeight === 'function') {
      this.position.y = this.arena.getGroundHeight(this.position.x, this.position.z);
      this.operator.root.position.copy(this.position);
    }

    // 1. Reload Cycle
    if (this.currentAmmo <= 0 && !this.isReloading) {
      this.isReloading = true;
      this.reloadTimer = this.reloadDuration;
      this.state = 'RELOAD';
    }

    if (this.isReloading) {
      this.reloadTimer -= delta;
      if (this.reloadTimer <= 0) {
        this.isReloading = false;
        this.currentAmmo = this.magCapacity;
        this.state = 'PATROL';
      } else {
        // Continue evasive maneuver while reloading
        this.patrol(delta);
        this.operator.updateAnimation(delta, this.currentSpeed, true, camera, false, 0);
        return;
      }
    }

    // 2. Check player invulnerability (spawn protection or death)
    const isPlayerInvulnerable = (gameModeManager && (gameModeManager.hasSpawnProtection || gameModeManager.isDead)) ||
                                 (playerController && playerController.isDead);

    // 3. Target Arbitration: Select Player or Closest Rival Bot in Free-For-All
    let targetPos = playerPos;
    let distToTarget = this.position.distanceTo(playerPos);

    if (gameModeManager && gameModeManager.currentMode === 'solo') {
      // In FFA Deathmatch, consider rival bots as valid combat targets
      for (const rival of this.botManager.bots) {
        if (rival !== this && !rival.isDead && rival.spawnProtectionTimer <= 0) {
          const d = this.position.distanceTo(rival.position);
          if (d < distToTarget - 4.0 && this.hasLineOfSight(rival.position)) {
            targetPos = rival.position;
            distToTarget = d;
            break;
          }
        }
      }
    }

    // Detection & Line of Sight
    const detectionRange = this.role === 'marksman' ? 48.0 : 36.0;
    const attackRange = this.role === 'marksman' ? 44.0 : 28.0;
    const hasSight = !isPlayerInvulnerable && distToTarget <= detectionRange && this.hasLineOfSight(targetPos);

    if (hasSight) {
      // Target is visible: update last-seen memory
      this.lastSeenPos = targetPos.clone();
      this.lastSeenTimer = 5.0; // 5 seconds persistence
      this.trackingDuration += delta;

      // Human reaction delay with jitter
      if (!this.hasReactionLock) {
        const jitter = (Math.random() - 0.5) * 0.07;
        this.reactionTimer = Math.max(0.15, this.baseReactionTime + jitter);
        this.hasReactionLock = true;
        this.burstCooldownTimer = 0;
        this.burstShotsRemaining = 0;
      }

      // Smooth aim turn-rate based on persona aim smoothness
      this.aimAt(targetPos, delta * (8.0 + this.aimSmoothness * 6.0));

      // Calculate aim pitch for upper body
      const eyeY = this.position.y + 1.4;
      const targetEyeY = targetPos.y + 1.2;
      const aimPitch = Math.atan2(targetEyeY - eyeY, Math.max(0.1, distToTarget));

      if (this.reactionTimer > 0) {
        // Target acquisition phase: Bot takes aim and starts dynamic combat strafe
        this.reactionTimer -= delta;
        this.state = 'ACQUIRING';
        this.combatStrafe(targetPos, delta, this.moveSpeed * 0.85);
        this.operator.updateAnimation(delta, this.currentSpeed, true, camera, this.role === 'marksman', aimPitch);
        return;
      }

      // Combat Engagement
      if (distToTarget <= attackRange) {
        this.state = 'ATTACK';
        // Shoot while strafing (never frozen in place)
        this.combatStrafe(targetPos, delta, this.moveSpeed);
        this.updateBurstCombat(delta, targetPos, onPlayerHurt);
      } else {
        this.state = 'ENGAGE';
        this.moveTowards(targetPos, this.runSpeed, delta);
      }

      const isCrouching = this.role === 'marksman' && distToTarget > 14.0;
      this.operator.updateAnimation(delta, this.currentSpeed, true, camera, isCrouching, aimPitch);

    } else {
      // Line of sight lost
      this.hasReactionLock = false;
      this.reactionTimer = 0;
      this.trackingDuration = 0;

      if (this.lastSeenTimer > 0 && this.lastSeenPos) {
        // 4. Memory Investigation: Move to inspect last known target position
        this.lastSeenTimer -= delta;
        this.state = 'INVESTIGATE';
        const distToLast = this.position.distanceTo(this.lastSeenPos);
        if (distToLast > 2.5) {
          this.moveTowards(this.lastSeenPos, this.moveSpeed, delta);
        } else {
          // Reached last-seen position, scan surroundings
          this.patrolScan(delta);
        }
      } else if (this.alertTimer > 0 && this.investigateTarget) {
        // Heard gunfire: navigate towards sound origin
        this.alertTimer -= delta;
        this.state = 'INVESTIGATE';
        this.moveTowards(this.investigateTarget, this.moveSpeed, delta);
      } else {
        // Normal patrol route
        this.state = 'PATROL';
        this.patrol(delta);
      }

      this.operator.updateAnimation(delta, this.currentSpeed, true, camera, false, 0);
    }
  }

  combatStrafe(targetPos, delta, speed) {
    this.strafeTimer -= delta;
    if (this.strafeTimer <= 0) {
      this.strafeDir *= -1; // Reverse strafe direction
      this.strafeTimer = 0.7 + Math.random() * 1.1;
    }

    const toTarget = targetPos.clone().sub(this.position);
    toTarget.y = 0;
    const dist = toTarget.length();
    toTarget.normalize();

    // Perpendicular vector for strafing
    const strafeVec = new THREE.Vector3(-toTarget.z, 0, toTarget.x).multiplyScalar(this.strafeDir);

    // If too close (<10m), backpedal slightly; if too far (>22m), close in
    let forwardWeight = 0;
    if (dist < 10.0) forwardWeight = -0.35;
    else if (dist > 22.0) forwardWeight = 0.45;

    const moveDir = strafeVec.clone().addScaledVector(toTarget, forwardWeight).normalize();
    const moveStep = moveDir.multiplyScalar(speed * delta);

    const nextX = this.position.x + moveStep.x;
    const nextZ = this.position.z + moveStep.z;

    if (!this.checkCollisionAt(nextX, this.position.z)) this.position.x = nextX;
    if (!this.checkCollisionAt(this.position.x, nextZ)) this.position.z = nextZ;

    this.currentSpeed = speed;
  }

  updateBurstCombat(delta, targetPos, onPlayerHurt) {
    if (this.burstCooldownTimer > 0) {
      this.burstCooldownTimer -= delta;
      return;
    }

    if (this.burstShotsRemaining <= 0) {
      this.burstShotsRemaining = this.burstCount;
      this.burstShotTimer = 0;
    }

    this.burstShotTimer -= delta;
    if (this.burstShotTimer <= 0) {
      this.fireSingleShot(targetPos, onPlayerHurt);
      this.burstShotsRemaining--;
      this.burstShotTimer = this.burstInterval;

      if (this.burstShotsRemaining <= 0) {
        this.burstCooldownTimer = this.burstCooldown;
      }
    }
  }

  fireSingleShot(targetPos, onPlayerHurt) {
    this.currentAmmo = Math.max(0, this.currentAmmo - 1);
    this.botManager.botShotsFiredCount++;

    const muzzlePos = new THREE.Vector3(this.position.x, this.position.y + 1.4, this.position.z);
    const dist = muzzlePos.distanceTo(targetPos);

    // Aim error convergence: Error starts wide (~0.85m) and converges over continuous tracking duration
    const convergenceFactor = Math.max(0.35, Math.exp(-this.trackingDuration * 1.2));
    const spreadAmount = 0.85 * convergenceFactor * (1.1 - this.aimSmoothness * 0.4);

    const aimJitter = new THREE.Vector3(
      (Math.random() - 0.5) * spreadAmount,
      (Math.random() - 0.5) * spreadAmount + 0.85,
      (Math.random() - 0.5) * spreadAmount
    );
    const targetAim = targetPos.clone().add(aimJitter);

    // Trigger visual muzzle flash, point light, and recoil kick
    if (this.operator && typeof this.operator.triggerShoot === 'function') {
      this.operator.triggerShoot();
    }

    // Play positional/attenuated gunshot report
    if (this.audio && typeof this.audio.playPositionalGunshot === 'function') {
      this.audio.playPositionalGunshot(this.weaponKey, dist);
    }

    // Render physical bullet tracer
    this.createBotTracer(muzzlePos, targetAim);

    // Calculate hit probability with range falloff
    const rangeFraction = Math.min(1.0, dist / 32.0);
    const effectiveHitChance = Math.max(0.15, this.baseAccuracy * (1.05 - rangeFraction * 0.35));
    const isHit = Math.random() < effectiveHitChance;

    if (isHit) {
      this.botManager.botHitsCount++;
      const isHeadshot = Math.random() < this.headshotRatio;

      let baseDamage = 14;
      if (this.weaponKey === 'sniper') baseDamage = 42;
      else if (this.weaponKey === 'smg') baseDamage = 11;
      const totalDamage = Math.round(isHeadshot ? baseDamage * 1.75 : baseDamage);

      if (typeof onPlayerHurt === 'function') {
        const botWorldPos = this.mesh ? this.mesh.position.clone() : this.position.clone();
        onPlayerHurt(totalDamage, this.name, botWorldPos);
        this.botManager.playerDamageEventsCount++;
      }
    } else {
      // Miss: Check if bullet narrowly passed near player camera (supersonic whiz-by audio)
      const ray = new THREE.Ray(muzzlePos, targetAim.clone().sub(muzzlePos).normalize());
      const closestPoint = new THREE.Vector3();
      ray.closestPointToPoint(targetPos, closestPoint);
      const missDistance = closestPoint.distanceTo(targetPos);

      if (missDistance < 2.5 && this.audio && typeof this.audio.playBulletWhiz === 'function') {
        this.audio.playBulletWhiz();
      }

      // Check wall impact for spark effects
      this.checkWallImpact(muzzlePos, targetAim);
    }
  }

  checkWallImpact(origin, target) {
    if (!this.arena || !this.arena.colliders) return;
    const dir = target.clone().sub(origin).normalize();
    const ray = new THREE.Ray(origin, dir);
    const box = new THREE.Box3();
    const intersect = new THREE.Vector3();

    for (let i = 0; i < this.arena.colliders.length; i++) {
      const col = this.arena.colliders[i];
      box.min.set(col.minX, col.minY, col.minZ);
      box.max.set(col.maxX, col.maxY, col.maxZ);

      if (ray.intersectBox(box, intersect)) {
        this.spawnImpactSpark(intersect, new THREE.Vector3(0, 1, 0));
        if (this.audio && typeof this.audio.playBulletImpact === 'function') {
          this.audio.playBulletImpact(false);
        }
        break;
      }
    }
  }

  hasLineOfSight(targetPos) {
    const origin = new THREE.Vector3(this.position.x, this.position.y + 1.4, this.position.z);
    const target = new THREE.Vector3(targetPos.x, targetPos.y + 1.2, targetPos.z);
    const dir = target.clone().sub(origin);
    const distanceToTarget = dir.length();
    dir.normalize();

    const ray = new THREE.Ray(origin, dir);
    const box = new THREE.Box3();
    const intersect = new THREE.Vector3();

    if (this.arena && this.arena.colliders) {
      for (let i = 0; i < this.arena.colliders.length; i++) {
        const col = this.arena.colliders[i];
        box.min.set(col.minX, col.minY, col.minZ);
        box.max.set(col.maxX, col.maxY, col.maxZ);

        if (ray.intersectBox(box, intersect)) {
          const distToObstacle = origin.distanceTo(intersect);
          if (distToObstacle < distanceToTarget - 0.35) {
            return false;
          }
        }
      }
    }
    return true;
  }

  aimAt(targetPos, lerpFactor = 1.0) {
    const dir = targetPos.clone().sub(this.position);
    dir.y = 0;
    if (dir.lengthSq() > 0.001) {
      const targetAngle = Math.atan2(dir.x, dir.z);
      if (lerpFactor >= 1.0) {
        this.operator.root.rotation.y = targetAngle;
      } else {
        let diff = targetAngle - this.operator.root.rotation.y;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.operator.root.rotation.y += diff * Math.min(1.0, lerpFactor);
      }
    }
  }

  checkCollisionAt(x, z) {
    if (!this.arena || !this.arena.colliders) return false;
    const r = 0.52;
    const y = this.position.y;

    for (let i = 0; i < this.arena.colliders.length; i++) {
      const col = this.arena.colliders[i];
      if (col.type === 'box') {
        if (y + 1.6 > col.minY && y < col.maxY) {
          if (
            x + r > col.minX &&
            x - r < col.maxX &&
            z + r > col.minZ &&
            z - r < col.maxZ
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  moveTowards(targetPos, speed, delta) {
    const dir = targetPos.clone().sub(this.position);
    dir.y = 0;
    const dist = dir.length();

    if (dist > 1.8) {
      dir.normalize();

      // Bot-to-bot separation repulsion
      const separation = new THREE.Vector3(0, 0, 0);
      if (this.botManager && this.botManager.bots) {
        for (const other of this.botManager.bots) {
          if (other !== this && !other.isDead) {
            const sepDir = this.position.clone().sub(other.position);
            sepDir.y = 0;
            const sepDist = sepDir.length();
            if (sepDist > 0.01 && sepDist < 1.6) {
              separation.add(sepDir.normalize().multiplyScalar((1.6 - sepDist) * 2.0));
            }
          }
        }
      }

      // Smooth acceleration towards target speed
      this.currentSpeed = THREE.MathUtils.lerp(this.currentSpeed, speed, delta * 6.0);
      const moveVec = dir.clone().multiplyScalar(this.currentSpeed * delta).add(separation.multiplyScalar(delta));

      const nextX = this.position.x + moveVec.x;
      const nextZ = this.position.z + moveVec.z;

      if (!this.checkCollisionAt(nextX, this.position.z)) this.position.x = nextX;
      if (!this.checkCollisionAt(this.position.x, nextZ)) this.position.z = nextZ;

      const groundY = this.arena && typeof this.arena.getGroundHeight === 'function'
        ? this.arena.getGroundHeight(this.position.x, this.position.z)
        : 0;
      this.position.y = groundY;

      this.operator.root.position.copy(this.position);
      this.aimAt(targetPos, delta * 10.0);
    } else {
      this.currentSpeed = THREE.MathUtils.lerp(this.currentSpeed, 0, delta * 8.0);
    }
  }

  patrol(delta) {
    if (this.pauseTimer > 0) {
      this.pauseTimer -= delta;
      this.currentSpeed = 0;
      // Look around while paused at waypoint
      this.patrolScan(delta);
      return;
    }

    const targetWp = this.waypoints[this.currentWaypointIndex];
    const dist = this.position.distanceTo(targetWp);

    if (dist < 2.2) {
      // Reached waypoint: Randomly pause to scan or proceed to next
      if (Math.random() < 0.40) {
        this.pauseTimer = 0.8 + Math.random() * 1.4; // Pause 0.8-2.2s
      }
      this.currentWaypointIndex = (this.currentWaypointIndex + 1) % this.waypoints.length;
    } else {
      this.moveTowards(targetWp, this.moveSpeed, delta);
    }
  }

  patrolScan(delta) {
    this.lookAroundTimer -= delta;
    if (this.lookAroundTimer <= 0) {
      this.lookAroundYaw = (Math.random() - 0.5) * 1.2;
      this.lookAroundTimer = 1.5 + Math.random() * 1.5;
    }
    this.operator.root.rotation.y = THREE.MathUtils.lerp(this.operator.root.rotation.y, this.operator.root.rotation.y + this.lookAroundYaw, delta * 2.0);
  }

  createBotTracer(start, end) {
    if (!start || !end) return;
    const totalDistance = start.distanceTo(end);
    if (totalDistance < 0.2) return;
    const direction = end.clone().sub(start).normalize();
    const speed = 210;

    const tracerGeo = new THREE.CylinderGeometry(0.016, 0.012, 0.65, 6);
    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.95 });
    const tracer = new THREE.Mesh(tracerGeo, tracerMat);
    tracer.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    tracer.position.copy(start);

    if (this.scene) this.scene.add(tracer);
    this.activeBotTracers.push({
      mesh: tracer,
      geo: tracerGeo,
      mat: tracerMat,
      start: start.clone(),
      end: end.clone(),
      direction,
      speed,
      totalDistance,
      traveled: 0
    });
  }

  takeDamage(amount, isHeadshot) {
    if (this.isDead || this.spawnProtectionTimer > 0) return false;

    this.health = Math.max(0, this.health - amount);
    let isFatal = false;
    if (this.operator && typeof this.operator.takeDamage === 'function') {
      isFatal = this.operator.takeDamage(amount, isHeadshot);
    }

    if (isFatal || this.health <= 0) {
      this.die();
      return true;
    }
    return false;
  }

  die() {
    this.isDead = true;
    this.respawnTimer = this.respawnDuration;
    this.currentSpeed = 0;
    if (this.operator && typeof this.operator.die === 'function') {
      this.operator.die();
    }
  }

  respawn(playerPos) {
    this.isDead = false;
    this.health = this.maxHealth;
    this.currentAmmo = this.magCapacity;
    this.isReloading = false;
    this.spawnProtectionTimer = 2.5;

    const newPos = this.botManager.getValidSpawnPoint(playerPos, this.id);
    this.position.copy(newPos);
    this.spawnPos.copy(newPos);

    if (this.arena && typeof this.arena.getGroundHeight === 'function') {
      this.position.y = this.arena.getGroundHeight(this.position.x, this.position.z);
    }

    this.reactionTimer = 0;
    this.hasReactionLock = false;
    this.trackingDuration = 0;
    this.burstShotsRemaining = 0;
    this.burstCooldownTimer = 0;
    this.currentSpeed = 0;
    this.lastSeenPos = null;
    this.lastSeenTimer = 0;

    // Re-assign fresh persona from current difficulty
    this.applyPersona(this.botManager.getPersonaForBot(this.id, this.role));
    this.setupWaypointRoute();

    if (this.operator && typeof this.operator.respawn === 'function') {
      this.operator.respawn(this.position);
    }
  }
}

class BotManager {
  constructor(scene, arena, audio) {
    this.scene = scene;
    this.arena = arena;
    this.audio = audio;
    this.bots = [];
    this.difficulty = 'normal';
    this.isStopped = false;
    this.isEnabled = true;

    // Diagnostic verification counters
    this.playerDamageEventsCount = 0;
    this.botShotsFiredCount = 0;
    this.botHitsCount = 0;

    // Dataset Persona Bank
    this.loadedPersonas = null;
    this.loadPersonas();

    this.initBots();
  }

  async loadPersonas() {
    try {
      const resp = await fetch('data/bot_profiles.json');
      if (resp.ok) {
        const data = await resp.json();
        this.loadedPersonas = data.difficulty_bands;
        console.log('[BotManager] Loaded 64 dataset-driven bot personas from data/bot_profiles.json');
        // Refresh active personas for living bots
        this.bots.forEach(bot => {
          bot.applyPersona(this.getPersonaForBot(bot.id, bot.role));
        });
      }
    } catch (_) {
      console.log('[BotManager] Using built-in empirical dataset personas.');
    }
  }

  getPersonaForBot(botId, role) {
    const band = (this.loadedPersonas && this.loadedPersonas[this.difficulty]) ||
                 BUILTIN_FALLBACK_PERSONAS[this.difficulty] ||
                 BUILTIN_FALLBACK_PERSONAS.normal;

    const matching = band.filter(p => p.role === role);
    if (matching.length > 0) {
      return matching[Math.floor(Math.random() * matching.length)];
    }
    return band[Math.floor(Math.random() * band.length)];
  }

  initBots() {
    const botConfigs = [
      { id: 'bot_alpha', name: 'Viper-01', pos: new THREE.Vector3(-18, 0, -14), isFemale: false, team: 'red', role: 'flanker' },
      { id: 'bot_bravo', name: 'Valkyrie-02', pos: new THREE.Vector3(18, 0, -14), isFemale: true, team: 'red', role: 'marksman' },
      { id: 'bot_charlie', name: 'Apex-03', pos: new THREE.Vector3(0, 0, -25), isFemale: false, team: 'red', role: 'pointman' },
      { id: 'bot_delta', name: 'Raven-04', pos: new THREE.Vector3(-22, 0, -18), isFemale: true, team: 'red', role: 'scout' }
    ];

    botConfigs.forEach(cfg => {
      const bot = new Bot(cfg.id, cfg.name, cfg.pos, this.scene, this.arena, this.audio, this, cfg.isFemale, cfg.team, cfg.role);
      this.bots.push(bot);
    });
  }

  getValidSpawnPoint(playerPos, currentBotId) {
    const pPos = playerPos || new THREE.Vector3(0, 0, 0);
    const candidates = [];

    for (let i = 0; i < TACTICAL_SPAWN_POINTS.length; i++) {
      const pt = TACTICAL_SPAWN_POINTS[i];
      const distToPlayer = pt.distanceTo(pPos);

      // Must be at least 18 meters from player
      if (distToPlayer < 18.0) continue;

      // Must be at least 7 meters from other living bots
      let tooClose = false;
      for (const bot of this.bots) {
        if (bot.id !== currentBotId && !bot.isDead) {
          if (bot.position.distanceTo(pt) < 7.0) {
            tooClose = true;
            break;
          }
        }
      }

      if (!tooClose) candidates.push(pt);
    }

    if (candidates.length > 0) {
      const chosen = candidates[Math.floor(Math.random() * candidates.length)].clone();
      if (this.arena && typeof this.arena.getGroundHeight === 'function') {
        chosen.y = this.arena.getGroundHeight(chosen.x, chosen.z);
      }
      return chosen;
    }

    let maxDist = -1;
    let furthest = TACTICAL_SPAWN_POINTS[0];
    TACTICAL_SPAWN_POINTS.forEach(pt => {
      const d = pt.distanceTo(pPos);
      if (d > maxDist) {
        maxDist = d;
        furthest = pt;
      }
    });

    const fallback = furthest.clone();
    if (this.arena && typeof this.arena.getGroundHeight === 'function') {
      fallback.y = this.arena.getGroundHeight(fallback.x, fallback.z);
    }
    return fallback;
  }

  setDifficulty(diff) {
    const valid = ['easy', 'normal', 'hard'];
    if (valid.includes(diff)) {
      this.difficulty = diff;
      this.bots.forEach(bot => {
        bot.applyPersona(this.getPersonaForBot(bot.id, bot.role));
      });
      console.log(`[SecureFPS AI] Calibrated bot skill band to: ${diff.toUpperCase()}`);
    }
  }

  getCurrentProfile() {
    return {
      name: this.difficulty,
      maxAttackers: this.bots.length // No artificial bottleneck cap
    };
  }

  requestAttackToken() {
    return true; // No artificial attack cap; bots engage balanced by human reaction & accuracy
  }

  releaseAttackToken() {}

  notifyGunshot(shotOrigin) {
    this.bots.forEach(bot => {
      bot.notifyHeardGunshot(shotOrigin);
    });
  }

  stopAllBots() {
    this.isStopped = true;
    this.bots.forEach(bot => {
      bot.currentSpeed = 0;
      bot.state = 'PATROL';
      bot.hasReactionLock = false;
      bot.burstShotsRemaining = 0;
      bot.burstCooldownTimer = 0;
    });
  }

  resumeAllBots() {
    this.isStopped = false;
  }

  resetAllBots(playerPos) {
    this.isStopped = false;
    const pPos = playerPos || new THREE.Vector3(0, 1.8, 28);
    this.bots.forEach(bot => {
      bot.respawn(pPos);
    });
  }

  setEnabled(enabled) {
    this.isEnabled = enabled;
    this.bots.forEach(bot => {
      if (bot.operator && bot.operator.root) {
        bot.operator.root.visible = enabled;
      }
    });
  }

  getHitboxMeshes() {
    if (!this.isEnabled || this.isStopped) return [];
    const hitboxes = [];
    this.bots.forEach(bot => {
      if (!bot.isDead && bot.operator) {
        if (bot.operator.headMesh) hitboxes.push(bot.operator.headMesh);
        if (bot.operator.bodyMesh) hitboxes.push(bot.operator.bodyMesh);
      }
    });
    return hitboxes;
  }

  update(delta, playerPos, playerController, camera, gameModeManager, onPlayerHurt) {
    if (!this.isEnabled || this.isStopped) return;
    this.bots.forEach(bot => {
      bot.update(delta, playerPos, playerController, camera, gameModeManager, onPlayerHurt);
    });
  }

  getDebugReport() {
    return {
      difficulty: this.difficulty,
      playerDamageEventsCount: this.playerDamageEventsCount,
      botShotsFiredCount: this.botShotsFiredCount,
      botHitsCount: this.botHitsCount,
      overallHitRate: this.botShotsFiredCount > 0 ? (this.botHitsCount / this.botShotsFiredCount).toFixed(3) : '0.000',
      bots: this.bots.map(b => ({
        id: b.id,
        name: b.name,
        role: b.role,
        state: b.state,
        hp: b.health,
        weapon: b.weaponKey,
        reactionDelayMs: (b.baseReactionTime * 1000).toFixed(0),
        accuracyPct: (b.baseAccuracy * 100).toFixed(1),
        speed: b.currentSpeed.toFixed(2),
        pos: `(${b.position.x.toFixed(1)}, ${b.position.z.toFixed(1)})`
      }))
    };
  }
}

// Global debug exposure
window.debugBots = function() {
  if (window.SecureFPSGame?.botManager) {
    console.table(window.SecureFPSGame.botManager.getDebugReport().bots);
    console.log('[BotManager Summary]', window.SecureFPSGame.botManager.getDebugReport());
  } else {
    console.log('[BotManager] Not initialized yet.');
  }
};
