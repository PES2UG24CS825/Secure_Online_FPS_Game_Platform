/**
 * SecureFPS: Intelligent Balanced Enemy AI Bot & Combat System
 * Spawns and manages tactical combat bots with realistic adult TacticalOperator 3D characters,
 * skeletal animations, balanced difficulty profiles (Easy, Normal, Hard), concurrent attack token
 * arbitration, human-like reaction delays, realistic burst firing, magazine reload cycles,
 * dynamic multi-point randomized spawn selection, line-of-sight obstruction detection,
 * bot-to-bot separation, and full match completion cessation.
 */

const DIFFICULTY_PROFILES = {
  easy: {
    name: 'Easy',
    maxAttackers: 1,
    reactionDelayMin: 2.2,
    reactionDelayMax: 3.2,
    hitChanceBase: 0.25,
    damage: 8,
    burstCount: 2,
    burstInterval: 0.35,
    burstCooldown: 2.5,
    detectionRange: 28.0,
    attackRange: 20.0
  },
  normal: {
    name: 'Normal',
    maxAttackers: 2,
    reactionDelayMin: 1.5,
    reactionDelayMax: 2.2,
    hitChanceBase: 0.38,
    damage: 12,
    burstCount: 3,
    burstInterval: 0.26,
    burstCooldown: 1.8,
    detectionRange: 34.0,
    attackRange: 24.0
  },
  hard: {
    name: 'Hard',
    maxAttackers: 4,
    reactionDelayMin: 0.9,
    reactionDelayMax: 1.4,
    hitChanceBase: 0.52,
    damage: 16,
    burstCount: 3,
    burstInterval: 0.20,
    burstCooldown: 1.2,
    detectionRange: 40.0,
    attackRange: 28.0
  }
};

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

const TACTICAL_ARENA_WAYPOINTS = [
  new THREE.Vector3(-24, 0, -20),  // NW Warehouse entry
  new THREE.Vector3(-14, 0, -22),  // N Perimeter
  new THREE.Vector3(0, 0, -24),    // N Lane
  new THREE.Vector3(14, 0, -22),   // NE Lane
  new THREE.Vector3(26, 0, -18),   // NE Parkour approach
  new THREE.Vector3(26, 0, 0),     // E Perimeter Lane
  new THREE.Vector3(26, 0, 16),    // SE Lane
  new THREE.Vector3(14, 0, 22),    // S Perimeter
  new THREE.Vector3(0, 0, 24),     // S Lane
  new THREE.Vector3(-14, 0, 22),   // SW Lane
  new THREE.Vector3(-26, 0, 16),   // W Shooting range approach
  new THREE.Vector3(-26, 0, 0),    // W Perimeter Lane
  new THREE.Vector3(-12, 0, 0),    // W Courtyard
  new THREE.Vector3(0, 0, -11),    // N Ramp approach
  new THREE.Vector3(0, 2.0, 0),    // Central elevated compound
  new THREE.Vector3(0, 0, 11)      // S Ramp approach
];

class Bot {
  constructor(id, name, spawnPos, scene, arena, audio, botManager, isFemale = false, team = 'red', role = 'assault') {
    this.id = id;
    this.name = name;
    this.isFemale = isFemale;
    this.team = team;
    this.role = role; // 'flanker', 'marksman', 'pointman', 'scout'
    this.spawnPos = spawnPos.clone();
    this.position = spawnPos.clone();
    this.scene = scene;
    this.arena = arena;
    this.audio = audio;
    this.botManager = botManager;

    // Ground clamp spawn position
    if (this.arena && typeof this.arena.getGroundHeight === 'function') {
      this.spawnPos.y = this.arena.getGroundHeight(this.spawnPos.x, this.spawnPos.z);
      this.position.y = this.spawnPos.y;
    }

    // Combat Stats
    this.maxHealth = 100;
    this.health = 100;
    this.isDead = false;
    this.respawnTimer = 0;
    this.respawnDuration = 4.5;
    this.spawnProtectionTimer = 3.0; // 3-second spawn protection

    // AI Behavior Settings & State
    this.state = 'PATROL'; // PATROL, ACQUIRING, ENGAGE, ATTACK, RELOAD, DEAD
    this.moveSpeed = role === 'flanker' ? 4.0 : (role === 'scout' ? 3.8 : 3.4);
    this.runSpeed = role === 'flanker' ? 5.8 : (role === 'scout' ? 5.6 : 5.2);
    this.currentSpeed = 0;

    // Weapon Ammunition & Reload System
    this.magCapacity = 30;
    this.currentAmmo = 30;
    this.isReloading = false;
    this.reloadDuration = 2.4;
    this.reloadTimer = 0;

    // Humanoid Reaction & Burst Firing Mechanics
    this.reactionTimer = 0;
    this.hasReactionLock = false;
    this.burstShotsRemaining = 0;
    this.burstShotTimer = 0;
    this.burstCooldownTimer = 0;

    // Tactical Patrolling Waypoints (Subset distributed per bot)
    this.waypoints = TACTICAL_ARENA_WAYPOINTS.slice();
    this.currentWaypointIndex = Math.floor(Math.random() * this.waypoints.length);

    // Dedicated Bot Visual Tracers Collection
    this.activeBotTracers = [];

    // Realistic Adult Tactical Operator 3D Model
    this.operator = new TacticalOperator(this.scene, {
      isEnemy: true,
      team: this.team,
      callsign: this.name,
      isFemale: this.isFemale,
      position: this.position
    });

    this.mesh = this.operator.root;
    this.headMesh = this.operator.headMesh;
    if (this.headMesh) this.headMesh.userData = { bot: this, isHead: true };
    this.bodyMesh = this.operator.bodyMesh;
    if (this.bodyMesh) this.bodyMesh.userData = { bot: this, isHead: false };

    // Tag all operator meshes so raycasts reliably detect hits on any body part
    if (this.operator && this.operator.root && typeof this.operator.root.traverse === 'function') {
      this.operator.bot = this;
      this.operator.root.traverse((child) => {
        if (child.isMesh) {
          child.userData = child.userData || {};
          child.userData.bot = this;
          if (child === this.headMesh || child.name?.toLowerCase().includes('head') || child.name?.toLowerCase().includes('helmet')) {
            child.userData.isHead = true;
          }
        }
      });
    }
  }

  updateTracers(delta) {
    if (!Array.isArray(this.activeBotTracers)) this.activeBotTracers = [];
    for (let i = this.activeBotTracers.length - 1; i >= 0; i--) {
      const tr = this.activeBotTracers[i];
      if (!tr || !tr.mesh) {
        this.activeBotTracers.splice(i, 1);
        continue;
      }
      try {
        tr.traveled += tr.speed * delta;
        if (tr.traveled >= tr.totalDistance) {
          if (this.scene && tr.mesh) this.scene.remove(tr.mesh);
          if (tr.geo && typeof tr.geo.dispose === 'function') tr.geo.dispose();
          if (tr.mat && typeof tr.mat.dispose === 'function') tr.mat.dispose();
          this.activeBotTracers.splice(i, 1);
        } else {
          tr.mesh.position.copy(tr.start).addScaledVector(tr.direction, tr.traveled);
        }
      } catch (err) {
        this.activeBotTracers.splice(i, 1);
      }
    }
  }

  update(delta, playerPos, playerController, camera, gameModeManager, onPlayerHurt) {
    // Always update in-flight visual tracers
    this.updateTracers(delta);

    // If match is finished or bot manager is stopped, freeze all bot updates
    if (this.botManager.isStopped || (gameModeManager && gameModeManager.isMatchCompleted)) {
      this.currentSpeed = 0;
      this.operator.updateAnimation(delta, 0, true, camera);
      return;
    }

    if (this.isDead) {
      this.respawnTimer -= delta;
      this.operator.updateAnimation(delta, 0, true, camera);
      if (this.respawnTimer <= 0) {
        this.respawn(playerPos);
      }
      return;
    }

    // Decay spawn protection
    if (this.spawnProtectionTimer > 0) {
      this.spawnProtectionTimer -= delta;
    }

    // Always clamp vertical position to exact terrain/ramp elevation
    if (this.arena && typeof this.arena.getGroundHeight === 'function') {
      this.position.y = this.arena.getGroundHeight(this.position.x, this.position.z);
      this.operator.root.position.copy(this.position);
    }

    // 1. Weapon Reload Cycle
    if (this.currentAmmo <= 0 && !this.isReloading) {
      this.isReloading = true;
      this.reloadTimer = this.reloadDuration;
      this.botManager.releaseAttackToken(this.id);
      this.state = 'RELOAD';
    }

    if (this.isReloading) {
      this.reloadTimer -= delta;
      if (this.reloadTimer <= 0) {
        this.isReloading = false;
        this.currentAmmo = this.magCapacity;
        this.state = 'PATROL';
      } else {
        // Maneuver toward cover/patrol while reloading
        this.patrol(delta);
        this.operator.updateAnimation(delta, this.currentSpeed, true, camera);
        return;
      }
    }

    // 2. Invulnerability & Spawn Protection Check:
    // If player has spawn protection or is dead, bots ignore the player completely
    const isPlayerInvulnerable = (gameModeManager && (gameModeManager.hasSpawnProtection || gameModeManager.isDead)) ||
                                 (playerController && playerController.isDead);

    if (isPlayerInvulnerable) {
      this.botManager.releaseAttackToken(this.id);
      this.hasReactionLock = false;
      this.reactionTimer = 0;
      this.state = 'PATROL';
      this.patrol(delta);
      this.operator.updateAnimation(delta, this.currentSpeed, true, camera);
      return;
    }

    const profile = this.botManager.getCurrentProfile();
    const distToPlayer = this.position.distanceTo(playerPos);

    // 3. Line of Sight & Range Detection
    const inRange = distToPlayer <= profile.detectionRange;
    const hasSight = inRange && this.hasLineOfSight(playerPos);

    if (hasSight) {
      // Check if magazine is empty -> initiate reload
      if (this.currentAmmo <= 0) {
        this.isReloading = true;
        this.reloadTimer = this.reloadDuration;
        this.botManager.releaseAttackToken(this.id);
        this.state = 'RELOAD';
        return;
      }

      // Attack Token Allocation: Limit concurrent attackers
      const hasToken = this.botManager.requestAttackToken(this.id);

      if (!hasToken) {
        // Player is spotted, but max concurrent attackers is reached: flank or reposition
        this.hasReactionLock = false;
        this.reactionTimer = 0;
        this.state = 'PATROL';
        this.patrol(delta);
        this.operator.updateAnimation(delta, this.currentSpeed, true, camera);
        return;
      }

      // 4. Bot Reaction Delay (Human-like reaction before first shot)
      if (!this.hasReactionLock) {
        this.reactionTimer = profile.reactionDelayMin + Math.random() * (profile.reactionDelayMax - profile.reactionDelayMin);
        this.hasReactionLock = true;
        this.burstCooldownTimer = 0;
        this.burstShotsRemaining = 0;
      }

      this.aimAt(playerPos);

      if (this.reactionTimer > 0) {
        // Acquiring target lock - gives player time to react and take cover
        this.reactionTimer -= delta;
        this.state = 'ACQUIRING';
        this.currentSpeed = 0;
        this.operator.updateAnimation(delta, 0, true, camera);
        return;
      }

      // 5. Combat Engagement
      if (distToPlayer <= profile.attackRange) {
        this.state = 'ATTACK';
        this.currentSpeed = 0;
        this.updateBurstCombat(delta, playerPos, profile, onPlayerHurt);
      } else {
        this.state = 'ENGAGE';
        this.moveTowards(playerPos, this.runSpeed, delta);
      }

    } else {
      // Player lost or behind solid cover: navigate tactically
      this.botManager.releaseAttackToken(this.id);
      this.hasReactionLock = false;
      this.reactionTimer = 0;
      this.burstShotsRemaining = 0;
      this.state = 'PATROL';

      if (inRange && distToPlayer > 8.0) {
        // Navigate via tactical waypoint graph towards player
        const navTarget = this.getNavigationTarget(playerPos);
        this.moveTowards(navTarget, this.moveSpeed, delta);
      } else {
        this.patrol(delta);
      }
    }

    // Update Skeletal Animations
    this.operator.updateAnimation(delta, this.currentSpeed, true, camera);
  }

  /**
   * Balanced Burst Combat:
   * Fires 2-3 shots with distinct gap between bullets, then forces a tactical pause.
   */
  updateBurstCombat(delta, playerPos, profile, onPlayerHurt) {
    if (this.burstCooldownTimer > 0) {
      this.burstCooldownTimer -= delta;
      return;
    }

    if (this.burstShotsRemaining <= 0) {
      this.burstShotsRemaining = profile.burstCount;
      this.burstShotTimer = 0;
    }

    this.burstShotTimer -= delta;
    if (this.burstShotTimer <= 0) {
      this.fireSingleShot(playerPos, profile, onPlayerHurt);
      this.burstShotsRemaining--;
      this.burstShotTimer = profile.burstInterval;

      if (this.burstShotsRemaining <= 0) {
        // Burst finished: enforce tactical cooldown
        this.burstCooldownTimer = profile.burstCooldown;
      }
    }
  }

  fireSingleShot(playerPos, profile, onPlayerHurt) {
    this.currentAmmo = Math.max(0, this.currentAmmo - 1);
    const muzzlePos = new THREE.Vector3(this.position.x, this.position.y + 1.4, this.position.z);

    // Apply realistic spread
    const spreadAmount = 0.48;
    const targetAim = playerPos.clone().add(new THREE.Vector3(
      (Math.random() - 0.5) * spreadAmount,
      (Math.random() - 0.5) * spreadAmount + 0.85,
      (Math.random() - 0.5) * spreadAmount
    ));

    // Render red tracer safely
    try {
      this.createBotTracer(muzzlePos, targetAim);
    } catch (e) {
      console.warn('[Bot] Error creating tracer:', e);
    }

    // Trigger visual weapon recoil on operator model
    if (this.operator && typeof this.operator.triggerShoot === 'function') {
      this.operator.triggerShoot();
    }

    // Accuracy scaling with distance & difficulty
    const dist = muzzlePos.distanceTo(playerPos);
    const rangeFraction = Math.min(1.0, dist / profile.attackRange);
    const hitChance = Math.max(0.12, profile.hitChanceBase * (1.1 - rangeFraction * 0.45));

    if (Math.random() < hitChance) {
      if (typeof onPlayerHurt === 'function') {
        const botWorldPos = this.mesh ? this.mesh.position.clone() : this.position.clone();
        onPlayerHurt(profile.damage, this.name, botWorldPos);
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
            return false; // Physical wall blocks line of sight
          }
        }
      }
    }

    return true;
  }

  aimAt(targetPos) {
    const dir = targetPos.clone().sub(this.position);
    dir.y = 0;
    if (dir.lengthSq() > 0.001) {
      const angle = Math.atan2(dir.x, dir.z);
      this.operator.root.rotation.y = angle;
    }
  }

  checkCollisionAt(x, z) {
    if (!this.arena || !this.arena.colliders) return false;
    const r = 0.52; // Tactical operator bounding radius
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

  getNavigationTarget(playerPos) {
    if (this.hasLineOfSight(playerPos)) {
      return playerPos;
    }

    let bestWp = null;
    let minScore = Infinity;

    for (let i = 0; i < this.waypoints.length; i++) {
      const wp = this.waypoints[i];
      const distFromBot = this.position.distanceTo(wp);
      const distToPlayer = wp.distanceTo(playerPos);
      const score = distFromBot + distToPlayer * 0.75;

      if (score < minScore) {
        minScore = score;
        bestWp = wp;
      }
    }

    return bestWp || playerPos;
  }

  moveTowards(targetPos, speed, delta) {
    const dir = targetPos.clone().sub(this.position);
    dir.y = 0;
    const dist = dir.length();

    if (dist > 1.8) {
      dir.normalize();

      // Bot-to-bot separation (repulsion to prevent clustering)
      const separation = new THREE.Vector3(0, 0, 0);
      if (this.botManager && this.botManager.bots) {
        for (let i = 0; i < this.botManager.bots.length; i++) {
          const other = this.botManager.bots[i];
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

      const moveVec = dir.clone().multiplyScalar(speed * delta).add(separation.multiplyScalar(delta));

      const nextX = this.position.x + moveVec.x;
      const nextZ = this.position.z + moveVec.z;

      if (!this.checkCollisionAt(nextX, this.position.z)) {
        this.position.x = nextX;
      }
      if (!this.checkCollisionAt(this.position.x, nextZ)) {
        this.position.z = nextZ;
      }

      // Ground height clamp
      const groundY = this.arena && typeof this.arena.getGroundHeight === 'function'
        ? this.arena.getGroundHeight(this.position.x, this.position.z)
        : 0;
      this.position.y = groundY;

      this.operator.root.position.copy(this.position);
      this.aimAt(targetPos);
      this.currentSpeed = speed;
    } else {
      this.currentSpeed = 0;
    }
  }

  patrol(delta) {
    const targetWp = this.waypoints[this.currentWaypointIndex];
    const dist = this.position.distanceTo(targetWp);
    if (dist < 2.5) {
      this.currentWaypointIndex = (this.currentWaypointIndex + 1) % this.waypoints.length;
    } else {
      this.moveTowards(targetWp, this.moveSpeed, delta);
    }
  }

  createBotTracer(start, end) {
    if (!start || !end) return;
    if (!Array.isArray(this.activeBotTracers)) this.activeBotTracers = [];

    const totalDistance = start.distanceTo(end);
    if (totalDistance < 0.2) return;
    const direction = end.clone().sub(start).normalize();
    const speed = 190; // Realistic incoming fire velocity
    const tracerGeo = new THREE.CylinderGeometry(0.016, 0.012, 0.55, 6);
    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.95 });

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
      return true; // Indicates kill
    }
    return false;
  }

  die() {
    this.isDead = true;
    this.respawnTimer = this.respawnDuration;
    this.currentSpeed = 0;
    this.botManager.releaseAttackToken(this.id);
    if (this.operator && typeof this.operator.die === 'function') {
      this.operator.die();
    }
  }

  respawn(playerPos) {
    this.isDead = false;
    this.health = this.maxHealth;
    this.currentAmmo = this.magCapacity;
    this.isReloading = false;
    this.spawnProtectionTimer = 3.0;

    // Pick randomized tactical spawn point
    const newPos = this.botManager.getValidSpawnPoint(playerPos, this.id);
    this.position.copy(newPos);
    this.spawnPos.copy(newPos);

    if (this.arena && typeof this.arena.getGroundHeight === 'function') {
      this.position.y = this.arena.getGroundHeight(this.position.x, this.position.z);
    }

    this.reactionTimer = 0;
    this.hasReactionLock = false;
    this.burstShotsRemaining = 0;
    this.burstCooldownTimer = 0;
    this.currentSpeed = 0;

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
    this.difficulty = 'normal'; // 'easy' | 'normal' | 'hard'
    this.activeAttackers = new Set();
    this.isStopped = false;
    this.isEnabled = true;
    this.initBots();
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

  /**
   * Selects an intelligent, randomized tactical spawn point
   * enforcing distance from player and other active bots.
   */
  getValidSpawnPoint(playerPos, currentBotId) {
    const pPos = playerPos || new THREE.Vector3(0, 0, 0);
    const candidates = [];

    for (let i = 0; i < TACTICAL_SPAWN_POINTS.length; i++) {
      const pt = TACTICAL_SPAWN_POINTS[i];
      const distToPlayer = pt.distanceTo(pPos);

      // Must be at least 20 meters from player to prevent spawn camping or in-face spawns
      if (distToPlayer < 20.0) continue;

      // Must be at least 8 meters from other living bots
      let tooCloseToBot = false;
      for (let b = 0; b < this.bots.length; b++) {
        const bot = this.bots[b];
        if (bot.id !== currentBotId && !bot.isDead) {
          if (bot.position.distanceTo(pt) < 8.0) {
            tooCloseToBot = true;
            break;
          }
        }
      }

      if (!tooCloseToBot) {
        candidates.push(pt);
      }
    }

    if (candidates.length > 0) {
      const chosen = candidates[Math.floor(Math.random() * candidates.length)].clone();
      if (this.arena && typeof this.arena.getGroundHeight === 'function') {
        chosen.y = this.arena.getGroundHeight(chosen.x, chosen.z);
      }
      return chosen;
    }

    // Fallback: pick furthest spawn point from player
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
    if (DIFFICULTY_PROFILES[diff]) {
      this.difficulty = diff;
      this.activeAttackers.clear();
      console.log(`[SecureFPS AI] Bot difficulty set to: ${DIFFICULTY_PROFILES[diff].name}`);
    }
  }

  getCurrentProfile() {
    return DIFFICULTY_PROFILES[this.difficulty] || DIFFICULTY_PROFILES.normal;
  }

  requestAttackToken(botId) {
    if (this.activeAttackers.has(botId)) return true;
    const profile = this.getCurrentProfile();
    if (this.activeAttackers.size < profile.maxAttackers) {
      this.activeAttackers.add(botId);
      return true;
    }
    return false;
  }

  releaseAttackToken(botId) {
    this.activeAttackers.delete(botId);
  }

  stopAllBots() {
    this.isStopped = true;
    this.activeAttackers.clear();
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
    this.activeAttackers.clear();
  }

  resetAllBots(playerPos) {
    this.isStopped = false;
    this.activeAttackers.clear();
    const pPos = playerPos || new THREE.Vector3(0, 1.8, 28);
    this.bots.forEach(bot => {
      bot.isDead = false;
      bot.health = bot.maxHealth;
      bot.currentAmmo = bot.magCapacity;
      bot.isReloading = false;
      bot.currentSpeed = 0;
      bot.state = 'PATROL';
      bot.hasReactionLock = false;
      bot.burstShotsRemaining = 0;
      bot.burstCooldownTimer = 0;
      bot.spawnProtectionTimer = 2.0;

      const newPos = this.getValidSpawnPoint(pPos, bot.id);
      bot.position.copy(newPos);
      bot.spawnPos.copy(newPos);
      if (this.arena && typeof this.arena.getGroundHeight === 'function') {
        bot.position.y = this.arena.getGroundHeight(bot.position.x, bot.position.z);
      }
      if (bot.operator && typeof bot.operator.respawn === 'function') {
        bot.operator.respawn(bot.position);
      } else if (bot.operator && bot.operator.root) {
        bot.operator.root.position.copy(bot.position);
        bot.operator.root.visible = true;
      }
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
}
