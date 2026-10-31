/**
 * SecureFPS: Target Practice & Kinematics Training Simulation
 * Replaces combat bots with stationary targets, moving target tracks,
 * reaction-time pop-up plates, and headshot silhouette dummies.
 * Tracks hit accuracy, reaction latency, headshot precision, and scores.
 */

class TrainingTarget {
  constructor(id, type, basePos, scene, audio, options = {}) {
    this.id = id;
    this.type = type; // 'stationary', 'moving', 'popup', 'headshot'
    this.basePos = basePos.clone();
    this.position = basePos.clone();
    this.scene = scene;
    this.audio = audio;
    this.options = options;

    this.isActive = true;
    this.isHit = false;
    this.isPoppedUp = (type !== 'popup');
    this.popupTimer = 0;
    this.popupDuration = options.popupDuration || 3.0;
    this.popupTimestamp = 0;
    this.reactionTime = null; // in ms

    // Movement parameters for moving targets
    this.moveRange = options.moveRange || 6.0;
    this.moveSpeed = options.moveSpeed || 2.4;
    this.moveOffset = options.moveOffset || Math.random() * Math.PI * 2;

    // Flip / knock-down animation state
    this.knockAngle = 0;
    this.targetKnockAngle = 0;
    this.resetTimer = 0;

    this.root = new THREE.Group();
    this.root.position.copy(this.position);
    this.buildTargetMesh();
    this.scene.add(this.root);
  }

  buildTargetMesh() {
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.45,
      metalness: 0.8
    });

    const standPost = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 1.4, 8),
      metalMat
    );
    standPost.position.y = 0.7;
    this.root.add(standPost);

    const basePlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.05, 0.6),
      metalMat
    );
    basePlate.position.y = 0.025;
    this.root.add(basePlate);

    // Target Plate Group (rotates on hit)
    this.plateGroup = new THREE.Group();
    this.plateGroup.position.set(0, 1.4, 0);
    this.root.add(this.plateGroup);

    // Torso Target Board
    const boardMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.6,
      metalness: 0.3
    });
    const torsoBoard = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.8, 0.04),
      boardMat
    );
    torsoBoard.position.y = 0.4;
    this.plateGroup.add(torsoBoard);

    // Bullseye Ring (Outer)
    const ringOuter = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.045, 16),
      new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.5 })
    );
    ringOuter.rotation.x = Math.PI / 2;
    ringOuter.position.set(0, 0.4, 0.005);
    this.plateGroup.add(ringOuter);

    // Bullseye Ring (Center)
    const ringCenter = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.05, 16),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 })
    );
    ringCenter.rotation.x = Math.PI / 2;
    ringCenter.position.set(0, 0.4, 0.01);
    this.plateGroup.add(ringCenter);

    // Bullseye Dot (Heart)
    const bullseye = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 0.055, 16),
      new THREE.MeshStandardMaterial({ color: 0x00f0ff, roughness: 0.3, emissive: 0x00f0ff, emissiveIntensity: 0.4 })
    );
    bullseye.rotation.x = Math.PI / 2;
    bullseye.position.set(0, 0.4, 0.015);
    this.plateGroup.add(bullseye);

    // Headshot Plate (Top Circle)
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xfbbf24,
      roughness: 0.4,
      metalness: 0.5,
      emissive: 0xf59e0b,
      emissiveIntensity: 0.3
    });
    this.headMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 0.05, 16),
      headMat
    );
    this.headMesh.rotation.x = Math.PI / 2;
    this.headMesh.position.set(0, 0.95, 0.01);
    this.headMesh.userData = { target: this, isHead: true };
    this.plateGroup.add(this.headMesh);

    // Body Mesh Hitbox
    this.bodyMesh = torsoBoard;
    this.bodyMesh.userData = { target: this, isHead: false };

    if (this.type === 'popup') {
      this.plateGroup.scale.set(0.001, 0.001, 0.001);
      this.isPoppedUp = false;
    }
  }

  popup() {
    this.isPoppedUp = true;
    this.isHit = false;
    this.targetKnockAngle = 0;
    this.knockAngle = 0;
    this.plateGroup.rotation.x = 0;
    this.plateGroup.scale.set(1, 1, 1);
    this.popupTimestamp = performance.now();
    this.popupTimer = this.popupDuration;
  }

  popdown() {
    this.isPoppedUp = false;
    this.plateGroup.scale.set(0.001, 0.001, 0.001);
  }

  update(delta, now) {
    if (!this.isActive) return;

    // Moving Target Motion
    if (this.type === 'moving' && !this.isHit) {
      const offsetX = Math.sin(now * this.moveSpeed + this.moveOffset) * this.moveRange;
      this.position.x = this.basePos.x + offsetX;
      this.root.position.x = this.position.x;
    }

    // Reaction Pop-up countdown
    if (this.type === 'popup' && this.isPoppedUp && !this.isHit) {
      this.popupTimer -= delta;
      if (this.popupTimer <= 0) {
        this.popdown();
        if (typeof this.options.onTimeout === 'function') {
          this.options.onTimeout(this);
        }
      }
    }

    // Knockdown animation
    this.knockAngle += (this.targetKnockAngle - this.knockAngle) * Math.min(1.0, delta * 14.0);
    this.plateGroup.rotation.x = this.knockAngle;

    // Reset after hit
    if (this.isHit) {
      this.resetTimer -= delta;
      if (this.resetTimer <= 0) {
        this.isHit = false;
        this.targetKnockAngle = 0;
        if (this.type === 'popup') {
          this.popdown();
        }
      }
    }
  }

  hit(isHeadshot) {
    if (this.isHit) return null;
    this.isHit = true;
    this.targetKnockAngle = Math.PI * 0.45; // Flip back 80 degrees
    this.resetTimer = 2.0;

    let reactionMs = null;
    if (this.popupTimestamp > 0) {
      reactionMs = Math.round(performance.now() - this.popupTimestamp);
      this.popupTimestamp = 0;
    }

    return {
      id: this.id,
      type: this.type,
      isHeadshot: isHeadshot,
      reactionMs: reactionMs,
      points: isHeadshot ? 250 : 100
    };
  }

  destroy() {
    this.isActive = false;
    this.scene.remove(this.root);
  }
}

class TrainingManager {
  constructor(scene, arena, audio) {
    this.scene = scene;
    this.arena = arena;
    this.audio = audio;

    this.targets = [];
    this.isActive = false;
    this.challengeFinished = false;

    // Metrics
    this.totalChallengeTargets = 20;
    this.targetsHit = 0;
    this.targetsMissed = 0;
    this.headshots = 0;
    this.reactionTimes = [];
    this.trainingScore = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.startTime = 0;
    this.completionTime = 0;

    // Pop-up wave sequencer
    this.popupQueue = [];
    this.popupInterval = 2.2;
    this.popupTimer = 1.0;

    // DOM HUD elements
    this.trainingHUD = document.getElementById('training-hud');
    this.targetCountEl = document.getElementById('tr-target-count');
    this.accuracyEl = document.getElementById('tr-accuracy');
    this.headshotsEl = document.getElementById('tr-headshots');
    this.reactionEl = document.getElementById('tr-reaction');
    this.scoreEl = document.getElementById('tr-score');

    this.initEvents();
  }

  initEvents() {
    window.addEventListener('fps:telemetry_fire', () => {
      if (this.isActive && !this.challengeFinished) {
        this.shotsFired++;
        this.updateHUD();
      }
    });
  }

  startSimulation() {
    this.clearTargets();
    this.isActive = true;
    this.challengeFinished = false;

    this.targetsHit = 0;
    this.targetsMissed = 0;
    this.headshots = 0;
    this.reactionTimes = [];
    this.trainingScore = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.startTime = performance.now() / 1000;
    this.popupTimer = 1.5;

    this.spawnCourseTargets();
    this.showTrainingHUD(true);
    this.updateHUD();
    console.log('[SecureFPS Training] Practice simulation course deployed with 20 tactical targets.');
  }

  spawnCourseTargets() {
    // 1. Stationary Lanes (6 Targets at varying depths)
    const stationaryConfigs = [
      { id: 'stat_1', pos: new THREE.Vector3(-14, 0, -22) },
      { id: 'stat_2', pos: new THREE.Vector3(0, 0, -26) },
      { id: 'stat_3', pos: new THREE.Vector3(14, 0, -22) },
      { id: 'stat_4', pos: new THREE.Vector3(-22, 0, -10) },
      { id: 'stat_5', pos: new THREE.Vector3(22, 0, -10) },
      { id: 'stat_6', pos: new THREE.Vector3(0, 2.0, 0) } // Center elevated platform
    ];

    stationaryConfigs.forEach(cfg => {
      const target = new TrainingTarget(cfg.id, 'stationary', cfg.pos, this.scene, this.audio);
      this.targets.push(target);
    });

    // 2. Moving Steel Targets (4 Targets sliding on left/right tracks)
    const movingConfigs = [
      { id: 'move_1', pos: new THREE.Vector3(-12, 0, -15), range: 4.5, speed: 2.2 },
      { id: 'move_2', pos: new THREE.Vector3(12, 0, -15), range: 4.5, speed: 2.6 },
      { id: 'move_3', pos: new THREE.Vector3(-18, 0, 8), range: 5.0, speed: 1.8 },
      { id: 'move_4', pos: new THREE.Vector3(18, 0, 8), range: 5.0, speed: 2.4 }
    ];

    movingConfigs.forEach(cfg => {
      const target = new TrainingTarget(cfg.id, 'moving', cfg.pos, this.scene, this.audio, {
        moveRange: cfg.range,
        moveSpeed: cfg.speed
      });
      this.targets.push(target);
    });

    // 3. Reaction-Time Pop-Up Targets (10 Targets in sequence)
    const popupPositions = [
      new THREE.Vector3(-8, 0, -20),
      new THREE.Vector3(8, 0, -20),
      new THREE.Vector3(-16, 0, -4),
      new THREE.Vector3(16, 0, -4),
      new THREE.Vector3(-4, 0, -10),
      new THREE.Vector3(4, 0, -10),
      new THREE.Vector3(-22, 0, 16),
      new THREE.Vector3(22, 0, 16),
      new THREE.Vector3(-10, 0, 20),
      new THREE.Vector3(10, 0, 20)
    ];

    this.popupQueue = [];
    popupPositions.forEach((pos, idx) => {
      const target = new TrainingTarget(`popup_${idx + 1}`, 'popup', pos, this.scene, this.audio, {
        popupDuration: 3.2,
        onTimeout: (tgt) => {
          this.targetsMissed++;
          this.updateHUD();
          this.checkChallengeCompletion();
        }
      });
      this.targets.push(target);
      this.popupQueue.push(target);
    });
  }

  update(delta) {
    if (!this.isActive || this.challengeFinished) return;

    const now = performance.now() / 1000;

    // Update active targets
    this.targets.forEach(t => t.update(delta, now));

    // Pop-up target sequencer
    this.popupTimer -= delta;
    if (this.popupTimer <= 0 && this.popupQueue.length > 0) {
      const nextTarget = this.popupQueue.shift();
      if (nextTarget && nextTarget.isActive) {
        nextTarget.popup();
      }
      this.popupTimer = this.popupInterval;
    }
  }

  getHitboxMeshes() {
    if (!this.isActive || this.challengeFinished) return [];
    const hitboxes = [];
    this.targets.forEach(t => {
      if (t.isActive && !t.isHit && (t.type !== 'popup' || t.isPoppedUp)) {
        if (t.headMesh) hitboxes.push(t.headMesh);
        if (t.bodyMesh) hitboxes.push(t.bodyMesh);
      }
    });
    return hitboxes;
  }

  handleBulletHit(mesh) {
    if (!mesh || !mesh.userData?.target) return null;

    const target = mesh.userData.target;
    const isHeadshot = mesh.userData.isHead === true;

    const result = target.hit(isHeadshot);
    if (!result) return null;

    this.shotsHit++;
    this.targetsHit++;
    this.trainingScore += result.points;

    if (isHeadshot) {
      this.headshots++;
    }

    if (result.reactionMs !== null) {
      this.reactionTimes.push(result.reactionMs);
    }

    if (this.audio) {
      this.audio.playHitmarker(isHeadshot);
    }

    this.updateHUD();
    this.checkChallengeCompletion();

    return result;
  }

  checkChallengeCompletion() {
    const totalProcessed = this.targetsHit + this.targetsMissed;
    if (totalProcessed >= this.totalChallengeTargets && !this.challengeFinished) {
      this.completeChallenge();
    }
  }

  completeChallenge() {
    this.challengeFinished = true;
    this.completionTime = Math.max(1, Math.round((performance.now() / 1000) - this.startTime));

    const accuracy = this.shotsFired > 0 ? Math.round((this.shotsHit / this.shotsFired) * 100) : 0;
    const avgReaction = this.reactionTimes.length > 0
      ? Math.round(this.reactionTimes.reduce((a, b) => a + b, 0) / this.reactionTimes.length)
      : 320;

    let rank = 'COMBAT OPERATOR';
    if (accuracy >= 85 && avgReaction < 320) rank = 'APEX SENTINEL (S-TIER)';
    else if (accuracy >= 70 && avgReaction < 450) rank = 'TACTICAL MARKSMAN (A-TIER)';
    else if (accuracy < 50) rank = 'RECRUIT TRAINEE (C-TIER)';

    const detail = {
      targetsHit: this.targetsHit,
      targetsMissed: this.targetsMissed,
      totalTargets: this.totalChallengeTargets,
      accuracy: accuracy,
      headshots: this.headshots,
      avgReaction: avgReaction,
      score: this.trainingScore,
      duration: this.completionTime,
      rank: rank
    };

    console.log('[SecureFPS Training] Course Challenge Completed:', detail);
    window.dispatchEvent(new CustomEvent('fps:training_completed', { detail }));
  }

  updateHUD() {
    const totalProcessed = this.targetsHit + this.targetsMissed;
    if (this.targetCountEl) {
      this.targetCountEl.textContent = `${this.targetsHit}/${this.totalChallengeTargets}`;
    }

    const accuracy = this.shotsFired > 0 ? Math.round((this.shotsHit / this.shotsFired) * 100) : 100;
    if (this.accuracyEl) {
      this.accuracyEl.textContent = `${accuracy}%`;
    }

    if (this.headshotsEl) {
      this.headshotsEl.textContent = this.headshots;
    }

    if (this.reactionEl) {
      if (this.reactionTimes.length > 0) {
        const last = this.reactionTimes[this.reactionTimes.length - 1];
        this.reactionEl.textContent = `${last}ms`;
      } else {
        this.reactionEl.textContent = '--';
      }
    }

    if (this.scoreEl) {
      this.scoreEl.textContent = this.trainingScore;
    }
  }

  showTrainingHUD(show) {
    if (!this.trainingHUD) {
      this.trainingHUD = document.getElementById('training-hud');
    }
    if (this.trainingHUD) {
      this.trainingHUD.style.display = show ? 'flex' : 'none';
    }
  }

  clearTargets() {
    this.targets.forEach(t => t.destroy());
    this.targets = [];
    this.popupQueue = [];
  }

  stopSimulation() {
    this.isActive = false;
    this.challengeFinished = false;
    this.clearTargets();
    this.showTrainingHUD(false);
  }
}
