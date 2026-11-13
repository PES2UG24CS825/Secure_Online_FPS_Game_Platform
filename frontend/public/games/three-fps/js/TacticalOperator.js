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

  static currentWeaponCalibration = {
    posX: 0.02,
    posY: 0.05,
    posZ: -0.06,
    rotX: -Math.PI / 2 + 0.15,
    rotY: 0,
    rotZ: 0.1
  };

  static applyWeaponCalibration(values) {
    Object.assign(TacticalOperator.currentWeaponCalibration, values);
    TacticalOperator.instances.forEach(op => {
      if (op && op.weaponGroup && (!op.weaponSocket || !op.weaponSocket.isBone)) {
        op.weaponGroup.position.set(
          TacticalOperator.currentWeaponCalibration.posX,
          TacticalOperator.currentWeaponCalibration.posY,
          TacticalOperator.currentWeaponCalibration.posZ
        );
        op.weaponGroup.rotation.set(
          TacticalOperator.currentWeaponCalibration.rotX,
          TacticalOperator.currentWeaponCalibration.rotY,
          TacticalOperator.currentWeaponCalibration.rotZ
        );
      }
    });
  }

  static updateDevOverlayStatus() {
    if (typeof document === 'undefined') return;
    const statusText = document.getElementById('hud-model-status');
    const noticeBanner = document.getElementById('dev-model-notice-banner');
    if (TacticalOperator.isFallbackActive) {
      if (statusText) {
        statusText.textContent = "PROCEDURAL RIG (CORRUPTED GLB)";
        statusText.style.color = "#ef4444";
      }
      if (noticeBanner) {
        noticeBanner.style.display = "block";
      }
    } else {
      if (statusText) {
        statusText.textContent = "RIGGED GLB 3D RIG";
        statusText.style.color = "#10b981";
      }
      if (noticeBanner) {
        noticeBanner.style.display = "none";
      }
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
            console.warn(`[TacticalOperator] Failed to fetch 3D model '${url}': HTTP status ${resp.status}`);
            return null;
          }
          const buffer = await resp.arrayBuffer();
          if (!buffer || buffer.byteLength < 24) {
            console.warn(`[TacticalOperator] Corrupted 3D model buffer in '${url}': Buffer empty or truncated (<24 bytes).`);
            return null;
          }

          const view = new DataView(buffer);
          // Valid GLB header: magic 0x46546C67 ("glTF" in ASCII little-endian)
          const magic = view.getUint32(0, true);
          if (magic !== 0x46546C67) {
            console.warn(
              `[TacticalOperator] Corrupted GLB Header in '${url}': Expected magic 'glTF' (0x46546C67), found 0x${magic.toString(16)}. ` +
              `The file was corrupted during transfer or checked out in text mode. Falling back to high-fidelity procedural rig.`
            );
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
            console.warn(
              `[TacticalOperator] Corrupted GLB asset '${url}': Detected UTF-8 replacement bytes (EF BF BD). ` +
              `This file was corrupted by a text-mode git filter or text editor copy. See README and .gitattributes. ` +
              `Falling back to high-fidelity procedural anatomical tactical operator rig.`
            );
            return null;
          }

          const chunk0Type = view.getUint32(16, true);
          if (chunk0Type !== 0x4E4F534A) { // "JSON" in ASCII little-endian
            console.error(`[TacticalOperator] Invalid GLB Chunk 0 in '${url}': Expected JSON chunk type.`);
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

      const [soldier, female] = await Promise.all([
        tryLoadModel("models/Soldier.glb"),
        tryLoadModel("models/FemaleOperator.glb")
      ]);

      TacticalOperator.models.soldier = soldier;
      TacticalOperator.models.female = female;

      if (soldier || female) {
        TacticalOperator.modelStatus = "RIGGED_GLB";
        TacticalOperator.isFallbackActive = false;
        console.log("[TacticalOperator] Successfully loaded rigged adult tactical operator GLB models.");
      } else {
        TacticalOperator.modelStatus = "FALLBACK_PROCEDURAL";
        TacticalOperator.isFallbackActive = true;
        console.warn("[TacticalOperator] Rigged GLBs unavailable or corrupted (EF BF BD). Using high-fidelity procedural anatomical operator rigs.");
      }

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
    if (this.headMesh) this.headMesh.userData.bot = val;
    if (this.bodyMesh) this.bodyMesh.userData.bot = val;
  }

  get remotePlayer() {
    return this._remotePlayer;
  }

  set remotePlayer(val) {
    this._remotePlayer = val;
    if (this.root) this.root.userData.remotePlayer = val;
    if (this.headMesh) this.headMesh.userData.remotePlayer = val;
    if (this.bodyMesh) this.bodyMesh.userData.remotePlayer = val;
  }

  initMaterials() {
    const isBlue = this.team === 'blue';
    const accentHex = isBlue ? 0x00f0ff : 0xff0055;
    this.accentColor = new THREE.Color(accentHex);

    this.materials = {
      // Dark tactical uniform ripstop fabric (charcoal-navy for blue, charcoal-maroon for red)
      uniform: new THREE.MeshStandardMaterial({
        color: isBlue ? 0x181e26 : 0x221a1f,
        roughness: 0.75,
        metalness: 0.12
      }),
      // Coyote tan pants for female operator
      femalePants: new THREE.MeshStandardMaterial({
        color: 0x4f4333,
        roughness: 0.75,
        metalness: 0.10
      }),
      // Plate carrier fabric (tan/coyote or dark charcoal)
      plateCarrier: new THREE.MeshStandardMaterial({
        color: this.isFemale ? 0x594a38 : (isBlue ? 0x242830 : 0x3d302a),
        roughness: 0.65,
        metalness: 0.15
      }),
      // Matte tactical polymer (helmet, knee pads, holster, radio, boots)
      gearPolymer: new THREE.MeshStandardMaterial({
        color: 0x16181d,
        roughness: 0.40,
        metalness: 0.40
      }),
      // Ballistic Goggle Lens (mirrored reflective tint matching team color)
      goggleLens: new THREE.MeshStandardMaterial({
        color: accentHex,
        roughness: 0.1,
        metalness: 0.9,
        transparent: true,
        opacity: 0.85
      }),
      // Team identification glowing accent (used only for small patches & lenses)
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
      // Adult human skin tone
      skin: new THREE.MeshStandardMaterial({
        color: this.isFemale ? 0xd4a58a : 0xc8967b,
        roughness: 0.65,
        metalness: 0.05
      }),
      // Balaclava dark fabric
      balaclava: new THREE.MeshStandardMaterial({
        color: 0x14161a,
        roughness: 0.85,
        metalness: 0.05
      }),
      // Dark tactical hair
      hair: new THREE.MeshStandardMaterial({
        color: 0x221a16,
        roughness: 0.85
      }),
      // Brass for ejected shell casings
      brass: new THREE.MeshStandardMaterial({
        color: 0xd4af37,
        roughness: 0.25,
        metalness: 0.90
      })
    };

    // Authentic CS-3D Velcro Chest Patch
    if (typeof TextureGenerator !== 'undefined' && typeof TextureGenerator.createPatchTexture === 'function') {
      try {
        const patchTex = TextureGenerator.createPatchTexture(this.team, 'CS-3D');
        this.materials.patch = new THREE.MeshBasicMaterial({ map: patchTex, transparent: true });
      } catch (_) {
        this.materials.patch = this.materials.teamAccent;
      }
    } else {
      this.materials.patch = this.materials.teamAccent;
    }
  }

  buildCharacter() {
    const isFemale = this.isFemale;
    const sourceGltf = isFemale && TacticalOperator.models.female
      ? TacticalOperator.models.female
      : TacticalOperator.models.soldier;

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

  findBone(keywords) {
    if (!this.modelRoot) return null;
    let found = null;
    this.modelRoot.traverse((bone) => {
      if (bone.isBone && !found) {
        const name = bone.name.toLowerCase();
        for (const kw of keywords) {
          if (name.includes(kw.toLowerCase())) {
            found = bone;
            break;
          }
        }
      }
    });
    return found;
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

    // Compute bounding box and normalize height to ~1.8m (1.74m female, 1.82m male)
    const bbox = new THREE.Box3().setFromObject(this.modelRoot);
    const size = new THREE.Vector3();
    bbox.getSize(size);

    // Detect if armature was exported in centimeters (scale 0.01)
    const isCmScale = size.y > 40;
    const rawHeight = isCmScale ? size.y * 0.01 : size.y;
    const targetHeight = this.isFemale ? 1.74 : 1.82;
    const scale = (targetHeight / Math.max(0.1, rawHeight)) * (isCmScale ? 0.01 : 1.0);
    this.modelRoot.scale.set(scale, scale, scale);

    // Recompute bbox after scaling and place feet exactly at y = 0
    bbox.setFromObject(this.modelRoot);
    this.modelRoot.position.y = -bbox.min.y;

    // Orient model so facing direction aligns with -Z (forward vector)
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
    // Defensive bone lookup matching mixamorig, standard names, and regex patterns
    const headBone = this.findBoneRegex(/mixamorig.*head|head|neck/i) || this.findBone(['head', 'neck']);
    const spine2Bone = this.findBoneRegex(/mixamorig.*spine[12]|spine[12]|chest|upper.*body/i) || this.findBone(['chest', 'spine2']);
    const spine1Bone = this.findBoneRegex(/mixamorig.*spine$|spine$|spine0|abdomen/i) || this.findBone(['spine', 'abdomen']);
    const rightHandBone = this.findBoneRegex(/mixamorig.*righthand|right.*hand|hand.*r|weapon.*socket/i) || this.findBone(['righthand', 'hand_r']);
    const leftHandBone = this.findBoneRegex(/mixamorig.*lefthand|left.*hand|hand.*l/i) || this.findBone(['lefthand', 'hand_l']);
    const leftArmBone = this.findBoneRegex(/mixamorig.*leftarm|left.*arm|arm.*l|shoulder.*l/i) || this.findBone(['leftarm', 'arm_l']);
    const rightUpLegBone = this.findBoneRegex(/mixamorig.*rightupleg|right.*upleg|thigh.*r/i) || this.findBone(['rightupleg', 'thigh_r']);
    const leftUpLegBone = this.findBoneRegex(/mixamorig.*leftupleg|left.*upleg|thigh.*l/i) || this.findBone(['leftupleg', 'thigh_l']);
    const rightLegBone = this.findBoneRegex(/mixamorig.*rightleg|right.*leg|shin.*r|calf.*r/i) || this.findBone(['rightleg', 'shin_r']);
    const leftLegBone = this.findBoneRegex(/mixamorig.*leftleg|left.*leg|shin.*l|calf.*l/i) || this.findBone(['leftleg', 'shin_l']);

    this.headBone = headBone;
    this.spineBone = spine2Bone;

    // Team Armband on Left Upper Arm (Team identity without 45% whole-body flat color lerp)
    if (leftArmBone) {
      const armbandGeo = new THREE.CylinderGeometry(0.062, 0.058, 0.07, 12);
      const armband = new THREE.Mesh(armbandGeo, this.materials.teamAccent);
      armband.position.set(0, -0.08, 0);
      leftArmBone.add(armband);
    }

    // Head Equipment
    const headGear = this.isFemale ? this.buildFemaleHeadGear() : this.buildMaleHeadGear();
    if (headBone) {
      headGear.position.set(0, 0.04, 0);
      headBone.add(headGear);
    } else {
      headGear.position.set(0, 1.66, 0);
      this.root.add(headGear);
    }

    // Plate Carrier
    const plateCarrier = this.buildPlateCarrierGear();
    if (spine2Bone) {
      plateCarrier.position.set(0, -0.05, 0.02);
      spine2Bone.add(plateCarrier);
    } else {
      plateCarrier.position.set(0, 1.25, 0);
      this.root.add(plateCarrier);
    }

    // Mag Pouches
    const magPouches = this.buildTripleMagPouches();
    if (spine1Bone) {
      magPouches.position.set(0, 0.02, 0.14);
      spine1Bone.add(magPouches);
    } else {
      magPouches.position.set(0, 1.12, 0.14);
      this.root.add(magPouches);
    }

    // Drop-leg Holster
    const holster = this.buildDropLegHolster();
    if (rightUpLegBone) {
      holster.position.set(0.12, -0.14, 0.02);
      rightUpLegBone.add(holster);
    } else {
      holster.position.set(0.18, 0.65, 0);
      this.root.add(holster);
    }

    // Dual Thigh Pouches
    const thighPouches = this.buildDualThighPouches();
    if (leftUpLegBone) {
      thighPouches.position.set(-0.12, -0.14, 0.02);
      leftUpLegBone.add(thighPouches);
    } else {
      thighPouches.position.set(-0.18, 0.65, 0);
      this.root.add(thighPouches);
    }

    // Knee Protection Pads
    const rKnee = this.buildKneePad();
    if (rightLegBone) {
      rKnee.position.set(0, 0.05, 0.07);
      rightLegBone.add(rKnee);
    } else {
      rKnee.position.set(0.12, 0.45, 0.08);
      this.root.add(rKnee);
    }

    const lKnee = this.buildKneePad();
    if (leftLegBone) {
      lKnee.position.set(0, 0.05, 0.07);
      leftLegBone.add(lKnee);
    } else {
      lKnee.position.set(-0.12, 0.45, 0.08);
      this.root.add(lKnee);
    }

    // Weapon Socket in Right Hand with Scale Compensation and Calibrated Transforms
    const weaponGroup = this.buildWeaponModel(this.currentWeaponKey);
    this.weaponGroup = weaponGroup;
    const cal = TacticalOperator.currentWeaponCalibration;
    if (rightHandBone) {
      // Compensate for bone local scale so weapon stays proportional
      const boneScale = rightHandBone.scale;
      weaponGroup.scale.set(1.0 / (boneScale.x || 1), 1.0 / (boneScale.y || 1), 1.0 / (boneScale.z || 1));
      weaponGroup.position.set(cal.posX, cal.posY, cal.posZ);
      weaponGroup.rotation.set(cal.rotX, cal.rotY, cal.rotZ);
      rightHandBone.add(weaponGroup);
      this.weaponSocket = rightHandBone;
    } else {
      weaponGroup.position.set(0.22, 1.15, 0.22);
      this.root.add(weaponGroup);
      this.weaponSocket = this.root;
    }
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

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.10, 10), balaclava);
    neck.position.set(0, 0.05, 0);
    this.neckGroup.add(neck);

    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 0.12, 0);
    this.neckGroup.add(this.headGroup);

    // Head base (balaclava / skin)
    const headBase = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 14), balaclava);
    headBase.position.set(0, 0.04, 0);
    headBase.castShadow = true;
    this.headGroup.add(headBase);

    // Headgear (FAST Helmet / Goggles / Comms Headset OR Female Cap + Ponytail)
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

    const rForearmGeo = new THREE.CylinderGeometry(0.046, 0.040, 0.22, 10);
    const rForearm = new THREE.Mesh(rForearmGeo, uniform);
    rForearm.position.set(0, -0.11, 0);
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

    const lForearmGeo = new THREE.CylinderGeometry(0.046, 0.040, 0.22, 10);
    const lForearm = new THREE.Mesh(lForearmGeo, uniform);
    lForearm.position.set(0, -0.11, 0);
    lForearm.castShadow = true;
    this.lElbowGroup.add(lForearm);

    // Left Hand / Tactical Glove (Supporting handguard)
    this.lHandGroup = new THREE.Group();
    this.lHandGroup.position.set(0, -0.22, 0);
    this.lElbowGroup.add(this.lHandGroup);

    const lGlove = this.buildTacticalGlove(true);
    this.lHandGroup.add(lGlove);

    // Orient arms into realistic two-handed ready/firing stance
    this.rShoulderGroup.rotation.set(-0.65, -0.15, 0.12);
    this.rElbowGroup.rotation.set(-0.60, 0.0, -0.10);
    this.rHandGroup.rotation.set(0.15, 0.25, 0);

    this.lShoulderGroup.rotation.set(-0.85, 0.45, -0.25);
    this.lElbowGroup.rotation.set(-0.95, 0.0, 0.20);
    this.lHandGroup.rotation.set(0.20, -0.30, 0.35);

    // Attach Weapon in Right Hand Socket
    this.weaponSocket = this.rHandGroup;
    this.weaponGroup = this.buildWeaponModel(this.currentWeaponKey);
    this.weaponGroup.position.set(0.02, 0.05, -0.06);
    this.weaponGroup.rotation.set(-Math.PI / 2 + 0.15, 0, 0.1);
    this.weaponSocket.add(this.weaponGroup);

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
    const { gearPolymer, goggleLens, teamAccent } = this.materials;

    // FAST Tactical High-Cut Helmet Shell
    const helmetShell = new THREE.Mesh(
      new THREE.SphereGeometry(0.138, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.56),
      gearPolymer
    );
    helmetShell.position.set(0, 0.04, -0.01);
    helmetShell.castShadow = true;
    group.add(helmetShell);

    // Front Wilcox NVG Shroud Mount Bracket
    const nvgMount = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.048, 0.016), gearPolymer);
    nvgMount.position.set(0, 0.065, 0.135);
    group.add(nvgMount);

    const nvgSocket = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.018, 8), this.materials.metal);
    nvgSocket.position.set(0, 0.065, 0.144);
    nvgSocket.rotation.x = Math.PI / 2;
    group.add(nvgSocket);

    // Side ARC Accessory Rails
    const leftRail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.028, 0.12), gearPolymer);
    leftRail.position.set(-0.135, 0.04, 0.01);
    group.add(leftRail);

    const rightRail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.028, 0.12), gearPolymer);
    rightRail.position.set(0.135, 0.04, 0.01);
    group.add(rightRail);

    // Ballistic Tactical Goggles with Team-Tinted Mirrored Lens
    const goggleFrame = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.052, 0.038), gearPolymer);
    goggleFrame.position.set(0, 0.015, 0.125);
    group.add(goggleFrame);

    const goggleGlass = new THREE.Mesh(new THREE.BoxGeometry(0.155, 0.038, 0.012), goggleLens);
    goggleGlass.position.set(0, 0.015, 0.142);
    group.add(goggleGlass);

    // Comms Headset with Boom Mic
    const leftCup = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.028, 10), gearPolymer);
    leftCup.rotation.z = Math.PI / 2;
    leftCup.position.set(-0.135, 0.01, -0.01);
    group.add(leftCup);

    const rightCup = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.028, 10), gearPolymer);
    rightCup.rotation.z = Math.PI / 2;
    rightCup.position.set(0.135, 0.01, -0.01);
    group.add(rightCup);

    const boomMic = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.12, 6), gearPolymer);
    boomMic.position.set(-0.11, -0.03, 0.06);
    boomMic.rotation.x = Math.PI / 3;
    group.add(boomMic);

    // Rear Team Identification Velcro Tab
    const rearTag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.024, 0.006), teamAccent);
    rearTag.position.set(0, 0.04, -0.138);
    group.add(rearTag);

    return group;
  }

  buildFemaleHeadGear() {
    const group = new THREE.Group();
    const { uniform, goggleLens, hair, teamAccent, gearPolymer } = this.materials;

    // Tactical Operator Low-Profile Cap
    const capCrown = new THREE.Mesh(
      new THREE.SphereGeometry(0.132, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.52),
      uniform
    );
    capCrown.position.set(0, 0.04, 0);
    group.add(capCrown);

    // Forward Cap Brim / Visor
    const capBrim = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.008, 0.09), uniform);
    capBrim.position.set(0, 0.025, 0.14);
    capBrim.rotation.x = -0.15;
    group.add(capBrim);

    // Rear Ponytail Exit Aperture & Styled Hair
    const ponytail = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.028, 0.28, 8), hair);
    ponytail.position.set(0, -0.04, -0.18);
    ponytail.rotation.x = -0.40;
    group.add(ponytail);

    // Ballistic Goggles Resting over Crown/Forehead
    const goggleFrame = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.048, 0.035), gearPolymer);
    goggleFrame.position.set(0, 0.075, 0.10);
    goggleFrame.rotation.x = -0.35;
    group.add(goggleFrame);

    const goggleGlass = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.034, 0.010), goggleLens);
    goggleGlass.position.set(0, 0.075, 0.115);
    goggleGlass.rotation.x = -0.35;
    group.add(goggleGlass);

    // Front Velcro Morale Patch
    const capPatch = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.026, 0.006), teamAccent);
    capPatch.position.set(0, 0.065, 0.128);
    group.add(capPatch);

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
    const { gearPolymer, uniform } = this.materials;

    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.09, 0.045), uniform);
    group.add(glove);

    const knuckleGuard = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.025, 0.035), gearPolymer);
    knuckleGuard.position.set(0, 0.025, isLeft ? -0.015 : 0.015);
    group.add(knuckleGuard);

    return group;
  }

  /**
   * Builds high-detail weapon models with proper muzzle points and sockets
   */
  buildWeaponModel(weaponKey = 'carbine') {
    const group = new THREE.Group();
    const { metal, gearPolymer, tanPolymer, goggleLens } = this.materials;

    if (weaponKey === 'smg') {
      // Vector-9 SMG
      const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.085, 0.26), metal);
      group.add(receiver);

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.14, 8), metal);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.015, -0.19);
      group.add(barrel);

      const optic = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.05), gearPolymer);
      optic.position.set(0, 0.06, -0.02);
      group.add(optic);

      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.18, 0.036), gearPolymer);
      mag.position.set(0, -0.08, -0.02);
      group.add(mag);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.10, 0.04), gearPolymer);
      grip.position.set(0, -0.06, 0.08);
      grip.rotation.x = 0.35;
      group.add(grip);

      this.muzzlePoint.set(0, 0.015, -0.27);

    } else if (weaponKey === 'sniper') {
      // AWM-50 Sniper Rifle
      const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.08, 0.42), metal);
      group.add(receiver);

      // Fluted heavy barrel
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.014, 0.55, 10), metal);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.015, -0.48);
      group.add(barrel);

      // Large High-Magnification Scope
      const scopeBody = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.020, 0.22, 10), gearPolymer);
      scopeBody.rotation.x = Math.PI / 2;
      scopeBody.position.set(0, 0.075, -0.06);
      group.add(scopeBody);

      const scopeLens = new THREE.Mesh(new THREE.CircleGeometry(0.018, 12), goggleLens);
      scopeLens.position.set(0, 0.075, -0.171);
      group.add(scopeLens);

      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.11, 0.065), tanPolymer);
      mag.position.set(0, -0.07, -0.06);
      group.add(mag);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.11, 0.042), gearPolymer);
      grip.position.set(0, -0.08, 0.12);
      grip.rotation.x = 0.35;
      group.add(grip);

      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.11, 0.28), tanPolymer);
      stock.position.set(0, 0.01, 0.34);
      group.add(stock);

      this.muzzlePoint.set(0, 0.015, -0.76);

    } else if (weaponKey === 'pistol') {
      // G-18 Tactical Pistol
      const slide = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.045, 0.18), metal);
      group.add(slide);

      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.11, 0.045), gearPolymer);
      grip.position.set(0, -0.065, 0.04);
      grip.rotation.x = 0.32;
      group.add(grip);

      this.muzzlePoint.set(0, 0.01, -0.10);

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
      const cal = TacticalOperator.currentWeaponCalibration;
      this.weaponGroup.position.set(cal.posX, cal.posY, cal.posZ);
      this.weaponGroup.rotation.set(cal.rotX, cal.rotY, cal.rotZ);
      this.weaponSocket.add(this.weaponGroup);
    }
  }

  buildHitboxes() {
    const headHitGeo = new THREE.BoxGeometry(0.38, 0.38, 0.38);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false, wireframe: true });

    this.headMesh = new THREE.Mesh(headHitGeo, hitMat);
    this.headMesh.userData = {
      isHead: true,
      isHeadshot: true,
      isBody: false,
      operator: this,
      bot: this.bot,
      remotePlayer: this.remotePlayer
    };

    if (this.headBone) {
      this.headMesh.position.set(0, 0, 0);
      this.headBone.add(this.headMesh);
    } else if (this.headGroup) {
      this.headMesh.position.set(0, 0, 0);
      this.headGroup.add(this.headMesh);
    } else {
      this.headMesh.position.set(0, 1.68, 0);
      this.root.add(this.headMesh);
    }

    const bodyHitGeo = new THREE.CylinderGeometry(0.36, 0.36, 1.45, 8);
    this.bodyMesh = new THREE.Mesh(bodyHitGeo, hitMat);
    this.bodyMesh.userData = {
      isHead: false,
      isHeadshot: false,
      isBody: true,
      operator: this,
      bot: this.bot,
      remotePlayer: this.remotePlayer
    };

    if (this.spineBone) {
      this.bodyMesh.position.set(0, -0.35, 0);
      this.spineBone.add(this.bodyMesh);
    } else if (this.pelvisGroup) {
      this.bodyMesh.position.set(0, -0.12, 0);
      this.pelvisGroup.add(this.bodyMesh);
    } else {
      this.bodyMesh.position.set(0, 0.82, 0);
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
    this.nameTagSprite.position.set(0, 2.22, 0);
    this.nameTagSprite.scale.set(1.4, 0.35, 1);
    this.root.add(this.nameTagSprite);

    const hbGroup = new THREE.Group();
    hbGroup.position.set(0, 2.05, 0);

    const bgGeo = new THREE.PlaneGeometry(0.72, 0.08);
    const bgMat = new THREE.MeshBasicMaterial({ color: 0x0f172a, depthTest: false });
    const bg = new THREE.Mesh(bgGeo, bgMat);
    hbGroup.add(bg);

    const fillGeo = new THREE.PlaneGeometry(0.70, 0.06);
    const fillMat = new THREE.MeshBasicMaterial({
      color: isBlue ? 0x10b981 : 0xef4444,
      depthTest: false
    });
    this.healthBarFill = new THREE.Mesh(fillGeo, fillMat);
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
      if (this.isDead) {
        if (this.modelRoot) {
          this.modelRoot.rotation.x = THREE.MathUtils.lerp(this.modelRoot.rotation.x, -Math.PI / 2, effectiveDelta * 8.0);
          this.modelRoot.position.y = THREE.MathUtils.lerp(this.modelRoot.position.y, 0.18, effectiveDelta * 8.0);
        }
      } else {
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

    // Billboards face camera
    if (camera) {
      if (this.healthBarGroup) this.healthBarGroup.quaternion.copy(camera.quaternion);
      if (this.nameTagSprite) this.nameTagSprite.quaternion.copy(camera.quaternion);
    }
  }

  updateProceduralRig(delta, speed, isCrouching, pitch) {
    if (!this.pelvisGroup) return;

    // Recoil recovery
    this.weaponRecoilOffset = THREE.MathUtils.lerp(this.weaponRecoilOffset, 0, delta * 18);
    this.weaponRecoilPitch = THREE.MathUtils.lerp(this.weaponRecoilPitch, 0, delta * 18);

    if (this.weaponGroup) {
      this.weaponGroup.position.z = -0.06 - this.weaponRecoilOffset;
      this.weaponGroup.rotation.x = -Math.PI / 2 + 0.15 - this.weaponRecoilPitch;
    }

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

    // Update Hitbox elevations when crouching vs standing
    const targetHeadY = isCrouching ? 1.25 : 1.68;
    const targetBodyY = isCrouching ? 0.60 : 0.82;
    if (this.headMesh) this.headMesh.position.y = THREE.MathUtils.lerp(this.headMesh.position.y, targetHeadY, delta * 10.0);
    if (this.bodyMesh) this.bodyMesh.position.y = THREE.MathUtils.lerp(this.bodyMesh.position.y, targetBodyY, delta * 10.0);

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
      // Subtle arm bobbing
      if (this.rShoulderGroup) {
        this.rShoulderGroup.rotation.x = -0.65 + cosCycle * 0.04;
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
    if (this.headMesh) this.headMesh.position.y = -100;
    if (this.bodyMesh) this.bodyMesh.position.y = -100;
    if (this.healthBarFill && this.healthBarFill.scale) {
      this.healthBarFill.scale.x = 0;
    }
    if (this.nameTagSprite) this.nameTagSprite.visible = false;
    if (this.healthBarGroup) this.healthBarGroup.visible = false;
  }

  respawn(spawnPos) {
    this.health = this.maxHealth;
    this.isDead = false;

    if (this.headMesh) this.headMesh.position.set(0, 1.68, 0);
    if (this.bodyMesh) this.bodyMesh.position.set(0, 0.82, 0);

    if (this.pelvisGroup) {
      this.pelvisGroup.position.set(0, 0.94, 0);
      this.pelvisGroup.rotation.set(0, 0, 0);
    }
    if (this.modelRoot) {
      this.modelRoot.rotation.set(0, 0, 0);
      this.modelRoot.position.set(0, 0, 0);
    }

    if (this.healthBarFill && this.healthBarFill.scale) {
      this.healthBarFill.scale.x = 1.0;
      this.healthBarFill.position.x = 0;
    }

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
