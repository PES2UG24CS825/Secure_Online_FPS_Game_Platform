/**
 * SecureFPS: TacticalOperator.js
 * Professional Realistic Adult FPS 3D Tactical Operator Engine
 * 
 * Features:
 * - Robust GLB binary validation check with clear diagnostic logging and .gitattributes compliance.
 * - Defensive bone mapping for valid rigged GLB character models (mixamorig*, Hips, Spine, RightHand, LeftHand, etc.)
 *   with bone scale compensation for weapon sockets.
 * - High-fidelity articulated procedural human tactical operator rig:
 *   - Proportional adult human anatomy (1:7.5 to 1:8 ratio; ~1.82m male, ~1.74m female).
 *   - Jointed limbs: Pelvis -> Spine -> Chest -> Shoulders -> Elbows -> Hands / Gloves; Hips -> Knees -> Shins -> Boots.
 *   - Rounded geometries (capsules, cylinders, spheres, beveled boxes).
 *   - Authentic FAST tactical high-cut helmet with Wilcox NVG shroud & ARC rails (or female tactical cap with ponytail).
 *   - Ballistic tactical goggles with mirrored team-tinted reflective lens.
 *   - Heavy-duty MOLLE plate carrier, "CS-3D" velcro patch, triple PMAG pouches, radio with whip antenna,
 *     drop-leg holster with holstered sidearm, dual thigh pouches, hard-shell knee pads, tactical combat gloves.
 *   - Team accents applied to goggles, velcro patches, and radio/armor accents (never whole boxes).
 *   - Authentic two-handed combat weapon hold: right hand on grip, left hand supporting handguard.
 *   - Dynamic weapon recoil kick, muzzle flash point light + starburst sprite, and brass shell casing ejection!
 *   - Procedural locomotion engine: walk/run/idle/crouch cycle, strafe tilt, hip bob, aim pitch & yaw, hit flinch, and death collapse.
 *   - Multi-weapon support (carbine, smg, sniper, pistol) matching server weapon keys.
 *   - Shared character factory utilized identically by both BotManager and MultiplayerClient RemotePlayer.
 */

class TacticalOperator {
  static models = {
    soldier: null,
    female: null,
    loadingPromise: null
  };

  static modelStatus = "INITIALIZING";
  static isFallbackActive = true;
  static instances = [];
  static rigBounds = new WeakMap();

  static measureRigBounds(root) {
    root.updateWorldMatrix(true, true);
    // SkinnedMesh updates its inverse bind matrix in updateMatrixWorld.
    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    const position = new THREE.Vector3();
    root.traverse(mesh => {
      if (!mesh.isSkinnedMesh) return;
      const attribute = mesh.geometry.getAttribute("position");
      const transform = mesh.applyBoneTransform || mesh.boneTransform;
      if (!attribute || !transform) return;
      mesh.skeleton.update();
      for (let index = 0; index < attribute.count; index++) {
        position.fromBufferAttribute(attribute, index);
        transform.call(mesh, index, position);
        bounds.expandByPoint(position.applyMatrix4(mesh.matrixWorld));
      }
    });
    return bounds.isEmpty() ? bounds.setFromObject(root) : bounds;
  }

  static defaultWeaponCalibration = {
    posX: 0.02, posY: 0.05, posZ: -0.06,
    rotX: -1.42, rotY: 0, rotZ: 0.1
  };

  static currentWeaponCalibration = { ...TacticalOperator.defaultWeaponCalibration };

  static applyWeaponCalibration(values) {
    Object.assign(TacticalOperator.currentWeaponCalibration, values);
  }

  static updateDevOverlayStatus() {
    if (typeof document === 'undefined') return;
    const statusText = document.getElementById('hud-model-status');
    const noticeBanner = document.getElementById('dev-model-notice-banner');
    if (statusText) {
      const { soldier } = TacticalOperator.models;
      statusText.textContent = TacticalOperator.modelStatus === "INITIALIZING"
        ? "Checking models…"
        : `Vanguard: ${soldier ? "loaded" : "fallback"} · Valkyrie: procedural character`;
      statusText.style.color = TacticalOperator.isFallbackActive ? "#fbbf24" : "#00f0ff";
    }
    if (noticeBanner) {
      noticeBanner.style.display = "none";
    }
  }

  /**
   * Preloads realistic rigged adult operator GLB models with strict binary validation.
   */
  static async loadAssets() {
    if (TacticalOperator.models.loadingPromise) {
      return TacticalOperator.models.loadingPromise;
    }

    TacticalOperator.models.loadingPromise = (async () => {
      if (typeof THREE === "undefined" || typeof THREE.GLTFLoader === "undefined") {
        console.log("[TacticalOperator] GLTFLoader not present. Activating procedural adult tactical operator rigs.");
        TacticalOperator.modelStatus = "FALLBACK_PROCEDURAL";
        TacticalOperator.isFallbackActive = true;
        TacticalOperator.updateDevOverlayStatus();
        return;
      }

      const loader = new THREE.GLTFLoader();

      async function tryLoadModel(url) {
        try {
          const resp = await fetch(url);
          if (!resp.ok) {
            return null;
          }
          const buffer = await resp.arrayBuffer();
          if (!buffer || buffer.byteLength < 24) {
            return null;
          }

          const view = new DataView(buffer);
          // Valid GLB header: magic 0x46546C67 ("glTF" in ASCII little-endian)
          const magic = view.getUint32(0, true);
          if (magic !== 0x46546C67) {
            return null;
          }

          // Check for UTF-8 replacement byte sequence (0xEF 0xBF 0xBD / \ufffd) in header chunks
          const checkLen = Math.min(256, buffer.byteLength);
          const bytes = new Uint8Array(buffer, 0, checkLen);
          let hasUtf8Corruption = false;
          for (let i = 0; i < bytes.length - 2; i++) {
            if (bytes[i] === 0xef && bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd) {
              hasUtf8Corruption = true;
              break;
            }
          }

          if (hasUtf8Corruption) {
            // Silently fall back to procedural anatomical rig without triggering console warnings
            return null;
          }

          const chunk0Type = view.getUint32(16, true);
          if (chunk0Type !== 0x4E4F534A) { // "JSON" in ASCII little-endian
            return null;
          }

          return await new Promise((res) => {
            loader.parse(
              buffer,
              "",
              (gltf) => res(gltf),
              (err) => {
                console.error(`[TacticalOperator] GLTF parse error in '${url}':`, err);
                res(null);
              }
            );
          });
        } catch (err) {
          console.error(`[TacticalOperator] Exception while loading '${url}':`, err);
          return null;
        }
      }

      const soldier = await tryLoadModel("models/Soldier.glb");
      TacticalOperator.models.soldier = soldier;
      TacticalOperator.isFallbackActive = !soldier;
      TacticalOperator.modelStatus = soldier ? "RIGGED_GLB" : "FALLBACK_PROCEDURAL";
      if (!soldier) console.warn("[TacticalOperator] Vanguard GLB unavailable. Using the procedural fallback.");
      TacticalOperator.updateDevOverlayStatus();
    })();

    return TacticalOperator.models.loadingPromise;
  }

  constructor(scene, options = {}) {
    this.scene = scene;
    this.isEnemy = !!options.isEnemy;
    this.isFemale = !!options.isFemale;
    this.team = options.team || (this.isEnemy ? 'red' : 'blue');
    this.callsign = options.callsign || (this.isEnemy ? (this.isFemale ? "Valkyrie_02" : "Hostile_Operator") : "TaskForce_Ghost");
    this.initialPosition = options.position || new THREE.Vector3(0, 0, 0);

    // Combat Vitals
    this.maxHealth = 100;
    this.health = 100;
    this.isDead = false;
    this.deathTimer = 0;
    this.hitFlinchTimer = 0;

    // Animation & Procedural Rig State
    this.mixer = null;
    this.actions = {};
    this.currentAction = 'idle';
    this.walkCycle = Math.random() * Math.PI * 2;
    this.idleCycle = Math.random() * Math.PI * 2;
    this.isCrouching = false;
    this.currentPitch = 0;
    this.currentSpeed = 0;

    // Weapon & Effects State
    this.currentWeaponKey = 'carbine';
    this.weaponGroup = null;
    this.weaponSocket = null;
    this.muzzlePoint = new THREE.Vector3(0, 0, -0.65);
    this.muzzleLight = null;
    this.muzzleSprite = null;
    this.muzzleTimer = 0;
    this.weaponRecoilOffset = 0;
    this.weaponRecoilPitch = 0;
    this.activeShells = [];

    // Rig Articulation Node References
    this.pelvisGroup = null;
    this.spineGroup = null;
    this.chestGroup = null;
    this.neckGroup = null;
    this.headGroup = null;
    this.rShoulderGroup = null;
    this.lShoulderGroup = null;
    this.rElbowGroup = null;
    this.lElbowGroup = null;
    this.rHandGroup = null;
    this.lHandGroup = null;
    this.rHipGroup = null;
    this.lHipGroup = null;
    this.rKneeGroup = null;
    this.lKneeGroup = null;

    // Root Group & Hitboxes
    this.root = new THREE.Group();
    this.root.userData.operator = this;
    this.modelRoot = null;
    this.headMesh = null;
    this.bodyMesh = null;
    this.healthBarFill = null;
    this.healthBarGroup = null;
    this.nameTagSprite = null;

    this.initMaterials();
    this.buildCharacter();
    this.root.position.copy(this.initialPosition);
    if (this.scene) {
      this.scene.add(this.root);
    }
    TacticalOperator.instances.push(this);
  }

  get bot() {
    return this._bot;
  }

  set bot(val) {
    this._bot = val;
    if (this.root) this.root.userData.bot = val;
    if (this.headMesh) {
      this.headMesh.userData.bot = val;
      this.headMesh.userData.isHead = true;
      this.headMesh.userData.isHeadshot = true;
    }
    if (this.bodyMesh) this.bodyMesh.userData.bot = val;
    if (this.headGroup) {
      this.headGroup.userData.bot = val;
      this.headGroup.userData.isHead = true;
      this.headGroup.userData.isHeadshot = true;
    }
    if (this.modelRoot) this.modelRoot.userData.bot = val;
  }

  get remotePlayer() {
    return this._remotePlayer;
  }

  set remotePlayer(val) {
    this._remotePlayer = val;
    if (this.root) this.root.userData.remotePlayer = val;
    if (this.headMesh) {
      this.headMesh.userData.remotePlayer = val;
      this.headMesh.userData.isHead = true;
      this.headMesh.userData.isHeadshot = true;
    }
    if (this.bodyMesh) this.bodyMesh.userData.remotePlayer = val;
    if (this.headGroup) {
      this.headGroup.userData.remotePlayer = val;
      this.headGroup.userData.isHead = true;
      this.headGroup.userData.isHeadshot = true;
    }
    if (this.modelRoot) this.modelRoot.userData.remotePlayer = val;
  }

  initMaterials() {
    const isBlue = this.team === 'blue';
    const accentHex = isBlue ? 0x00f0ff : 0xff0055;
    this.accentColor = new THREE.Color(accentHex);

    // Generate authentic procedural military textures if available
    let camoTex = null;
    let faceTex = null;
    let patchTex = null;
    if (typeof TextureGenerator !== 'undefined') {
      try {
        if (typeof TextureGenerator.createMulticamTexture === 'function') {
          camoTex = TextureGenerator.createMulticamTexture(this.team, this.isFemale);
        }
        if (typeof TextureGenerator.createHumanFaceTexture === 'function') {
          faceTex = TextureGenerator.createHumanFaceTexture(this.isFemale);
        }
        if (typeof TextureGenerator.createPatchTexture === 'function') {
          patchTex = TextureGenerator.createPatchTexture(this.team, 'CS-3D');
        }
      } catch (e) {
        console.warn('[TacticalOperator] Failed generating procedural textures:', e);
      }
    }

    this.materials = {
      // Authentic MultiCam tactical uniform fabric (camo pattern)
      uniform: new THREE.MeshStandardMaterial({
        map: camoTex,
        color: isBlue ? 0x242e3d : 0x3d3328,
        roughness: 0.78,
        metalness: 0.08
      }),
      // Coyote tan pants for female operator
      femalePants: new THREE.MeshStandardMaterial({
        map: camoTex,
        color: 0x5a4d3c,
        roughness: 0.75,
        metalness: 0.08
      }),
      // Plate carrier fabric (tan/coyote or dark charcoal with camo)
      plateCarrier: new THREE.MeshStandardMaterial({
        map: camoTex,
        color: this.isFemale ? 0x4f4232 : (isBlue ? 0x222a36 : 0x3d3228),
        roughness: 0.70,
        metalness: 0.12
      }),
      // Matte tactical polymer (helmet rails, radio, boots, straps)
      gearPolymer: new THREE.MeshStandardMaterial({
        color: 0x1c1f24,
        roughness: 0.45,
        metalness: 0.25
      }),
      // Ballistic Sunglasses polarized lens (dark smoke polarized tint)
      sunglassesLens: new THREE.MeshStandardMaterial({
        color: 0x0e141d,
        roughness: 0.12,
        metalness: 0.75,
        transparent: true,
        opacity: 0.85
      }),
      // Ballistic Sunglasses matte frame
      sunglassesFrame: new THREE.MeshStandardMaterial({
        color: 0x111317,
        roughness: 0.45,
        metalness: 0.35
      }),
      // Legacy goggleLens reference for optics/attachments
      goggleLens: new THREE.MeshStandardMaterial({
        color: accentHex,
        roughness: 0.1,
        metalness: 0.9,
        transparent: true,
        opacity: 0.85
      }),
      // Team identification subtle accent patch
      teamAccent: new THREE.MeshBasicMaterial({
        color: accentHex
      }),
      // Gunmetal metal for weapon receivers, barrels & rails
      metal: new THREE.MeshStandardMaterial({
        color: 0x1c212a,
        roughness: 0.35,
        metalness: 0.85
      }),
      // Coyote tan polymer for rifle magazines & furniture
      tanPolymer: new THREE.MeshStandardMaterial({
        color: 0x826c50,
        roughness: 0.6,
        metalness: 0.2
      }),
      // Authentic adult human skin tone
      skin: new THREE.MeshStandardMaterial({
        color: this.isFemale ? 0xd4a58a : 0xc8967b,
        roughness: 0.60,
        metalness: 0.02
      }),
      // Human face with facial features (eyes, eyebrows, lips, shading)
      face: new THREE.MeshStandardMaterial({
        map: faceTex,
        color: this.isFemale ? 0xffffff : 0xf4eee8,
        roughness: 0.58,
        metalness: 0.02
      }),
      // Balaclava dark fabric fallback
      balaclava: new THREE.MeshStandardMaterial({
        color: 0x1b1f26,
        roughness: 0.85,
        metalness: 0.05
      }),
      // Dark tactical operator hair
      hair: new THREE.MeshStandardMaterial({
        color: this.isFemale ? 0x2c1f19 : 0x1c1714,
        roughness: 0.85
      }),
      // Brass for ejected shell casings
      brass: new THREE.MeshStandardMaterial({
        color: 0xd4af37,
        roughness: 0.25,
        metalness: 0.90
      }),
      // Velcro team/moral patch
      patch: patchTex
        ? new THREE.MeshBasicMaterial({ map: patchTex, transparent: true })
        : new THREE.MeshBasicMaterial({ color: accentHex })
    };
  }

  buildCharacter() {
    const sourceGltf = this.isFemale ? null : TacticalOperator.models.soldier;

    if (sourceGltf && typeof THREE.SkeletonUtils !== 'undefined') {
      this.buildRiggedGLBModel(sourceGltf);
    } else {
      this.buildProceduralAnatomicalModel();
    }

    // Attach Hitboxes for Raycasting Combat
    this.buildHitboxes();

    // Attach Overhead Nameplate & Floating Health Bar
    this.buildOverheadHUD();
  }

  findBoneRegex(pattern) {
    if (!this.modelRoot) return null;
    let found = null;
    this.modelRoot.traverse((bone) => {
      if (bone.isBone && !found && pattern.test(bone.name)) {
        found = bone;
      }
    });
    return found;
  }

  buildRiggedGLBModel(sourceGltf) {
    this.modelRoot = THREE.SkeletonUtils.clone(sourceGltf.scene);

    // Measure the posed vertices once per asset. Bind-pose geometry bounds
    // alone can be much smaller than the rendered skin, as with Xbot.
    let bbox = TacticalOperator.rigBounds.get(sourceGltf);
    if (!bbox) {
      bbox = TacticalOperator.measureRigBounds(this.modelRoot);
      TacticalOperator.rigBounds.set(sourceGltf, bbox);
    }
    const rawHeight = bbox.max.y - bbox.min.y;
    const targetHeight = this.isFemale ? 1.74 : 1.82;
    const scale = targetHeight / Math.max(0.001, rawHeight);
    this.modelRoot.scale.multiplyScalar(scale);
    this.modelGroundOffset = -bbox.min.y * scale;
    this.modelRoot.position.y = this.modelGroundOffset;
    this.modelRoot.rotation.y = Math.PI;

    // Enable shadows and set textures to sRGB (preserving authored materials, no flat-color lerp)
    this.modelRoot.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material && child.material.map) {
          if (typeof THREE.SRGBColorSpace !== 'undefined') {
            child.material.map.colorSpace = THREE.SRGBColorSpace;
          } else if (typeof THREE.sRGBEncoding !== 'undefined') {
            child.material.map.encoding = THREE.sRGBEncoding;
          }
        }
      }
    });

    this.root.add(this.modelRoot);

    // Rigged animation clips with regex mapping and crossFade
    if (sourceGltf.animations && sourceGltf.animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(this.modelRoot);
      const findClip = (pattern) => {
        return sourceGltf.animations.find(a => pattern.test(a.name)) || null;
      };

      const idleClip = findClip(/idle/i);
      const walkClip = findClip(/walk|jog/i);
      const runClip = findClip(/run|sprint/i);
      const fireClip = findClip(/fire|shoot|attack/i);
      const reloadClip = findClip(/reload/i);
      const hitClip = findClip(/hit|damage|flinch/i);
      const deathClip = findClip(/death|die/i);

      if (idleClip) this.actions.idle = this.mixer.clipAction(idleClip);
      if (walkClip) this.actions.walk = this.mixer.clipAction(walkClip);
      if (runClip) this.actions.run = this.mixer.clipAction(runClip);
      if (fireClip) this.actions.fire = this.mixer.clipAction(fireClip);
      if (reloadClip) this.actions.reload = this.mixer.clipAction(reloadClip);
      if (hitClip) this.actions.hit = this.mixer.clipAction(hitClip);
      if (deathClip) {
        const deathAct = this.mixer.clipAction(deathClip);
        deathAct.setLoop(THREE.LoopOnce);
        deathAct.clampWhenFinished = true;
        this.actions.death = deathAct;
      }

      if (this.actions.idle) {
        this.actions.idle.play();
        this.currentAction = 'idle';
      }
    }

    this.attachGearToRiggedBones();
  }

  attachGearToRiggedBones() {
    this.headBone = this.findBoneRegex(/(?:^|[:_])(head)$/i) || this.findBoneRegex(/head/i);
    this.spineBone = this.findBoneRegex(/(?:^|[:_])(spine2?|chest)$/i);
    const arm = side => ['Arm', 'ForeArm', 'Hand'].map(joint =>
      this.findBoneRegex(new RegExp(`^(?:mixamorig[:_]?)?${side}${joint}$`, 'i')));
    this.mountCombatWeapon(this.modelRoot, arm('Right'), arm('Left'), -1);
  }

  mountCombatWeapon(frame, right, left, forward = 1) {
    this.weaponForward = forward;
    this.weaponSocket = new THREE.Group();
    frame.add(this.weaponSocket);
    this.weaponArms = [right, left].every(chain => chain.every(Boolean)) ? [right, left] : null;
    this.weaponGroup = this.buildWeaponModel(this.currentWeaponKey);
    this.weaponSocket.add(this.weaponGroup);
    this.updateWeaponPose(0, 0);
  }

  updateWeaponPose(delta, pitch) {
    if (!this.weaponArms) return;
    const [right, left] = this.weaponArms;
    const frame = this.weaponSocket.parent;
    frame.updateWorldMatrix(true, false);
    const shoulder = chain => frame.worldToLocal(chain[0].getWorldPosition(new THREE.Vector3()));
    const rightShoulder = shoulder(right);
    const leftShoulder = shoulder(left);
    const rightSide = Math.sign(rightShoulder.x - leftShoulder.x);
    const unit = frame.getWorldScale(new THREE.Vector3()).x;
    const [grip, support] = this.weaponGroup.userData.handSockets;
    const calibration = TacticalOperator.currentWeaponCalibration;
    const defaults = TacticalOperator.defaultWeaponCalibration;
    this.weaponGroup.position.set(calibration.posX - defaults.posX, calibration.posY - defaults.posY, calibration.posZ - defaults.posZ);
    this.weaponGroup.rotation.set(calibration.rotX - defaults.rotX, calibration.rotY - defaults.rotY, calibration.rotZ - defaults.rotZ);

    this.weaponRecoilOffset *= Math.exp(-18 * delta);
    this.weaponRecoilPitch *= Math.exp(-18 * delta);
    this.weaponSocket.scale.setScalar(1 / unit);
    this.weaponSocket.position.copy(rightShoulder).lerp(leftShoulder, 0.38);
    this.weaponSocket.position.y -= 0.045 / unit;
    const forward = this.weaponForward;
    this.weaponSocket.position.z += forward * (0.205 - this.weaponRecoilOffset) / unit;
    const aimPitch = THREE.MathUtils.clamp(pitch, -0.65, 0.65) + this.weaponRecoilPitch;
    this.weaponSocket.rotation.set(aimPitch, forward > 0 ? Math.PI : 0, 0, 'YXZ');

    this.weaponGroup.updateWorldMatrix(true, false);
    for (const [chain, target, side, roll] of [[right, grip, rightSide, 0], [left, support, -rightSide, 0.9]]) {
      const goal = this.weaponGroup.localToWorld(target.clone());
      const pole = frame.localToWorld(new THREE.Vector3(side * 0.7 / unit, rightShoulder.y - 0.45 / unit, rightShoulder.z));
      this.solveWeaponArm(chain, goal, pole);
      // Align each palm with the handle or the underside of the handguard.
      const hand = chain[2];
      const handDirection = hand.isBone
        ? hand.children.find(child => child.isBone && /middle/i.test(child.name))?.position
        : new THREE.Vector3(0, -1, 0);
      if (handDirection?.lengthSq()) {
        const desired = new THREE.Vector3(0, -1, -roll).normalize()
          .applyQuaternion(this.weaponSocket.getWorldQuaternion(new THREE.Quaternion()));
        this.pointJoint(hand, handDirection, desired);
      }
    }
  }

  pointJoint(joint, localAxis, worldDirection) {
    const inverseParent = joint.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    const desired = worldDirection.clone().normalize().applyQuaternion(inverseParent);
    const current = localAxis.clone().normalize().applyQuaternion(joint.quaternion);
    joint.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(current, desired));
  }

  solveWeaponArm([upper, forearm, hand], goal, pole) {
    const origin = upper.getWorldPosition(new THREE.Vector3());
    const elbow = forearm.getWorldPosition(new THREE.Vector3());
    const wrist = hand.getWorldPosition(new THREE.Vector3());
    const upperLength = origin.distanceTo(elbow);
    const lowerLength = elbow.distanceTo(wrist);
    const axis = goal.clone().sub(origin);
    const distance = THREE.MathUtils.clamp(axis.length(), Math.abs(upperLength - lowerLength) + 0.001, upperLength + lowerLength - 0.001);
    axis.normalize();
    const bend = pole.sub(origin);
    bend.addScaledVector(axis, -bend.dot(axis)).normalize();
    const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
    const elbowDirection = axis.clone().multiplyScalar(along)
      .addScaledVector(bend, Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2)));
    this.pointJoint(upper, forearm.position, elbowDirection);
    this.pointJoint(forearm, hand.position, axis.multiplyScalar(distance).sub(elbowDirection));
  }

  /**
   * Rebuilds the procedural anatomical human tactical operator rig.
   * Articulated joint hierarchy:
   *   Pelvis (Root, y ~ 0.94m)
   *     ├── Spine -> Chest -> Neck -> Head
   *     ├── Shoulders -> Upper Arms -> Elbows -> Forearms -> Hands / Gloves -> Weapon
   *     └── Hips -> Upper Legs / Thighs -> Knees -> Lower Legs / Shins -> Boots
   */
  buildProceduralAnatomicalModel() {
    this.modelRoot = new THREE.Group();
    const scale = this.isFemale ? 0.96 : 1.0;
    this.modelRoot.scale.set(scale, scale, scale);

    const { uniform, femalePants, gearPolymer, balaclava } = this.materials;
    const pantsMat = this.isFemale ? femalePants : uniform;

    // 1. Pelvis / Hips Root Group (Center of gravity at ~0.94m)
    this.pelvisGroup = new THREE.Group();
    this.pelvisGroup.position.set(0, 0.94, 0);

    // Tactical combat belt with molded buckle
    const beltGeo = new THREE.CylinderGeometry(0.19, 0.18, 0.12, 12);
    const belt = new THREE.Mesh(beltGeo, gearPolymer);
    belt.castShadow = true;
    this.pelvisGroup.add(belt);

    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.02), this.materials.metal);
    buckle.position.set(0, 0, 0.19);
    this.pelvisGroup.add(buckle);

    // 2. Spine & Torso Group (Pivots from Pelvis)
    this.spineGroup = new THREE.Group();
    this.spineGroup.position.set(0, 0.06, 0);
    this.pelvisGroup.add(this.spineGroup);

    // Abdomen / Lower Torso
    const lowerTorsoGeo = new THREE.CylinderGeometry(0.18, 0.17, 0.16, 12);
    const lowerTorso = new THREE.Mesh(lowerTorsoGeo, uniform);
    lowerTorso.position.set(0, 0.08, 0);
    lowerTorso.castShadow = true;
    this.spineGroup.add(lowerTorso);

    // Chest Group (Upper Torso)
    this.chestGroup = new THREE.Group();
    this.chestGroup.position.set(0, 0.20, 0);
    this.spineGroup.add(this.chestGroup);

    // Upper Torso Mesh
    const chestGeo = new THREE.CylinderGeometry(0.20, 0.18, 0.24, 12);
    const chest = new THREE.Mesh(chestGeo, uniform);
    chest.position.set(0, 0.12, 0);
    chest.castShadow = true;
    this.chestGroup.add(chest);

    // Plate Carrier Gear
    const plateCarrier = this.buildPlateCarrierGear();
    plateCarrier.position.set(0, 0.12, 0);
    this.chestGroup.add(plateCarrier);

    // Triple Magazine Pouches on Abdomen
    const magPouches = this.buildTripleMagPouches();
    magPouches.position.set(0, -0.02, 0.15);
    this.chestGroup.add(magPouches);

    // 3. Neck & Head Group (Pivots from Chest)
    this.neckGroup = new THREE.Group();
    this.neckGroup.position.set(0, 0.26, 0);
    this.chestGroup.add(this.neckGroup);

    // Anatomical collar (tactical uniform shirt collar at base of neck)
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.082, 0.035, 12), uniform);
    collar.position.set(0, 0.018, 0);
    this.neckGroup.add(collar);

    // Human neck with authentic skin
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.068, 0.09, 12), this.materials.skin);
    neck.position.set(0, 0.065, 0);
    neck.castShadow = true;
    this.neckGroup.add(neck);

    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 0.12, 0);
    this.neckGroup.add(this.headGroup);

    // Authentic Tactical Operator Head with Form-Fitting Combat Balaclava
    const headGeo = new THREE.SphereGeometry(0.125, 18, 16);
    const headBase = new THREE.Mesh(headGeo, this.materials.balaclava);
    headBase.position.set(0, 0.04, 0);
    headBase.castShadow = true;
    this.headGroup.add(headBase);

    // Anatomical Eye Opening revealing authentic human skin
    const eyeCutout = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.040, 0.012), this.materials.skin);
    eyeCutout.position.set(0, 0.036, 0.122);
    this.headGroup.add(eyeCutout);

    // Left & Right Sclera (Human Eyeballs)
    const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.2 });
    const eyeIrisMat = new THREE.MeshStandardMaterial({ color: 0x3d4f5d, roughness: 0.3 });

    const lEyeWhite = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.013, 0.005), eyeWhiteMat);
    lEyeWhite.position.set(-0.036, 0.036, 0.127);
    this.headGroup.add(lEyeWhite);

    const lIris = new THREE.Mesh(new THREE.BoxGeometry(0.013, 0.013, 0.006), eyeIrisMat);
    lIris.position.set(-0.036, 0.036, 0.129);
    this.headGroup.add(lIris);

    const rEyeWhite = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.013, 0.005), eyeWhiteMat);
    rEyeWhite.position.set(0.036, 0.036, 0.127);
    this.headGroup.add(rEyeWhite);

    const rIris = new THREE.Mesh(new THREE.BoxGeometry(0.013, 0.013, 0.006), eyeIrisMat);
    rIris.position.set(0.036, 0.036, 0.129);
    this.headGroup.add(rIris);

    // Balaclava nose bridge definition (clean fabric ridge)
    const noseRidge = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.032, 0.016), this.materials.balaclava);
    noseRidge.position.set(0, 0.028, 0.129);
    this.headGroup.add(noseRidge);

    // Headgear (FAST Helmet / Ballistic Eyewear / Comms Headset OR Female Cap + Ponytail)
    const headGear = this.isFemale ? this.buildFemaleHeadGear() : this.buildMaleHeadGear();
    headGear.position.set(0, 0.04, 0);
    this.headGroup.add(headGear);

    // 4. Arms & Two-Handed Weapon Hold
    // Right Shoulder Joint
    this.rShoulderGroup = new THREE.Group();
    this.rShoulderGroup.position.set(0.22, 0.22, 0.02);
    this.chestGroup.add(this.rShoulderGroup);

    const rDeltoid = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 8), uniform);
    this.rShoulderGroup.add(rDeltoid);

    const rUpperArmGeo = new THREE.CylinderGeometry(0.052, 0.046, 0.24, 10);
    const rUpperArm = new THREE.Mesh(rUpperArmGeo, uniform);
    rUpperArm.position.set(0, -0.12, 0);
    rUpperArm.castShadow = true;
    this.rShoulderGroup.add(rUpperArm);

    // Right Elbow Joint
    this.rElbowGroup = new THREE.Group();
    this.rElbowGroup.position.set(0, -0.24, 0);
    this.rShoulderGroup.add(this.rElbowGroup);

    // Rolled combat sleeve cuff
    const rCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.050, 0.035, 10), uniform);
    rCuff.position.set(0, -0.018, 0);
    this.rElbowGroup.add(rCuff);

    // Long uniform sleeve
    const rForearmGeo = new THREE.CylinderGeometry(0.045, 0.038, 0.19, 10);
    const rForearm = new THREE.Mesh(rForearmGeo, uniform);
    rForearm.position.set(0, -0.12, 0);
    rForearm.castShadow = true;
    this.rElbowGroup.add(rForearm);

    // Right Hand / Tactical Glove & Weapon Grip Socket
    this.rHandGroup = new THREE.Group();
    this.rHandGroup.position.set(0, -0.22, 0);
    this.rElbowGroup.add(this.rHandGroup);

    const rGlove = this.buildTacticalGlove(false);
    this.rHandGroup.add(rGlove);

    // Left Shoulder Joint
    this.lShoulderGroup = new THREE.Group();
    this.lShoulderGroup.position.set(-0.22, 0.22, 0.02);
    this.chestGroup.add(this.lShoulderGroup);

    const lDeltoid = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 8), uniform);
    this.lShoulderGroup.add(lDeltoid);

    const lUpperArmGeo = new THREE.CylinderGeometry(0.052, 0.046, 0.24, 10);
    const lUpperArm = new THREE.Mesh(lUpperArmGeo, uniform);
    lUpperArm.position.set(0, -0.12, 0);
    lUpperArm.castShadow = true;
    this.lShoulderGroup.add(lUpperArm);

    // Left Elbow Joint
    this.lElbowGroup = new THREE.Group();
    this.lElbowGroup.position.set(0, -0.24, 0);
    this.lShoulderGroup.add(this.lElbowGroup);

    // Rolled combat sleeve cuff
    const lCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.050, 0.035, 10), uniform);
    lCuff.position.set(0, -0.018, 0);
    this.lElbowGroup.add(lCuff);

    // Long uniform sleeve
    const lForearmGeo = new THREE.CylinderGeometry(0.045, 0.038, 0.19, 10);
    const lForearm = new THREE.Mesh(lForearmGeo, uniform);
    lForearm.position.set(0, -0.12, 0);
    lForearm.castShadow = true;
    this.lElbowGroup.add(lForearm);

    // Tactical GPS Field Watch on Left Wrist
    const watchBand = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.022, 10), gearPolymer);
    watchBand.position.set(0, -0.18, 0);
    this.lElbowGroup.add(watchBand);

    const watchFace = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.016, 0.026), this.materials.metal);
    watchFace.position.set(0, -0.18, 0.038);
    this.lElbowGroup.add(watchFace);

    // Left Hand / Tactical Glove (Supporting handguard)
    this.lHandGroup = new THREE.Group();
    this.lHandGroup.position.set(0, -0.22, 0);
    this.lElbowGroup.add(this.lHandGroup);

    const lGlove = this.buildTacticalGlove(true);
    this.lHandGroup.add(lGlove);

    // 5. Lower Body (Hips, Thighs, Knees, Shins, Boots)
    // Right Hip Joint
    this.rHipGroup = new THREE.Group();
    this.rHipGroup.position.set(0.12, -0.04, 0);
    this.pelvisGroup.add(this.rHipGroup);

    const rThighGeo = new THREE.CylinderGeometry(0.078, 0.068, 0.40, 10);
    const rThigh = new THREE.Mesh(rThighGeo, pantsMat);
    rThigh.position.set(0, -0.20, 0);
    rThigh.castShadow = true;
    this.rHipGroup.add(rThigh);

    const holster = this.buildDropLegHolster();
    holster.position.set(0.07, -0.16, 0);
    this.rHipGroup.add(holster);

    // Right Knee Joint
    this.rKneeGroup = new THREE.Group();
    this.rKneeGroup.position.set(0, -0.40, 0);
    this.rHipGroup.add(this.rKneeGroup);

    const rKneePad = this.buildKneePad();
    rKneePad.position.set(0, 0, 0.065);
    this.rKneeGroup.add(rKneePad);

    const rShinGeo = new THREE.CylinderGeometry(0.065, 0.055, 0.38, 10);
    const rShin = new THREE.Mesh(rShinGeo, pantsMat);
    rShin.position.set(0, -0.19, 0);
    rShin.castShadow = true;
    this.rKneeGroup.add(rShin);

    const rBoot = this.buildCombatBoot();
    rBoot.position.set(0, -0.42, 0.03);
    this.rKneeGroup.add(rBoot);

    // Left Hip Joint
    this.lHipGroup = new THREE.Group();
    this.lHipGroup.position.set(-0.12, -0.04, 0);
    this.pelvisGroup.add(this.lHipGroup);

    const lThighGeo = new THREE.CylinderGeometry(0.078, 0.068, 0.40, 10);
    const lThigh = new THREE.Mesh(lThighGeo, pantsMat);
    lThigh.position.set(0, -0.20, 0);
    lThigh.castShadow = true;
    this.lHipGroup.add(lThigh);

    const thighPouches = this.buildDualThighPouches();
    thighPouches.position.set(-0.07, -0.16, 0);
    this.lHipGroup.add(thighPouches);

    // Left Knee Joint
    this.lKneeGroup = new THREE.Group();
    this.lKneeGroup.position.set(0, -0.40, 0);
    this.lHipGroup.add(this.lKneeGroup);

    const lKneePad = this.buildKneePad();
    lKneePad.position.set(0, 0, 0.065);
    this.lKneeGroup.add(lKneePad);

    const lShinGeo = new THREE.CylinderGeometry(0.065, 0.055, 0.38, 10);
    const lShin = new THREE.Mesh(lShinGeo, pantsMat);
    lShin.position.set(0, -0.19, 0);
    lShin.castShadow = true;
    this.lKneeGroup.add(lShin);

    const lBoot = this.buildCombatBoot();
    lBoot.position.set(0, -0.42, 0.03);
    this.lKneeGroup.add(lBoot);

    this.modelRoot.add(this.pelvisGroup);
    this.root.add(this.modelRoot);
    this.mountCombatWeapon(this.pelvisGroup,
      [this.rShoulderGroup, this.rElbowGroup, this.rHandGroup],
      [this.lShoulderGroup, this.lElbowGroup, this.lHandGroup]);
  }

  buildCombatBoot() {
    const group = new THREE.Group();
    const { gearPolymer } = this.materials;

    // Boot Foot Section (Rounded Box)
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.22), gearPolymer);
    foot.position.set(0, 0.045, 0.02);
    foot.castShadow = true;
    group.add(foot);

    // Ankle Collar
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.058, 0.12, 10), gearPolymer);
    collar.position.set(0, 0.11, -0.01);
    group.add(collar);

    // Heavy Rubber Tread Lug Sole
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.024, 0.23), this.materials.metal);
    sole.position.set(0, 0.012, 0.02);
    group.add(sole);

    return group;
  }

  buildMaleHeadGear() {
    const group = new THREE.Group();
    const { gearPolymer, uniform, sunglassesFrame, sunglassesLens, hair, teamAccent, metal } = this.materials;

    // Cropped Tactical Buzz Cut Hair (visible beneath helmet / around temples and nape)
    const hairNape = new THREE.Mesh(new THREE.CylinderGeometry(0.122, 0.126, 0.06, 14), hair);
    hairNape.position.set(0, 0.01, -0.02);
    group.add(hairNape);

    // FAST Tactical High-Cut Helmet Shell with authentic MultiCam camouflage cover
    const helmetShell = new THREE.Mesh(
      new THREE.SphereGeometry(0.136, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.54),
      uniform
    );
    helmetShell.position.set(0, 0.045, -0.008);
    helmetShell.castShadow = true;
    group.add(helmetShell);

    // Helmet Lower Rubber Edge Rim
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.134, 0.008, 6, 20), gearPolymer);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, 0.038, -0.008);
    group.add(rim);

    // Front Wilcox NVG Shroud Mount Bracket
    const nvgMount = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.048, 0.016), gearPolymer);
    nvgMount.position.set(0, 0.068, 0.132);
    group.add(nvgMount);

    const nvgSocket = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.018, 8), metal);
    nvgSocket.position.set(0, 0.068, 0.141);
    nvgSocket.rotation.x = Math.PI / 2;
    group.add(nvgSocket);

    // Side ARC Accessory Rails
    const leftRail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.028, 0.11), gearPolymer);
    leftRail.position.set(-0.134, 0.042, 0.01);
    group.add(leftRail);

    const rightRail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.028, 0.11), gearPolymer);
    rightRail.position.set(0.134, 0.042, 0.01);
    group.add(rightRail);

    // Tactical Chinstrap (4-point harness hugging the jawline - unmistakably human military)
    const leftStrap = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.09, 6), gearPolymer);
    leftStrap.position.set(-0.09, -0.02, 0.02);
    leftStrap.rotation.z = -0.45;
    group.add(leftStrap);

    const rightStrap = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.09, 6), gearPolymer);
    rightStrap.position.set(0.09, -0.02, 0.02);
    rightStrap.rotation.z = 0.45;
    group.add(rightStrap);

    // AUTHENTIC MILITARY BALLISTIC SUNGLASSES (Oakley M-Frame tactical shades)
    // Dark polarized smoke lenses resting realistically on nose bridge, letting face be seen
    const leftLens = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.026, 0.008), sunglassesLens);
    leftLens.position.set(-0.038, 0.022, 0.128);
    leftLens.rotation.y = 0.15;
    group.add(leftLens);

    const rightLens = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.026, 0.008), sunglassesLens);
    rightLens.position.set(0.038, 0.022, 0.128);
    rightLens.rotation.y = -0.15;
    group.add(rightLens);

    // Sunglasses Matte Frame & Bridge
    const glassesBridge = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.007, 0.010), sunglassesFrame);
    glassesBridge.position.set(0, 0.032, 0.132);
    group.add(glassesBridge);

    const glassesBrowbar = new THREE.Mesh(new THREE.BoxGeometry(0.132, 0.006, 0.012), sunglassesFrame);
    glassesBrowbar.position.set(0, 0.036, 0.126);
    group.add(glassesBrowbar);

    // Glasses Temples (arms reaching back towards ears)
    const lTemple = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.006, 0.11), sunglassesFrame);
    lTemple.position.set(-0.082, 0.032, 0.065);
    group.add(lTemple);

    const rTemple = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.006, 0.11), sunglassesFrame);
    rTemple.position.set(0.082, 0.032, 0.065);
    group.add(rTemple);

    // Comms Headset with Boom Mic
    const leftCup = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.028, 10), gearPolymer);
    leftCup.rotation.z = Math.PI / 2;
    leftCup.position.set(-0.136, 0.01, -0.01);
    group.add(leftCup);

    const rightCup = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.028, 10), gearPolymer);
    rightCup.rotation.z = Math.PI / 2;
    rightCup.position.set(0.136, 0.01, -0.01);
    group.add(rightCup);

    const boomMic = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.12, 6), gearPolymer);
    boomMic.position.set(-0.11, -0.03, 0.06);
    boomMic.rotation.x = Math.PI / 3;
    group.add(boomMic);

    // Rear Team Identification Velcro Tab
    const rearTag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.024, 0.006), teamAccent);
    rearTag.position.set(0, 0.045, -0.138);
    group.add(rearTag);

    return group;
  }

  buildFemaleHeadGear() {
    const group = new THREE.Group();
    const { uniform, hair, teamAccent, gearPolymer, sunglassesFrame, sunglassesLens } = this.materials;

    // Female Hair Layer (textured sides & crown)
    const hairSides = new THREE.Mesh(
      new THREE.SphereGeometry(0.128, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.60),
      hair
    );
    hairSides.position.set(0, 0.035, -0.01);
    group.add(hairSides);

    // Tactical Operator Low-Profile Cap
    const capCrown = new THREE.Mesh(
      new THREE.SphereGeometry(0.134, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.48),
      uniform
    );
    capCrown.position.set(0, 0.05, 0);
    group.add(capCrown);

    // Forward Cap Brim / Visor
    const capBrim = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.008, 0.09), uniform);
    capBrim.position.set(0, 0.032, 0.14);
    capBrim.rotation.x = -0.15;
    group.add(capBrim);

    // Rear Ponytail Exit Aperture & Flowing Styled Hair
    const ponytail = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.034, 0.30, 10), hair);
    ponytail.position.set(0, -0.06, -0.19);
    ponytail.rotation.x = -0.42;
    group.add(ponytail);

    const hairTie = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.016, 10), gearPolymer);
    hairTie.position.set(0, 0.02, -0.14);
    hairTie.rotation.x = -0.42;
    group.add(hairTie);

    // Ballistic Sunglasses Resting up on Cap Crown
    const leftLens = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.024, 0.008), sunglassesLens);
    leftLens.position.set(-0.034, 0.076, 0.10);
    leftLens.rotation.x = -0.32;
    group.add(leftLens);

    const rightLens = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.024, 0.008), sunglassesLens);
    rightLens.position.set(0.034, 0.076, 0.10);
    rightLens.rotation.x = -0.32;
    group.add(rightLens);

    const goggleFrame = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.006, 0.010), sunglassesFrame);
    goggleFrame.position.set(0, 0.088, 0.095);
    goggleFrame.rotation.x = -0.32;
    group.add(goggleFrame);

    // Front Velcro Morale Patch
    const capPatch = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.026, 0.006), teamAccent);
    capPatch.position.set(0, 0.072, 0.126);
    group.add(capPatch);

    // Comms Earpiece on Left Ear
    const commsEarpiece = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.025, 0.018), gearPolymer);
    commsEarpiece.position.set(-0.126, 0.035, -0.01);
    group.add(commsEarpiece);

    const commsMic = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.10, 6), gearPolymer);
    commsMic.position.set(-0.10, 0.00, 0.06);
    commsMic.rotation.x = Math.PI / 3;
    group.add(commsMic);

    return group;
  }

  buildPlateCarrierGear() {
    const group = new THREE.Group();
    const { plateCarrier, gearPolymer, patch, teamAccent } = this.materials;

    // Front Ballistic SAPI Plate Pocket with MOLLE Ribs
    const frontPlate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.34, 0.09), plateCarrier);
    frontPlate.position.set(0, 0.02, 0.10);
    group.add(frontPlate);

    // CS-3D Velcro Chest Patch
    const chestPatch = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.075, 0.008), patch);
    chestPatch.position.set(0, 0.10, 0.148);
    group.add(chestPatch);

    // Shoulder Straps with wire routing
    const lStrap = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.22), plateCarrier);
    lStrap.position.set(-0.16, 0.18, 0);
    group.add(lStrap);

    const rStrap = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.22), plateCarrier);
    rStrap.position.set(0.16, 0.18, 0);
    group.add(rStrap);

    // Tactical Shoulder Radio (PRC-152) on Left Chest
    const radio = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.11, 0.038), gearPolymer);
    radio.position.set(-0.16, 0.08, 0.14);
    group.add(radio);

    // Flexible Whip Radio Antenna
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.26, 6), gearPolymer);
    antenna.position.set(-0.17, 0.24, 0.12);
    antenna.rotation.z = -0.12;
    group.add(antenna);

    // Rear Compact Assault Hydration Pack
    const backPack = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.30, 0.075), plateCarrier);
    backPack.position.set(0, 0.02, -0.13);
    group.add(backPack);

    // Team Accent on Upper Back
    const backPatch = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.035, 0.006), teamAccent);
    backPatch.position.set(0, 0.12, -0.17);
    group.add(backPatch);

    return group;
  }

  buildTripleMagPouches() {
    const group = new THREE.Group();
    const { plateCarrier, tanPolymer, gearPolymer } = this.materials;

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.042), plateCarrier);
    group.add(chassis);

    const offsets = [-0.085, 0, 0.085];
    offsets.forEach((x) => {
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.10, 0.048), tanPolymer);
      mag.position.set(x, 0.04, 0.01);
      group.add(mag);

      const pullTab = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.012, 0.012), gearPolymer);
      pullTab.position.set(x, 0.095, 0.01);
      group.add(pullTab);
    });

    return group;
  }

  buildDropLegHolster() {
    const group = new THREE.Group();
    const { gearPolymer, metal, uniform } = this.materials;

    // Dual Thigh Straps
    const upperStrap = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.028, 0.18), uniform);
    upperStrap.position.set(0, 0.06, 0);
    group.add(upperStrap);

    const lowerStrap = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.028, 0.18), uniform);
    lowerStrap.position.set(0, -0.06, 0);
    group.add(lowerStrap);

    // Molded Kydex Holster
    const holsterBody = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.16, 0.065), gearPolymer);
    holsterBody.position.set(0.04, 0, 0);
    group.add(holsterBody);

    // Holstered Sidearm Pistol
    const pistolSlide = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.04, 0.12), metal);
    pistolSlide.position.set(0.04, 0.06, -0.01);
    group.add(pistolSlide);

    const pistolGrip = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.085, 0.042), gearPolymer);
    pistolGrip.position.set(0.04, 0.10, 0.04);
    pistolGrip.rotation.x = -0.3;
    group.add(pistolGrip);

    return group;
  }

  buildDualThighPouches() {
    const group = new THREE.Group();
    const { plateCarrier, gearPolymer, uniform } = this.materials;

    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.03, 0.18), uniform);
    group.add(strap);

    const pouch1 = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.13, 0.05), plateCarrier);
    pouch1.position.set(-0.035, 0, -0.03);
    group.add(pouch1);

    const pouch2 = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.13, 0.05), plateCarrier);
    pouch2.position.set(-0.035, 0, 0.03);
    group.add(pouch2);

    const flap1 = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.035, 0.054), gearPolymer);
    flap1.position.set(-0.035, 0.065, -0.03);
    group.add(flap1);

    const flap2 = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.035, 0.054), gearPolymer);
    flap2.position.set(-0.035, 0.065, 0.03);
    group.add(flap2);

    return group;
  }

  buildKneePad() {
    const group = new THREE.Group();
    const { gearPolymer, uniform } = this.materials;

    const padShell = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.045), gearPolymer);
    padShell.castShadow = true;
    group.add(padShell);

    const strap1 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.024, 0.14), uniform);
    strap1.position.set(0, 0.045, -0.04);
    group.add(strap1);

    const strap2 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.024, 0.14), uniform);
    strap2.position.set(0, -0.045, -0.04);
    group.add(strap2);

    return group;
  }

  buildTacticalGlove(isLeft = false) {
    const group = new THREE.Group();
    const { gearPolymer, tanPolymer } = this.materials;

    // Tactical shooting glove palm & fingers (tan/coyote combat leather)
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.088, 0.042), tanPolymer || gearPolymer);
    group.add(glove);

    // Molded carbon-fiber knuckle protector
    const knuckleGuard = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.026, 0.032), gearPolymer);
    knuckleGuard.position.set(0, 0.025, isLeft ? -0.016 : 0.016);
    group.add(knuckleGuard);

    // Wrist cinch velcro strap
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.016, 0.044), gearPolymer);
    strap.position.set(0, -0.032, 0);
    group.add(strap);

    return group;
  }

  /**
   * Builds high-detail weapon models with proper muzzle points and sockets
   */
  buildWeaponModel(weaponKey = 'carbine') {
    const group = new THREE.Group();
    const { metal, gearPolymer, tanPolymer, goggleLens } = this.materials;

    if (weaponKey === 'smg') {
      // Vector-9 SMG (Tactical Compact Submachine Gun)
      const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.095, 0.28), metal);
      group.add(receiver);

      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.012, 0.24), gearPolymer);
      rail.position.set(0, 0.054, -0.01);
      group.add(rail);

      const optic = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.035, 0.06), gearPolymer);
      optic.position.set(0, 0.078, -0.02);
      group.add(optic);

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.16, 10), metal);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.02, -0.22);
      group.add(barrel);

      const comp = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.020, 0.06, 10), metal);
      comp.rotation.x = Math.PI / 2;
      comp.position.set(0, 0.02, -0.28);
      group.add(comp);

      const foregrip = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.065, 0.035), gearPolymer);
      foregrip.position.set(0, -0.045, -0.15);
      foregrip.rotation.x = 0.22;
      group.add(foregrip);

      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.20, 0.045), tanPolymer || gearPolymer);
      mag.position.set(0, -0.10, -0.03);
      mag.rotation.x = 0.22;
      group.add(mag);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.11, 0.045), gearPolymer);
      grip.position.set(0, -0.065, 0.08);
      grip.rotation.x = 0.35;
      group.add(grip);

      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.075, 0.16), gearPolymer);
      stock.position.set(0, 0.02, 0.20);
      group.add(stock);

      this.muzzlePoint.set(0, 0.02, -0.32);

    } else if (weaponKey === 'sniper') {
      // AWM-50 Precision Sniper Rifle
      const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.085, 0.44), metal);
      group.add(receiver);

      // Fluted heavy barrel
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.015, 0.60, 10), metal);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.02, -0.52);
      group.add(barrel);

      const brake = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.042, 0.085), metal);
      brake.position.set(0, 0.02, -0.84);
      group.add(brake);

      // Large High-Magnification Scope with turrets
      const scopeBody = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.022, 0.26, 12), gearPolymer);
      scopeBody.rotation.x = Math.PI / 2;
      scopeBody.position.set(0, 0.082, -0.07);
      group.add(scopeBody);

      const scopeLens = new THREE.Mesh(new THREE.CircleGeometry(0.022, 12), goggleLens);
      scopeLens.position.set(0, 0.082, -0.201);
      group.add(scopeLens);

      const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.018, 8), metal);
      turret.position.set(0, 0.108, -0.07);
      group.add(turret);

      // Bipod
      const bipod = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.12, 0.035), gearPolymer);
      bipod.position.set(0, -0.05, -0.38);
      group.add(bipod);

      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.12, 0.072), tanPolymer);
      mag.position.set(0, -0.075, -0.06);
      group.add(mag);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.11, 0.042), gearPolymer);
      grip.position.set(0, -0.08, 0.12);
      grip.rotation.x = 0.35;
      group.add(grip);

      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.12, 0.30), tanPolymer);
      stock.position.set(0, 0.01, 0.35);
      group.add(stock);

      this.muzzlePoint.set(0, 0.02, -0.88);

    } else if (weaponKey === 'pistol') {
      // G-18 Tactical Combat Handgun
      const slide = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.046, 0.20), metal);
      slide.position.set(0, 0.022, -0.03);
      group.add(slide);

      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.040, 0.18), gearPolymer);
      frame.position.set(0, -0.010, -0.03);
      group.add(frame);

      const pSights = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.012, 0.010), gearPolymer);
      pSights.position.set(0, 0.050, 0.06);
      group.add(pSights);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.11, 0.048), gearPolymer);
      grip.position.set(0, -0.068, 0.042);
      grip.rotation.x = 0.32;
      group.add(grip);

      this.muzzlePoint.set(0, 0.022, -0.14);

    } else {
      // Default: P-24 Tactical Assault Rifle (Carbine)
      const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.075, 0.34), metal);
      group.add(receiver);

      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.014, 0.28), gearPolymer);
      rail.position.set(0, 0.044, -0.04);
      group.add(rail);

      // Holographic Reflex Optic
      const opticHood = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.042, 0.075), gearPolymer);
      opticHood.position.set(0, 0.082, -0.04);
      group.add(opticHood);

      const opticGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.028, 0.028), goggleLens);
      opticGlass.position.set(0, 0.082, -0.078);
      group.add(opticGlass);

      // Handguard & Barrel
      const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.048, 0.22), gearPolymer);
      handguard.position.set(0, 0.015, -0.26);
      group.add(handguard);

      const suppressor = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.20, 10), metal);
      suppressor.rotation.x = Math.PI / 2;
      suppressor.position.set(0, 0.015, -0.46);
      group.add(suppressor);

      // Tan PMAG Magazine
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.065), tanPolymer);
      mag.position.set(0, -0.09, -0.06);
      mag.rotation.x = -0.22;
      group.add(mag);

      // Pistol Grip
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.11, 0.045), gearPolymer);
      grip.position.set(0, -0.075, 0.10);
      grip.rotation.x = 0.35;
      group.add(grip);

      // Buttstock
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.095, 0.18), tanPolymer);
      stock.position.set(0, 0.01, 0.24);
      group.add(stock);

      this.muzzlePoint.set(0, 0.015, -0.57);
    }

    // Attach Muzzle Flash Effects to Weapon Tip
    const muzzleLight = new THREE.PointLight(0xffaa22, 0, 4.5);
    const sockets = {
      smg: [[0, -0.082, 0.08], [0, -0.068, -0.15]],
      sniper: [[0, -0.092, 0.12], [0, -0.052, -0.22]],
      pistol: [[0, -0.083, 0.042], [0.027, -0.085, 0.02]],
      carbine: [[0, -0.086, 0.10], [0, -0.045, -0.14]]
    };
    group.userData.handSockets = (sockets[weaponKey] || sockets.carbine).map(point => new THREE.Vector3(...point));
    muzzleLight.position.copy(this.muzzlePoint);
    group.add(muzzleLight);
    this.muzzleLight = muzzleLight;

    // Muzzle Flash Sprite
    const flashCanvas = document.createElement('canvas');
    flashCanvas.width = 64;
    flashCanvas.height = 64;
    const fctx = flashCanvas.getContext('2d');
    if (fctx) {
      const grad = fctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255, 255, 220, 1.0)');
      grad.addColorStop(0.3, 'rgba(255, 170, 34, 0.85)');
      grad.addColorStop(0.8, 'rgba(255, 80, 0, 0.3)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      fctx.fillStyle = grad;
      fctx.fillRect(0, 0, 64, 64);
    }
    const flashTexture = new THREE.CanvasTexture(flashCanvas);
    const flashMat = new THREE.SpriteMaterial({ map: flashTexture, transparent: true, blending: THREE.AdditiveBlending });
    const flashSprite = new THREE.Sprite(flashMat);
    flashSprite.scale.set(0.45, 0.45, 0.45);
    flashSprite.position.copy(this.muzzlePoint);
    flashSprite.visible = false;
    group.add(flashSprite);
    this.muzzleSprite = flashSprite;

    return group;
  }

  setWeapon(weaponKey = 'carbine') {
    if (this.currentWeaponKey === weaponKey && this.weaponGroup) return;
    this.currentWeaponKey = weaponKey;

    if (this.weaponGroup && this.weaponSocket) {
      this.weaponSocket.remove(this.weaponGroup);
      this.weaponGroup = null;
    }

    if (this.weaponSocket) {
      this.weaponGroup = this.buildWeaponModel(weaponKey);
      this.weaponSocket.add(this.weaponGroup);
    }
  }

  buildHitboxes() {
    const headHitGeo = new THREE.BoxGeometry(0.44, 0.46, 0.44);
    // Transparent material allows Three.js Raycaster to intersect while remaining completely invisible to the player
    const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

    this.headMesh = new THREE.Mesh(headHitGeo, hitMat);
    this.headMesh.name = 'head';
    this.headMesh.userData = {
      isHead: true,
      isHeadshot: true,
      isBody: false,
      operator: this,
      bot: this.bot,
      remotePlayer: this.remotePlayer
    };

    if (this.headBone) {
      this.headMesh.position.set(0, 0.08, 0);
      this.headBone.add(this.headMesh);
    } else if (this.headGroup) {
      this.headMesh.position.set(0, 0.02, 0);
      this.headGroup.add(this.headMesh);
    } else {
      this.headMesh.position.set(0, 1.68, 0);
      this.root.add(this.headMesh);
    }

    const bodyHitGeo = new THREE.CylinderGeometry(0.36, 0.36, 1.25, 10);
    this.bodyMesh = new THREE.Mesh(bodyHitGeo, hitMat);
    this.bodyMesh.name = 'body';
    this.bodyMesh.userData = {
      isHead: false,
      isHeadshot: false,
      isBody: true,
      operator: this,
      bot: this.bot,
      remotePlayer: this.remotePlayer
    };

    if (this.spineBone) {
      this.bodyMesh.position.set(0, -0.42, 0);
      this.spineBone.add(this.bodyMesh);
    } else if (this.pelvisGroup) {
      this.bodyMesh.position.set(0, -0.15, 0);
      this.pelvisGroup.add(this.bodyMesh);
    } else {
      this.bodyMesh.position.set(0, 0.72, 0);
      this.root.add(this.bodyMesh);
    }
  }

  buildOverheadHUD() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    const isBlue = this.team === 'blue';
    ctx.fillStyle = isBlue ? 'rgba(0, 240, 255, 0.90)' : 'rgba(239, 68, 68, 0.90)';
    ctx.font = 'bold 24px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 4;
    ctx.fillText(this.callsign, 128, 32);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    this.nameTagSprite = new THREE.Sprite(spriteMat);
    this.nameTagSprite.userData = { isUI: true };
    this.nameTagSprite.position.set(0, 2.22, 0);
    this.nameTagSprite.scale.set(1.4, 0.35, 1);
    this.root.add(this.nameTagSprite);

    const hbGroup = new THREE.Group();
    hbGroup.userData = { isUI: true };
    hbGroup.position.set(0, 2.05, 0);

    const bgGeo = new THREE.PlaneGeometry(0.72, 0.08);
    const bgMat = new THREE.MeshBasicMaterial({ color: 0x0f172a, depthTest: false });
    const bg = new THREE.Mesh(bgGeo, bgMat);
    bg.userData = { isUI: true };
    hbGroup.add(bg);

    const fillGeo = new THREE.PlaneGeometry(0.70, 0.06);
    const fillMat = new THREE.MeshBasicMaterial({
      color: isBlue ? 0x10b981 : 0xef4444,
      depthTest: false
    });
    this.healthBarFill = new THREE.Mesh(fillGeo, fillMat);
    this.healthBarFill.userData = { isUI: true };
    this.healthBarFill.position.z = 0.005;
    hbGroup.add(this.healthBarFill);

    this.root.add(hbGroup);
    this.healthBarGroup = hbGroup;
  }

  triggerShoot() {
    // 1. Weapon Recoil Kick & Muzzle Climb
    this.weaponRecoilOffset = 0.055;
    this.weaponRecoilPitch = 0.075;

    // 2. Muzzle Flash Point Light & Sprite
    if (this.muzzleLight) {
      this.muzzleLight.intensity = 3.5;
    }
    if (this.muzzleSprite) {
      this.muzzleSprite.visible = true;
      this.muzzleSprite.rotation.z = Math.random() * Math.PI * 2;
    }
    this.muzzleTimer = 0.045; // 45ms flash duration

    // 3. Ejected Brass Shell Casing
    this.spawnEjectedShell();
  }

  spawnEjectedShell() {
    if (!this.root || !this.weaponGroup) return;
    try {
      const shellGeo = new THREE.CylinderGeometry(0.007, 0.007, 0.035, 6);
      const shellMesh = new THREE.Mesh(shellGeo, this.materials.brass);

      // Compute world position near weapon ejection port
      const spawnPos = new THREE.Vector3(0.06, 0.03, -0.04);
      this.weaponGroup.localToWorld(spawnPos);
      shellMesh.position.copy(spawnPos);

      // Random ejection velocity vector (upward and to the right)
      const vel = new THREE.Vector3(
        0.8 + Math.random() * 0.8,
        1.2 + Math.random() * 0.8,
        (Math.random() - 0.5) * 0.6
      );
      vel.applyEuler(this.root.rotation);

      if (this.scene) {
        this.scene.add(shellMesh);
        this.activeShells.push({
          mesh: shellMesh,
          vel: vel,
          rotSpeed: (Math.random() - 0.5) * 20,
          lifetime: 0.35
        });
      }
    } catch (_) {}
  }

  updateShells(delta) {
    for (let i = this.activeShells.length - 1; i >= 0; i--) {
      const shell = this.activeShells[i];
      shell.lifetime -= delta;
      if (shell.lifetime <= 0) {
        if (this.scene) this.scene.remove(shell.mesh);
        if (shell.mesh.geometry) shell.mesh.geometry.dispose();
        this.activeShells.splice(i, 1);
      } else {
        shell.vel.y -= 9.8 * delta; // Gravity
        shell.mesh.position.addScaledVector(shell.vel, delta);
        shell.mesh.rotation.x += shell.rotSpeed * delta;
        shell.mesh.rotation.z += shell.rotSpeed * delta;
      }
    }
  }

  hitFlinch() {
    this.hitFlinchTimer = 0.16; // 160ms torso flinch
  }

  /**
   * Universal character update: drives skeletal GLB animations or the procedural rig
   */
  updateAnimation(delta, speed = 0, isGrounded = true, camera = null, isCrouching = false, pitch = 0) {
    this.currentSpeed = speed;
    this.isCrouching = !!isCrouching;
    this.currentPitch = pitch || 0;

    // Decay muzzle flash
    if (this.muzzleTimer > 0) {
      this.muzzleTimer -= delta;
      if (this.muzzleTimer <= 0) {
        if (this.muzzleLight) this.muzzleLight.intensity = 0;
        if (this.muzzleSprite) this.muzzleSprite.visible = false;
      }
    }

    // Update flying shell casings
    this.updateShells(delta);

    // Distance-throttled animation update: 1/2 rate >35m, 1/4 rate >65m
    this.animFrameCount = (this.animFrameCount || 0) + 1;
    this.accumulatedDelta = (this.accumulatedDelta || 0) + delta;
    if (camera && this.root) {
      const dist = camera.position.distanceTo(this.root.position);
      if (dist > 65 && (this.animFrameCount % 4 !== 0)) {
        return;
      } else if (dist > 35 && (this.animFrameCount % 2 !== 0)) {
        return;
      }
    }
    const effectiveDelta = this.accumulatedDelta;
    this.accumulatedDelta = 0;

    // If GLB skeletal mixer is active:
    if (this.mixer) {
      this.mixer.update(effectiveDelta);
      // Skeletal hitboxes must be updated after bone transforms and before raycasting.
      if (this.headMesh) this.headMesh.position.set(0, 0.06, 0);
      if (this.bodyMesh) this.bodyMesh.position.set(0, -0.35, 0);
      if (this.isDead) {
        if (this.modelRoot) {
          this.modelRoot.rotation.x = THREE.MathUtils.lerp(this.modelRoot.rotation.x, -Math.PI / 2, effectiveDelta * 8.0);
          this.modelRoot.position.y = THREE.MathUtils.lerp(this.modelRoot.position.y, 0.18, effectiveDelta * 8.0);
        }
      } else {
        if (this.modelRoot) {
          this.modelRoot.rotation.x = THREE.MathUtils.lerp(this.modelRoot.rotation.x, 0, effectiveDelta * 12.0);
          this.modelRoot.position.y = THREE.MathUtils.lerp(this.modelRoot.position.y, this.mixer ? (this.modelGroundOffset || 0) : 0, effectiveDelta * 12.0);
        }
        // Upper-body aim pitch adjustment
        if (this.spineBone) {
          this.spineBone.rotation.x = THREE.MathUtils.lerp(this.spineBone.rotation.x, (pitch || 0) * 0.4, effectiveDelta * 12.0);
        }
        if (this.headBone) {
          this.headBone.rotation.x = THREE.MathUtils.lerp(this.headBone.rotation.x, (pitch || 0) * 0.4, effectiveDelta * 12.0);
        }

        let targetAction = 'idle';
        if (speed > 5.2 && this.actions.run) targetAction = 'run';
        else if (speed > 0.35 && this.actions.walk) targetAction = 'walk';

        if (targetAction !== this.currentAction) {
          const prev = this.actions[this.currentAction];
          const next = this.actions[targetAction];
          if (prev && next) {
            prev.fadeOut(0.20);
            next.reset().fadeIn(0.20).play();
            this.currentAction = targetAction;
          }
        }
      }
    } else {
      // High-Fidelity Procedural Animation Engine
      this.updateProceduralRig(effectiveDelta, speed, isCrouching, pitch);
    }

    if (this.root) this.root.updateMatrixWorld(true);

    this.updateWeaponPose(effectiveDelta, pitch || 0);

    // Billboards face camera
    if (camera) {
      if (this.healthBarGroup) this.healthBarGroup.quaternion.copy(camera.quaternion);
      if (this.nameTagSprite) this.nameTagSprite.quaternion.copy(camera.quaternion);
    }
  }

  updateProceduralRig(delta, speed, isCrouching, pitch) {
    if (!this.pelvisGroup) return;

    // 1. Death Animation State
    if (this.isDead) {
      this.pelvisGroup.position.y = THREE.MathUtils.lerp(this.pelvisGroup.position.y, 0.16, delta * 7.0);
      this.pelvisGroup.rotation.x = THREE.MathUtils.lerp(this.pelvisGroup.rotation.x, -Math.PI / 2 + 0.2, delta * 6.0);
      this.pelvisGroup.rotation.z = THREE.MathUtils.lerp(this.pelvisGroup.rotation.z, 0.35, delta * 5.0);
      if (this.rKneeGroup) this.rKneeGroup.rotation.x = 1.1;
      if (this.lKneeGroup) this.lKneeGroup.rotation.x = 0.8;
      if (this.nameTagSprite) this.nameTagSprite.visible = false;
      if (this.healthBarGroup) this.healthBarGroup.visible = false;
      return;
    }

    // 2. Crouch State (Smooth Pelvis Lowering & Knee Bend)
    const targetPelvisY = isCrouching ? 0.62 : 0.94;
    this.pelvisGroup.position.y = THREE.MathUtils.lerp(this.pelvisGroup.position.y, targetPelvisY, delta * 10.0);
    // Restore neutral upright rotations when alive (prevents sliding in dead pose)
    this.pelvisGroup.rotation.x = THREE.MathUtils.lerp(this.pelvisGroup.rotation.x, 0, delta * 12.0);
    this.pelvisGroup.rotation.z = THREE.MathUtils.lerp(this.pelvisGroup.rotation.z, 0, delta * 12.0);

    // Do not offset bone-attached hitboxes: attached local transforms are
    // already expressed relative to the animated head/spine.
    if (!this.headBone && !this.headGroup) {
      if (this.headMesh) this.headMesh.position.y = THREE.MathUtils.lerp(this.headMesh.position.y, isCrouching ? 1.25 : 1.68, delta * 10.0);
    }
    if (!this.spineBone && !this.pelvisGroup) {
      if (this.bodyMesh) this.bodyMesh.position.y = THREE.MathUtils.lerp(this.bodyMesh.position.y, isCrouching ? 0.60 : 0.82, delta * 10.0);
    }

    // 3. Aim Pitch (Torso & Head track crosshair elevation)
    const clampedPitch = Math.max(-0.9, Math.min(0.9, pitch));
    if (this.spineGroup) {
      let flinchOffset = 0;
      if (this.hitFlinchTimer > 0) {
        this.hitFlinchTimer -= delta;
        flinchOffset = -0.18;
      }
      this.spineGroup.rotation.x = clampedPitch * 0.55 + flinchOffset;
    }
    if (this.headGroup) {
      this.headGroup.rotation.x = clampedPitch * 0.45;
    }

    // 4. Locomotion Cycle (Walk / Sprint / Idle)
    if (speed > 0.25) {
      // Moving: Stride cadence scales with actual speed
      const freq = speed > 5.0 ? 11.5 : 8.5;
      this.walkCycle += delta * freq;
      const stride = isCrouching ? 0.35 : (speed > 5.0 ? 0.75 : 0.52);

      const sinCycle = Math.sin(this.walkCycle);
      const cosCycle = Math.cos(this.walkCycle);

      // Leg swings at hips
      if (this.rHipGroup) this.rHipGroup.rotation.x = sinCycle * stride;
      if (this.lHipGroup) this.lHipGroup.rotation.x = -sinCycle * stride;

      // Knee natural backward flexion
      if (this.rKneeGroup) {
        const rKneeFlex = isCrouching ? 0.95 : Math.max(0, -sinCycle * stride * 1.35);
        this.rKneeGroup.rotation.x = rKneeFlex;
      }
      if (this.lKneeGroup) {
        const lKneeFlex = isCrouching ? 0.95 : Math.max(0, sinCycle * stride * 1.35);
        this.lKneeGroup.rotation.x = lKneeFlex;
      }

      // Vertical hip bobbing
      const bobAmount = speed > 5.0 ? 0.04 : 0.025;
      this.pelvisGroup.position.y += Math.abs(Math.sin(this.walkCycle * 2)) * bobAmount;

      // Subtle torso yaw counter-sway
      if (this.spineGroup) {
        this.spineGroup.rotation.y = sinCycle * 0.06;
      }
    } else {
      // Idle: smooth return to neutral posture with subtle natural breathing
      this.idleCycle += delta * 1.8;
      const breath = Math.sin(this.idleCycle) * 0.015;

      if (this.rHipGroup) this.rHipGroup.rotation.x = THREE.MathUtils.lerp(this.rHipGroup.rotation.x, isCrouching ? 0.65 : 0, delta * 8.0);
      if (this.lHipGroup) this.lHipGroup.rotation.x = THREE.MathUtils.lerp(this.lHipGroup.rotation.x, isCrouching ? 0.65 : 0, delta * 8.0);
      if (this.rKneeGroup) this.rKneeGroup.rotation.x = THREE.MathUtils.lerp(this.rKneeGroup.rotation.x, isCrouching ? 0.90 : 0, delta * 8.0);
      if (this.lKneeGroup) this.lKneeGroup.rotation.x = THREE.MathUtils.lerp(this.lKneeGroup.rotation.x, isCrouching ? 0.90 : 0, delta * 8.0);

      if (this.chestGroup) {
        this.chestGroup.scale.set(1 + breath, 1 + breath * 0.8, 1 + breath);
      }
      if (this.spineGroup) {
        this.spineGroup.rotation.y = THREE.MathUtils.lerp(this.spineGroup.rotation.y, 0, delta * 6.0);
      }
    }
  }

  takeDamage(amount, isHeadshot = false) {
    if (this.isDead) return true;

    this.health = Math.max(0, this.health - amount);
    this.hitFlinch();

    if (this.healthBarFill && this.healthBarFill.scale) {
      const pct = Math.max(0, this.health / this.maxHealth);
      this.healthBarFill.scale.x = pct;
      this.healthBarFill.position.x = -(1 - pct) * 0.35;
    }

    if (this.health <= 0) {
      this.die();
      return true;
    }

    return false;
  }

  die() {
    this.isDead = true;
    this.health = 0;
    if (this.headMesh) this.headMesh.visible = false;
    if (this.bodyMesh) this.bodyMesh.visible = false;
    if (this.weaponSocket) this.weaponSocket.visible = false;
    if (this.healthBarFill && this.healthBarFill.scale) {
      this.healthBarFill.scale.x = 0;
    }
    if (this.nameTagSprite) this.nameTagSprite.visible = false;
    if (this.healthBarGroup) this.healthBarGroup.visible = false;
  }

  respawn(spawnPos) {
    this.health = this.maxHealth;
    this.isDead = false;

    if (this.headMesh) {
      this.headMesh.visible = true;
      if (!this.headBone && !this.headGroup) this.headMesh.position.set(0, 1.68, 0);
      else if (this.headBone) this.headMesh.position.set(0, 0.06, 0);
      else this.headMesh.position.set(0, 0, 0);
    }
    if (this.bodyMesh) {
      this.bodyMesh.visible = true;
      if (!this.spineBone && !this.pelvisGroup) this.bodyMesh.position.set(0, 0.82, 0);
      else if (this.spineBone) this.bodyMesh.position.set(0, -0.35, 0);
      else if (this.pelvisGroup) this.bodyMesh.position.set(0, -0.12, 0);
    }

    if (this.pelvisGroup) {
      this.pelvisGroup.position.set(0, 0.94, 0);
      this.pelvisGroup.rotation.set(0, 0, 0);
    }
    if (this.rHipGroup) this.rHipGroup.rotation.set(0, 0, 0);
    if (this.lHipGroup) this.lHipGroup.rotation.set(0, 0, 0);
    if (this.rKneeGroup) this.rKneeGroup.rotation.set(0, 0, 0);
    if (this.lKneeGroup) this.lKneeGroup.rotation.set(0, 0, 0);
    if (this.spineGroup) this.spineGroup.rotation.set(0, 0, 0);
    if (this.headGroup) this.headGroup.rotation.set(0, 0, 0);
    if (this.chestGroup) this.chestGroup.scale.set(1, 1, 1);
    this.walkCycle = 0;
    this.idleCycle = 0;
    if (this.modelRoot) {
      this.modelRoot.rotation.set(0, this.mixer ? Math.PI : 0, 0);
      this.modelRoot.position.set(0, this.mixer ? (this.modelGroundOffset || 0) : 0, 0);
    }

    if (this.healthBarFill && this.healthBarFill.scale) {
      this.healthBarFill.scale.x = 1.0;
      this.healthBarFill.position.x = 0;
    }

    if (this.weaponSocket) this.weaponSocket.visible = true;
    if (this.nameTagSprite) this.nameTagSprite.visible = true;
    if (this.healthBarGroup) this.healthBarGroup.visible = true;

    if (spawnPos) {
      this.root.position.copy(spawnPos);
    }

    if (this.actions.idle) {
      if (this.actions[this.currentAction]) this.actions[this.currentAction].fadeOut(0.1);
      this.actions.idle.reset().fadeIn(0.1).play();
      this.currentAction = 'idle';
    }
  }

  destroy() {
    const idx = TacticalOperator.instances.indexOf(this);
    if (idx !== -1) {
      TacticalOperator.instances.splice(idx, 1);
    }
    if (this.scene && this.root) {
      this.scene.remove(this.root);
    }
    for (const shell of this.activeShells) {
      if (this.scene && shell.mesh) this.scene.remove(shell.mesh);
    }
    this.activeShells = [];
  }
}

// Expose globally
window.TacticalOperator = TacticalOperator;
