/**
 * SecureFPS: First-Person Character Controller
 * Implements Pointer Lock mouse-look, responsive WASD kinematics,
 * sprint, crouch, jump, gravity, multi-axis wall-sliding collision detection,
 * smooth ramp traversal, procedural head-bobbing, and real-time input diagnostics.
 */
class Controller {
  constructor(camera, domElement, arena) {
    this.camera = camera;
    this.domElement = domElement;
    this.arena = arena;

    // Orientation state (euler angles in radians)
    this.yaw = 0;
    this.pitch = 0;
    this.mouseSensitivity = 0.0022;
    this.aimSensitivityMultiplier = 0.7; // ADS sensitivity scaling
    this.invertY = false;

    // Dimensions & heights (in meters)
    this.playerRadius = 0.40;
    this.standingEyeHeight = 1.70;
    this.crouchEyeHeight = 1.05;
    this.currentEyeHeight = this.standingEyeHeight;

    // Position and velocity state
    this.position = new THREE.Vector3(0, 1.8, 28);
    this.velocity = new THREE.Vector3(0, 0, 0);

    // Kinematic settings (m/s and m/s^2)
    this.walkSpeed = 7.0;
    this.sprintSpeed = 11.5;
    this.crouchSpeed = 3.6;
    this.groundAcceleration = 52.0;
    this.groundFriction = 36.0;
    this.airAcceleration = 20.0;
    this.gravity = 26.0;
    this.jumpForce = 9.4;

    // Movement state flags
    this.isGrounded = true;
    this.isSprinting = false;
    this.isCrouching = false;
    this.isLocked = false;

    // Input state
    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false
    };

    // Advanced jumping helpers (Coyote time & jump buffering)
    this.coyoteTime = 0.12;
    this.coyoteTimer = 0;
    this.jumpBufferTime = 0.14;
    this.jumpBufferTimer = 0;

    // Procedural head bobbing
    this.bobTimer = 0;
    this.bobFrequency = 10.0;
    this.bobIntensity = 0.04;
    this.cameraRoll = 0;

    // Input Debug HUD Elements
    this.debugVisible = true;
    this.dbgHud = document.getElementById('input-debug-hud');
    this.dbgLockBadge = document.getElementById('dbg-lock-badge');
    this.dbgStatPos = document.getElementById('dbg-stat-pos');
    this.dbgStatVel = document.getElementById('dbg-stat-vel');
    this.dbgStatStance = document.getElementById('dbg-stat-stance');
    this.dbgStatGround = document.getElementById('dbg-stat-ground');

    this.dbgKeyElements = {
      w: document.getElementById('dbg-key-w'),
      a: document.getElementById('dbg-key-a'),
      s: document.getElementById('dbg-key-s'),
      d: document.getElementById('dbg-key-d'),
      shift: document.getElementById('dbg-key-shift'),
      space: document.getElementById('dbg-key-space'),
      c: document.getElementById('dbg-key-c'),
      lmb: document.getElementById('dbg-key-lmb'),
      rmb: document.getElementById('dbg-key-rmb')
    };

    this.initEvents();
  }

  initEvents() {
    // 1. Pointer Lock Change Listeners
    document.addEventListener('pointerlockchange', () => {
      this.isLocked = document.pointerLockElement === this.domElement;
      if (!this.isLocked) {
        this.resetKeys();
        window.dispatchEvent(new CustomEvent('fps:pointerlock', { detail: { locked: false } }));
      } else {
        window.dispatchEvent(new CustomEvent('fps:pointerlock', { detail: { locked: true } }));
      }
      this.updateDebugHUD();
    });

    // 2. Mouse Movement (Orientation Look)
    document.addEventListener('mousemove', (e) => {
      if (!this.isLocked) return;

      const movementX = e.movementX || 0;
      const movementY = e.movementY || 0;

      const isAiming = window.SecureFPSGame?.weapons?.isAiming;
      const aimMult = isAiming ? (this.aimSensitivityMultiplier || 0.7) : 1.0;
      const effectiveSens = this.mouseSensitivity * aimMult;

      this.yaw -= movementX * effectiveSens;
      const pitchSign = this.invertY ? 1 : -1;
      this.pitch += pitchSign * movementY * effectiveSens;

      // Clamp vertical pitch (-88 deg to +88 deg) to prevent flipping
      const maxPitch = Math.PI / 2 - 0.03;
      this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
    });

    // 3. Robust Window Keyboard Event Listeners
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));

    // Reset keys on window blur or tab change
    window.addEventListener('blur', () => this.resetKeys());

    // Auto-acquire Pointer Lock on user interaction when in match
    window.addEventListener('mousedown', (e) => {
      if (!window.SecureFPSGame?.isMenuOpen && !this.isLocked) {
        this.requestLock();
      }
    });

    // Toggle Input Diagnostics HUD via F3
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.toggleDebugHUD();
      }
    });
  }

  requestLock() {
    // Unfocus any active input elements from lobby so keyboard focus is active
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    if (this.domElement) {
      if (typeof this.domElement.focus === 'function') {
        this.domElement.focus();
      }
      try {
        this.domElement.requestPointerLock();
      } catch (err) {
        console.warn('[SecureFPS Controller] Pointer lock request:', err);
      }
    }
    if (typeof window.focus === 'function') {
      window.focus();
    }
  }

  unlock() {
    if (document.exitPointerLock) {
      document.exitPointerLock();
    }
    this.resetKeys();
  }

  resetKeys() {
    this.keys.forward = false;
    this.keys.backward = false;
    this.keys.left = false;
    this.keys.right = false;
    this.keys.jump = false;
    this.keys.sprint = false;
    this.keys.crouch = false;
  }

  onKeyDown(e) {
    // Only ignore keyboard events if the tactical menu is ACTUALLY open and visible
    if (window.SecureFPSGame?.isMenuOpen && e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      return;
    }

    const code = e.code;
    const key = (e.key || '').toLowerCase();

    if (code === 'KeyW' || key === 'w' || code === 'ArrowUp') {
      this.keys.forward = true;
    } else if (code === 'KeyS' || key === 's' || code === 'ArrowDown') {
      this.keys.backward = true;
    } else if (code === 'KeyA' || key === 'a' || code === 'ArrowLeft') {
      this.keys.left = true;
    } else if (code === 'KeyD' || key === 'd' || code === 'ArrowRight') {
      this.keys.right = true;
    } else if (code === 'Space' || key === ' ') {
      this.keys.jump = true;
      this.jumpBufferTimer = this.jumpBufferTime;
      e.preventDefault();
    } else if (code === 'ShiftLeft' || code === 'ShiftRight' || key === 'shift') {
      this.keys.sprint = true;
    } else if (code === 'KeyC' || key === 'c' || code === 'ControlLeft' || code === 'ControlRight' || key === 'control') {
      this.keys.crouch = true;
    } else if (code === 'KeyR' || key === 'r') {
      window.dispatchEvent(new CustomEvent('fps:action', { detail: { type: 'reload' } }));
    }
  }

  onKeyUp(e) {
    const code = e.code;
    const key = (e.key || '').toLowerCase();

    if (code === 'KeyW' || key === 'w' || code === 'ArrowUp') {
      this.keys.forward = false;
    } else if (code === 'KeyS' || key === 's' || code === 'ArrowDown') {
      this.keys.backward = false;
    } else if (code === 'KeyA' || key === 'a' || code === 'ArrowLeft') {
      this.keys.left = false;
    } else if (code === 'KeyD' || key === 'd' || code === 'ArrowRight') {
      this.keys.right = false;
    } else if (code === 'Space' || key === ' ') {
      this.keys.jump = false;
    } else if (code === 'ShiftLeft' || code === 'ShiftRight' || key === 'shift') {
      this.keys.sprint = false;
    } else if (code === 'KeyC' || key === 'c' || code === 'ControlLeft' || code === 'ControlRight' || key === 'control') {
      this.keys.crouch = false;
    }
  }

  toggleDebugHUD() {
    this.debugVisible = !this.debugVisible;
    if (this.dbgHud) {
      this.dbgHud.style.display = this.debugVisible ? 'block' : 'none';
    }
  }

  /**
   * Main Kinematics, Collision and Camera Update Loop
   */
  update(delta) {
    // Clamp delta to prevent physics explosion on tab-out or frame stutter
    delta = Math.min(delta, 0.08);

    // Update Jump Buffers & Coyote Timers
    if (this.isGrounded) {
      this.coyoteTimer = this.coyoteTime;
    } else {
      this.coyoteTimer -= delta;
    }

    if (this.jumpBufferTimer > 0) {
      this.jumpBufferTimer -= delta;
    }

    // Determine target speed based on stance
    this.isCrouching = this.keys.crouch;
    this.isSprinting = this.keys.sprint && !this.isCrouching && (this.keys.forward || this.keys.left || this.keys.right);

    let targetSpeed = this.walkSpeed;
    if (this.isCrouching) {
      targetSpeed = this.crouchSpeed;
    } else if (this.isSprinting) {
      targetSpeed = this.sprintSpeed;
    }

    // Smooth crouch eye height transition
    const targetHeight = this.isCrouching ? this.crouchEyeHeight : this.standingEyeHeight;
    this.currentEyeHeight += (targetHeight - this.currentEyeHeight) * Math.min(1.0, delta * 12.0);

    // Compute desired movement vector in horizontal plane
    const moveDir = new THREE.Vector3(0, 0, 0);
    if (this.keys.forward) moveDir.z -= 1;
    if (this.keys.backward) moveDir.z += 1;
    if (this.keys.left) moveDir.x -= 1;
    if (this.keys.right) moveDir.x += 1;

    if (moveDir.lengthSq() > 0) {
      moveDir.normalize();
      // Rotate movement vector by player yaw
      moveDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    }

    // Horizontal acceleration & friction
    const currentHorizVel = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    const targetVel = moveDir.clone().multiplyScalar(targetSpeed);

    if (moveDir.lengthSq() > 0) {
      const accel = this.isGrounded ? this.groundAcceleration : this.airAcceleration;
      currentHorizVel.lerp(targetVel, Math.min(1.0, accel * delta / (targetSpeed || 1)));
    } else {
      // Apply friction to stop smoothly
      const friction = this.isGrounded ? this.groundFriction : 4.0;
      const speed = currentHorizVel.length();
      if (speed > 0.01) {
        const drop = speed * friction * delta;
        const newSpeed = Math.max(0, speed - drop);
        currentHorizVel.multiplyScalar(newSpeed / speed);
      } else {
        currentHorizVel.set(0, 0, 0);
      }
    }

    this.velocity.x = currentHorizVel.x;
    this.velocity.z = currentHorizVel.z;

    // Jump execution
    if ((this.jumpBufferTimer > 0) && (this.coyoteTimer > 0)) {
      this.velocity.y = this.jumpForce;
      this.isGrounded = false;
      this.coyoteTimer = 0;
      this.jumpBufferTimer = 0;
    }

    // Apply gravity
    if (!this.isGrounded) {
      this.velocity.y -= this.gravity * delta;
      this.velocity.y = Math.max(-35.0, this.velocity.y);
    }

    // Apply movement with multi-axis collision detection and resolution
    this.applyDisplacementWithCollisions(delta);

    // Procedural head bobbing & direct camera transform update
    this.updateCameraBobbing(delta);

    // Safety check: recover player if fallen off arena
    if (this.position.y < -6.0) {
      this.respawn(new THREE.Vector3(0, 1.8, 28));
    }

    // Update real-time Input Diagnostics HUD
    this.updateDebugHUD();
  }

  /**
   * Applies horizontal and vertical displacement while resolving AABB & Ramp collisions
   */
  applyDisplacementWithCollisions(delta) {
    const dispX = this.velocity.x * delta;
    const dispY = this.velocity.y * delta;
    const dispZ = this.velocity.z * delta;

    // 1. Resolve X movement (Horizontal Wall Sliding)
    this.position.x += dispX;
    if (this.checkCollisions()) {
      this.position.x -= dispX;
      this.velocity.x = 0;
    }

    // 2. Resolve Z movement (Horizontal Wall Sliding)
    this.position.z += dispZ;
    if (this.checkCollisions()) {
      this.position.z -= dispZ;
      this.velocity.z = 0;
    }

    // 3. Resolve Y movement & Floor / Platform / Ramp Contacts
    this.position.y += dispY;

    let groundHeight = 0;
    let standingOnObject = false;

    // Check ramp ground support
    if (this.arena && this.arena.colliders) {
      for (const col of this.arena.colliders) {
        if (col.type === 'ramp') {
          if (
            this.position.x >= col.minX - this.playerRadius &&
            this.position.x <= col.maxX + this.playerRadius &&
            this.position.z >= col.minZ - this.playerRadius &&
            this.position.z <= col.maxZ + this.playerRadius
          ) {
            let progress = 0;
            if (col.axis === 'z') {
              progress = (this.position.z - col.minZ) / (col.maxZ - col.minZ);
            }
            progress = Math.max(0, Math.min(1, progress));
            const rampY = col.startY + (col.endY - col.startY) * progress;

            if (rampY > groundHeight && this.position.y >= rampY - 0.4) {
              groundHeight = rampY;
              standingOnObject = true;
            }
          }
        } else if (col.type === 'box') {
          // Check if player is landing on top of an AABB platform
          const inX = this.position.x >= col.minX - this.playerRadius * 0.7 && this.position.x <= col.maxX + this.playerRadius * 0.7;
          const inZ = this.position.z >= col.minZ - this.playerRadius * 0.7 && this.position.z <= col.maxZ + this.playerRadius * 0.7;
          if (inX && inZ) {
            const topY = col.maxY;
            if (this.position.y >= topY - 0.45 && this.position.y <= topY + 0.6) {
              if (topY > groundHeight) {
                groundHeight = topY;
                standingOnObject = true;
              }
            }
          }
        }
      }
    }

    // Apply ground contact
    if (this.position.y <= groundHeight) {
      this.position.y = groundHeight;
      this.velocity.y = 0;
      this.isGrounded = true;
    } else {
      this.isGrounded = false;
    }
  }

  /**
   * Checks player cylinder against all AABB obstacle colliders
   */
  checkCollisions() {
    if (!this.arena || !this.arena.colliders) return false;

    const r = this.playerRadius;
    const pX = this.position.x;
    const pY = this.position.y;
    const pZ = this.position.z;
    const pHeight = this.isCrouching ? this.crouchEyeHeight : this.standingEyeHeight;

    for (const col of this.arena.colliders) {
      if (col.type === 'box') {
        // Vertical overlap check
        if (pY + pHeight * 0.15 >= col.minY && pY <= col.maxY - 0.25) {
          // Horizontal overlap check
          if (
            pX + r > col.minX &&
            pX - r < col.maxX &&
            pZ + r > col.minZ &&
            pZ - r < col.maxZ
          ) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Updates realistic procedural head bobbing, camera position, and direct world matrix
   */
  updateCameraBobbing(delta) {
    const horizSpeed = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);

    let bobX = 0;
    let bobY = 0;

    if (this.isGrounded && horizSpeed > 0.5) {
      const speedMult = this.isSprinting ? 1.35 : 1.0;
      this.bobTimer += delta * this.bobFrequency * speedMult;

      bobX = Math.sin(this.bobTimer) * this.bobIntensity * 0.6;
      bobY = Math.abs(Math.cos(this.bobTimer)) * this.bobIntensity;
    } else {
      this.bobTimer = 0;
    }

    // Strafe roll tilt (subtle roll when moving left/right)
    let targetRoll = 0;
    if (this.keys.left) targetRoll += 0.016;
    if (this.keys.right) targetRoll -= 0.016;
    this.cameraRoll += (targetRoll - this.cameraRoll) * Math.min(1.0, delta * 10.0);

    // DIRECT CAMERA TRANSFORM UPDATE (No unattached container)
    this.camera.position.set(
      this.position.x + bobX,
      this.position.y + this.currentEyeHeight + bobY,
      this.position.z
    );

    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    euler.x = this.pitch;
    euler.y = this.yaw;
    euler.z = this.cameraRoll;
    this.camera.quaternion.setFromEuler(euler);

    // Force explicit matrix update so Three.js renders the frame immediately
    this.camera.updateMatrixWorld(true);
  }

  /**
   * Real-time Input & Kinematics Diagnostics HUD Visualizer
   */
  updateDebugHUD() {
    if (!this.debugVisible) return;

    // Cache elements if missing
    if (!this.dbgHud) this.dbgHud = document.getElementById('input-debug-hud');
    if (!this.dbgHud) return;

    if (!this.dbgLockBadge) this.dbgLockBadge = document.getElementById('dbg-lock-badge');
    if (!this.dbgStatPos) this.dbgStatPos = document.getElementById('dbg-stat-pos');
    if (!this.dbgStatVel) this.dbgStatVel = document.getElementById('dbg-stat-vel');
    if (!this.dbgStatStance) this.dbgStatStance = document.getElementById('dbg-stat-stance');
    if (!this.dbgStatGround) this.dbgStatGround = document.getElementById('dbg-stat-ground');

    // Update Lock Badge
    if (this.dbgLockBadge) {
      if (this.isLocked) {
        this.dbgLockBadge.className = 'dbg-badge locked';
        this.dbgLockBadge.textContent = 'POINTER LOCKED';
      } else {
        this.dbgLockBadge.className = 'dbg-badge unlocked';
        this.dbgLockBadge.textContent = 'UNLOCKED (CLICK)';
      }
    }

    // Update Key Indicators
    const k = this.keys;
    this.setKeyActive('w', k.forward);
    this.setKeyActive('a', k.left);
    this.setKeyActive('s', k.backward);
    this.setKeyActive('d', k.right);
    this.setKeyActive('shift', k.sprint);
    this.setKeyActive('space', k.jump);
    this.setKeyActive('c', k.crouch);

    const weapons = window.SecureFPSGame?.weapons;
    this.setKeyActive('lmb', weapons ? weapons.isFiring : false);
    this.setKeyActive('rmb', weapons ? weapons.isAiming : false);

    // Update Numeric Metrics
    if (this.dbgStatPos) {
      this.dbgStatPos.textContent = `POS: (${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)})`;
    }

    const horizSpeed = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
    if (this.dbgStatVel) {
      this.dbgStatVel.textContent = `SPEED: ${horizSpeed.toFixed(1)} m/s`;
    }

    if (this.dbgStatStance) {
      let stance = 'STAND';
      if (this.isCrouching) stance = 'CROUCH';
      else if (this.isSprinting) stance = 'SPRINT';
      else if (horizSpeed > 0.5) stance = 'WALK';
      this.dbgStatStance.textContent = `STANCE: ${stance}`;
    }

    if (this.dbgStatGround) {
      this.dbgStatGround.textContent = `GROUND: ${this.isGrounded ? 'YES' : 'AIR'}`;
    }
  }

  setKeyActive(id, active) {
    let el = this.dbgKeyElements[id];
    if (!el) {
      el = document.getElementById(`dbg-key-${id}`);
      this.dbgKeyElements[id] = el;
    }
    if (el) {
      if (active) el.classList.add('active');
      else el.classList.remove('active');
    }
  }

  respawn(spawnPos) {
    this.position.copy(spawnPos || new THREE.Vector3(0, 1.8, 28));
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.isGrounded = true;
    this.resetKeys();
    this.updateCameraBobbing(0.016);
  }

  getForwardVector() {
    const vector = new THREE.Vector3(0, 0, -1);
    vector.applyQuaternion(this.camera.quaternion);
    return vector;
  }

  getCompassHeading() {
    let deg = THREE.MathUtils.radToDeg(this.yaw) % 360;
    if (deg < 0) deg += 360;
    return Math.round(deg);
  }
}
