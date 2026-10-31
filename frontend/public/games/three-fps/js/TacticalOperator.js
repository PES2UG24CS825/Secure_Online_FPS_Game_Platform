/**
 * SecureFPS: TacticalOperator.js
 * Professional Realistic Adult FPS 3D Tactical Operator Engine
 * Built strictly according to the CyberStrike 3D Character Design Specification:
 * - Realistic adult male & female anatomical proportions (1:7.5 - 1:8 ratio).
 * - FAST Tactical Helmet with Wilcox NVG shroud, ARC accessory rails & velcro loop pads.
 * - Ballistic Tactical Goggles with team-tinted reflective lens (Blue/Red).
 * - Black tactical balaclava face covering & communications headset with boom mic.
 * - Female tactical cap with ponytail hair exiting rear aperture.
 * - Heavy-duty Plate Carrier with MOLLE webbing & authentic "CS-3D" velcro chest patch.
 * - Triple magazine pouches on abdomen with tan PMAG 5.56 rifle magazines.
 * - Tactical shoulder radio with flexible whip antenna.
 * - Drop-leg tactical holster on right thigh with holstered sidearm pistol.
 * - Dual magazine pouches on left thigh.
 * - Molded hard-shell tactical knee protection pads with securing straps.
 * - High-top all-terrain combat assault boots.
 * - Reinforced tactical combat gloves with molded composite knuckle armor.
 * - High-detail tactical assault rifle with holographic optic, suppressor & PEQ-15.
 * - Skeletal animation blend tree (Idle, Walk, Run), shooting recoil & death collapse.
 */

class TacticalOperator {
  static models = {
    soldier: null,
    female: null,
    loadingPromise: null
  };

  /**
   * Preloads realistic rigged adult operator GLB models
   */
  static async loadAssets() {
    if (TacticalOperator.models.loadingPromise) {
      return TacticalOperator.models.loadingPromise;
    }

    TacticalOperator.models.loadingPromise = new Promise((resolve) => {
      if (typeof THREE === 'undefined' || typeof THREE.GLTFLoader === 'undefined') {
        console.warn('[TacticalOperator] THREE.GLTFLoader not found. Using procedural fallback.');
        resolve();
        return;
      }

      const loader = new THREE.GLTFLoader();
      let loaded = 0;
      const total = 2;

      const checkDone = () => {
        loaded++;
        if (loaded >= total) {
          console.log('[TacticalOperator] Preloaded adult tactical operator GLB character models.');
          resolve();
        }
      };

      loader.load(
        'models/Soldier.glb',
        (gltf) => {
          TacticalOperator.models.soldier = gltf;
          checkDone();
        },
        undefined,
        (err) => {
          console.warn('[TacticalOperator] Note loading Soldier.glb:', err);
          checkDone();
        }
      );

      loader.load(
        'models/FemaleOperator.glb',
        (gltf) => {
          TacticalOperator.models.female = gltf;
          checkDone();
        },
        undefined,
        (err) => {
          console.warn('[TacticalOperator] Note loading FemaleOperator.glb:', err);
          checkDone();
        }
      );
    });

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

    // Animation & Mixer State
    this.mixer = null;
    this.actions = {};
    this.currentAction = 'idle';

    // Root Group & Meshes
    this.root = new THREE.Group();
    this.modelRoot = null;
    this.weaponGroup = null;
    this.headMesh = null;
    this.bodyMesh = null;
    this.healthBarFill = null;
    this.nameTagSprite = null;

    this.initMaterials();
    this.buildCharacter();
    this.root.position.copy(this.initialPosition);
    this.scene.add(this.root);
  }

  initMaterials() {
    const isBlue = this.team === 'blue';
    const accentHex = isBlue ? 0x00f0ff : 0xff0055;
    this.accentColor = new THREE.Color(accentHex);

    this.materials = {
      // Dark tactical uniform ripstop fabric
      uniform: new THREE.MeshStandardMaterial({
        color: isBlue ? 0x181e26 : 0x221a1f,
        roughness: 0.75,
        metalness: 0.12
      }),
      // Coyote tan pants for female operator
      femalePants: new THREE.MeshStandardMaterial({
        color: 0x4f4333,
        roughness: 0.75,
        metalness: 0.1
      }),
      // Plate carrier fabric (tan/coyote or dark charcoal)
      plateCarrier: new THREE.MeshStandardMaterial({
        color: this.isFemale ? 0x594a38 : (isBlue ? 0x242830 : 0x3d302a),
        roughness: 0.65,
        metalness: 0.15
      }),
      // Matte tactical polymer (helmet, knee pads, holster, radio body, accessories)
      gearPolymer: new THREE.MeshStandardMaterial({
        color: 0x16181d,
        roughness: 0.35,
        metalness: 0.45
      }),
      // Ballistic Goggle Lens (mirrored reflective tint)
      goggleLens: new THREE.MeshStandardMaterial({
        color: accentHex,
        roughness: 0.1,
        metalness: 0.9,
        transparent: true,
        opacity: 0.85
      }),
      // Team identification glowing accent
      teamAccent: new THREE.MeshBasicMaterial({
        color: accentHex
      }),
      // Gunmetal metal for weapon & rails
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
      // Natural adult human skin
      skin: new THREE.MeshStandardMaterial({
        color: 0xc8967b,
        roughness: 0.6
      }),
      // Dark hair
      hair: new THREE.MeshStandardMaterial({
        color: 0x261d18,
        roughness: 0.8
      })
    };

    // Authentic CS-3D Velcro Chest Patch
    if (typeof TextureGenerator !== 'undefined' && typeof TextureGenerator.createPatchTexture === 'function') {
      const patchTex = TextureGenerator.createPatchTexture(this.team, 'CS-3D');
      this.materials.patch = new THREE.MeshBasicMaterial({
        map: patchTex,
        transparent: true
      });
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

    // Attach Callsign Nameplate & Floating Health Bar
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

  buildRiggedGLBModel(sourceGltf) {
    // Clone rigged skeletal mesh using Three.js SkeletonUtils
    this.modelRoot = THREE.SkeletonUtils.clone(sourceGltf.scene);

    // Standardize human adult height (~1.82m male, ~1.74m female)
    const scale = this.isFemale ? 0.95 : 1.0;
    this.modelRoot.scale.set(scale, scale, scale);

    // Enable shadows and configure tactical team materials
    const isBlue = this.team === 'blue';
    const uniformColor = isBlue ? new THREE.Color(0x181e26) : new THREE.Color(0x28181c);

    this.modelRoot.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;

        if (child.material) {
          child.material = child.material.clone();
          if (child.material.color) {
            child.material.color.lerp(uniformColor, 0.45);
          }
        }
      }
    });

    this.root.add(this.modelRoot);

    // Setup Animation Mixer and map animations
    if (sourceGltf.animations && sourceGltf.animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(this.modelRoot);

      const findClip = (keywords) => {
        for (const kw of keywords) {
          const found = sourceGltf.animations.find(a => a.name.toLowerCase().includes(kw));
          if (found) return found;
        }
        return sourceGltf.animations[0];
      };

      const idleClip = findClip(['idle']);
      const walkClip = findClip(['walk', 'jog']);
      const runClip = findClip(['run', 'sprint']);

      if (idleClip) this.actions.idle = this.mixer.clipAction(idleClip);
      if (walkClip) this.actions.walk = this.mixer.clipAction(walkClip);
      if (runClip) this.actions.run = this.mixer.clipAction(runClip);

      if (this.actions.idle) {
        this.actions.idle.play();
        this.currentAction = 'idle';
      }
    }

    // Attach authentic tactical equipment to rigged skeleton
    this.attachGearToRiggedBones();
  }

  attachGearToRiggedBones() {
    const headBone = this.findBone(['head']);
    const spine2Bone = this.findBone(['spine2', 'spine1']);
    const spine1Bone = this.findBone(['spine1', 'spine']);
    const rightHandBone = this.findBone(['righthand', 'hand_r', 'hand.r']);
    const leftHandBone = this.findBone(['lefthand', 'hand_l', 'hand.l']);
    const rightUpLegBone = this.findBone(['rightupleg', 'thigh_r', 'thigh.r']);
    const leftUpLegBone = this.findBone(['leftupleg', 'thigh_l', 'thigh.l']);
    const rightLegBone = this.findBone(['rightleg', 'shin_r', 'calf_r']);
    const leftLegBone = this.findBone(['leftleg', 'shin_l', 'calf_l']);

    // 1. Head Equipment (FAST Helmet / Goggles / Headset / Balaclava OR Cap / Ponytail)
    const headGear = this.isFemale ? this.buildFemaleHeadGear() : this.buildMaleHeadGear();
    if (headBone) {
      headGear.position.set(0, 0.04, 0);
      headBone.add(headGear);
    } else {
      headGear.position.set(0, 1.66, 0);
      this.root.add(headGear);
    }

    // 2. Chest Equipment (Plate Carrier, CS-3D Patch, Radio & Antenna)
    const plateCarrier = this.buildPlateCarrierGear();
    if (spine2Bone) {
      plateCarrier.position.set(0, -0.05, 0.02);
      spine2Bone.add(plateCarrier);
    } else {
      plateCarrier.position.set(0, 1.25, 0);
      this.root.add(plateCarrier);
    }

    // 3. Abdomen Equipment (Triple Magazine Pouches with tan PMAGs)
    const magPouches = this.buildTripleMagPouches();
    if (spine1Bone) {
      magPouches.position.set(0, 0.02, 0.14);
      spine1Bone.add(magPouches);
    } else {
      magPouches.position.set(0, 1.12, 0.14);
      this.root.add(magPouches);
    }

    // 4. Right Thigh (Drop-Leg Holster & Sidearm Pistol)
    const holster = this.buildDropLegHolster();
    if (rightUpLegBone) {
      holster.position.set(0.12, -0.16, 0.02);
      rightUpLegBone.add(holster);
    } else {
      holster.position.set(0.18, 0.65, 0);
      this.root.add(holster);
    }

    // 5. Left Thigh (Dual Magazine Pouches)
    const thighPouches = this.buildDualThighPouches();
    if (leftUpLegBone) {
      thighPouches.position.set(-0.11, -0.14, 0.02);
      leftUpLegBone.add(thighPouches);
    } else {
      thighPouches.position.set(-0.18, 0.65, 0);
      this.root.add(thighPouches);
    }

    // 6. Knees (Hard-Shell Tactical Knee Protection Pads)
    const rightKnee = this.buildKneePad();
    if (rightLegBone) {
      rightKnee.position.set(0, 0.05, 0.07);
      rightLegBone.add(rightKnee);
    } else {
      rightKnee.position.set(0.12, 0.45, 0.08);
      this.root.add(rightKnee);
    }

    const leftKnee = this.buildKneePad();
    if (leftLegBone) {
      leftKnee.position.set(0, 0.05, 0.07);
      leftLegBone.add(leftKnee);
    } else {
      leftKnee.position.set(-0.12, 0.45, 0.08);
      this.root.add(leftKnee);
    }

    // 7. Tactical Combat Gloves
    const rGlove = this.buildTacticalGlove(false);
    if (rightHandBone) {
      rGlove.position.set(0, 0, 0);
      rightHandBone.add(rGlove);
    }

    const lGlove = this.buildTacticalGlove(true);
    if (leftHandBone) {
      lGlove.position.set(0, 0, 0);
      leftHandBone.add(lGlove);
    }

    // 8. Custom Tactical Assault Rifle (Equipped in Right Hand)
    const rifle = this.buildRealisticAssaultRifle();
    this.weaponGroup = rifle;
    if (rightHandBone) {
      rifle.position.set(0.04, 0.08, -0.06);
      rifle.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
      rightHandBone.add(rifle);
    } else {
      rifle.position.set(0.25, 1.15, 0.25);
      this.root.add(rifle);
    }
  }

  buildMaleHeadGear() {
    const group = new THREE.Group();
    const { gearPolymer, goggleLens, uniform, teamAccent } = this.materials;

    // FAST Tactical High-Cut Helmet Shell
    const helmetShell = new THREE.Mesh(
      new THREE.SphereGeometry(0.138, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.56),
      gearPolymer
    );
    helmetShell.position.set(0, 0.04, -0.01);
    helmetShell.castShadow = true;
    group.add(helmetShell);

    // Front Wilcox NVG Shroud / Mount Bracket
    const nvgMount = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.048, 0.016), gearPolymer);
    nvgMount.position.set(0, 0.065, 0.135);
    group.add(nvgMount);

    const nvgSocket = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.018, 8), this.materials.metal);
    nvgSocket.position.set(0, 0.065, 0.144);
    nvgSocket.rotation.x = Math.PI / 2;
    group.add(nvgSocket);

    // Side ARC Accessory Rails
    const leftRail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.024, 0.11), gearPolymer);
    leftRail.position.set(-0.132, 0.04, 0.02);
    group.add(leftRail);

    const rightRail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.024, 0.11), gearPolymer);
    rightRail.position.set(0.132, 0.04, 0.02);
    group.add(rightRail);

    // Top & Side Velcro Loop Pads
    const topVelcro = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.006, 0.09), uniform);
    topVelcro.position.set(0, 0.138, -0.01);
    group.add(topVelcro);

    // Tactical Balaclava (Lower Face & Neck Covering)
    const balaclava = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.11, 0.16, 12), uniform);
    balaclava.position.set(0, -0.05, 0.01);
    group.add(balaclava);

    // Ballistic Goggles with Tinted Mirrored Lens
    const goggleFrame = new THREE.Mesh(new THREE.BoxGeometry(0.165, 0.046, 0.048), gearPolymer);
    goggleFrame.position.set(0, 0.025, 0.11);
    group.add(goggleFrame);

    const goggleLensMesh = new THREE.Mesh(new THREE.BoxGeometry(0.152, 0.038, 0.012), goggleLens);
    goggleLensMesh.position.set(0, 0.025, 0.135);
    group.add(goggleLensMesh);

    // Goggle Retention Strap
    const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.142, 0.142, 0.022, 16), uniform);
    strap.position.set(0, 0.025, -0.01);
    group.add(strap);

    // Communications Headset (Ear Cups & Boom Mic)
    const leftEarCup = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.062, 0.048), gearPolymer);
    leftEarCup.position.set(-0.136, 0.01, 0.01);
    group.add(leftEarCup);

    const rightEarCup = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.062, 0.048), gearPolymer);
    rightEarCup.position.set(0.136, 0.01, 0.01);
    group.add(rightEarCup);

    // Boom Microphone curving toward mouth
    const micArm = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.12, 6), this.materials.metal);
    micArm.rotation.set(0.3, 0.2, 0.9);
    micArm.position.set(-0.08, -0.04, 0.08);
    group.add(micArm);

    const micHead = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8), gearPolymer);
    micHead.position.set(-0.035, -0.05, 0.12);
    group.add(micHead);

    return group;
  }

  buildFemaleHeadGear() {
    const group = new THREE.Group();
    const { gearPolymer, hair, patch } = this.materials;

    // Tactical Baseball Cap Crown (Worn Bill-Forward)
    const capCrown = new THREE.Mesh(
      new THREE.SphereGeometry(0.130, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.54),
      gearPolymer
    );
    capCrown.position.set(0, 0.035, -0.01);
    capCrown.castShadow = true;
    group.add(capCrown);

    // Forward Stiff Curved Visor / Brim
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.012, 0.095), gearPolymer);
    brim.position.set(0, 0.02, 0.14);
    brim.rotation.x = -0.15;
    group.add(brim);

    // Front Velcro Unit Patch on Cap
    const capPatch = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.026, 0.006), patch);
    capPatch.position.set(0, 0.06, 0.12);
    capPatch.rotation.x = -0.25;
    group.add(capPatch);

    // Long Ponytail Hair Bundle exiting rear cap opening
    const ponytail = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.018, 0.32, 8), hair);
    ponytail.position.set(0, -0.08, -0.16);
    ponytail.rotation.x = -0.45;
    group.add(ponytail);

    // Over-Ear Communications Headset with Padded Headband
    const headband = new THREE.Mesh(new THREE.CylinderGeometry(0.134, 0.134, 0.024, 16), gearPolymer);
    headband.position.set(0, 0.04, -0.01);
    group.add(headband);

    const lEar = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.055, 0.044), gearPolymer);
    lEar.position.set(-0.132, 0.005, 0.01);
    group.add(lEar);

    const rEar = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.055, 0.044), gearPolymer);
    rEar.position.set(0.132, 0.005, 0.01);
    group.add(rEar);

    // Boom Microphone
    const micArm = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.11, 6), this.materials.metal);
    micArm.rotation.set(0.3, 0.2, 0.9);
    micArm.position.set(-0.08, -0.04, 0.08);
    group.add(micArm);

    const micHead = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 8), gearPolymer);
    micHead.position.set(-0.035, -0.05, 0.12);
    group.add(micHead);

    return group;
  }

  buildPlateCarrierGear() {
    const group = new THREE.Group();
    const { plateCarrier, gearPolymer, patch, teamAccent } = this.materials;

    // Armored Torso Plate Carrier Block
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.44, 0.28), plateCarrier);
    vest.position.set(0, 0, 0);
    vest.castShadow = true;
    group.add(vest);

    // Horizontal MOLLE Webbing Strips across chest
    for (let i = 0; i < 4; i++) {
      const molle = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.014, 0.008), gearPolymer);
      molle.position.set(0, 0.10 - i * 0.06, 0.144);
      group.add(molle);
    }

    // Authentic Stencil "CS-3D" Velcro Chest Patch
    const chestPatch = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.075, 0.008), patch);
    chestPatch.position.set(0, 0.12, 0.148);
    group.add(chestPatch);

    // Shoulder Straps with wire routing
    const lStrap = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.22), plateCarrier);
    lStrap.position.set(-0.16, 0.20, 0);
    group.add(lStrap);

    const rStrap = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.22), plateCarrier);
    rStrap.position.set(0.16, 0.20, 0);
    group.add(rStrap);

    // Tactical Shoulder Radio (PRC-152) on Left Chest
    const radio = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.11, 0.038), gearPolymer);
    radio.position.set(-0.16, 0.08, 0.14);
    group.add(radio);

    // Flexible Whip Radio Antenna extending up over shoulder
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.26, 6), gearPolymer);
    antenna.position.set(-0.17, 0.24, 0.12);
    antenna.rotation.z = -0.12;
    group.add(antenna);

    // Side Cummerbund Armor & Buckles
    const cummerbundL = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.18, 0.26), gearPolymer);
    cummerbundL.position.set(-0.205, -0.04, 0);
    group.add(cummerbundL);

    const cummerbundR = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.18, 0.26), gearPolymer);
    cummerbundR.position.set(0.205, -0.04, 0);
    group.add(cummerbundR);

    // Rear Compact Assault Hydration Pack
    const backPack = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.32, 0.075), plateCarrier);
    backPack.position.set(0, 0.04, -0.16);
    group.add(backPack);

    // Team Identification Patch on Upper Back
    const backPatch = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.006), teamAccent);
    backPatch.position.set(0, 0.14, -0.20);
    group.add(backPatch);

    return group;
  }

  buildTripleMagPouches() {
    const group = new THREE.Group();
    const { plateCarrier, tanPolymer, gearPolymer } = this.materials;

    // Triple Pouch Chassis
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.042), plateCarrier);
    group.add(chassis);

    // 3 Protruding PMAG 5.56 Magazines with Bungee Retention Pulls
    const offsets = [-0.085, 0, 0.085];
    offsets.forEach(x => {
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

    // Dual Thigh Leg Straps with Buckles
    const upperStrap = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.028, 0.18), uniform);
    upperStrap.position.set(0, 0.06, 0);
    group.add(upperStrap);

    const lowerStrap = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.028, 0.18), uniform);
    lowerStrap.position.set(0, -0.06, 0);
    group.add(lowerStrap);

    // Rigid Molded Kydex Holster Body
    const holsterBody = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.16, 0.065), gearPolymer);
    holsterBody.position.set(0.04, 0, 0);
    group.add(holsterBody);

    // Tactical Sidearm Pistol Holstered Inside
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

    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.026, 0.17), uniform);
    group.add(strap);

    const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.11, 0.042), plateCarrier);
    pouch.position.set(-0.035, 0, 0);
    group.add(pouch);

    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.035, 0.046), gearPolymer);
    flap.position.set(-0.035, 0.045, 0);
    group.add(flap);

    return group;
  }

  buildKneePad() {
    const group = new THREE.Group();
    const { gearPolymer, uniform } = this.materials;

    // Hard-Shell Molded Knee Cap
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.12, 0.05), gearPolymer);
    cap.position.set(0, 0, 0.02);
    group.add(cap);

    // Center Reinforcement Armor Rib
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.10, 0.06), gearPolymer);
    rib.position.set(0, 0, 0.025);
    group.add(rib);

    // Dual Elastic Straps behind knee
    const upperStrap = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.14), uniform);
    upperStrap.position.set(0, 0.04, -0.04);
    group.add(upperStrap);

    const lowerStrap = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.14), uniform);
    lowerStrap.position.set(0, -0.04, -0.04);
    group.add(lowerStrap);

    return group;
  }

  buildTacticalGlove(isLeft = false) {
    const group = new THREE.Group();
    const { gearPolymer, uniform } = this.materials;

    // Glove Hand Body
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.058, 0.082), uniform);
    group.add(glove);

    // Molded Composite Hard-Knuckle Armor Guard
    const knuckleGuard = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.024, 0.032), gearPolymer);
    knuckleGuard.position.set(0, 0.022, -0.015);
    group.add(knuckleGuard);

    // Wrist Cinch Strap with Velcro Tab
    const wristStrap = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.018, 0.024), gearPolymer);
    wristStrap.position.set(0, 0, 0.035);
    group.add(wristStrap);

    return group;
  }

  buildRealisticAssaultRifle() {
    const group = new THREE.Group();
    const { metal, gearPolymer, tanPolymer, goggleLens, teamAccent } = this.materials;

    // Upper & Lower Receiver
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.075, 0.34), metal);
    group.add(receiver);

    // Top Picatinny Rail
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.014, 0.28), gearPolymer);
    rail.position.set(0, 0.044, -0.04);
    group.add(rail);

    // Holographic Reflex Optic (EOTech Style)
    const opticBase = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.016, 0.085), gearPolymer);
    opticBase.position.set(0, 0.058, -0.04);
    group.add(opticBase);

    const opticHood = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.042, 0.075), gearPolymer);
    opticHood.position.set(0, 0.082, -0.04);
    group.add(opticHood);

    const opticGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.028, 0.028), goggleLens);
    opticGlass.position.set(0, 0.082, -0.078);
    group.add(opticGlass);

    const opticReticle = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.005, 0.005), teamAccent);
    opticReticle.position.set(0, 0.082, -0.04);
    group.add(opticReticle);

    // Forward Handguard & Barrel
    const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.048, 0.22), gearPolymer);
    handguard.position.set(0, 0.015, -0.26);
    group.add(handguard);

    // PEQ-15 Laser / IR Box on Top Front Rail
    const peqBox = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.024, 0.07), tanPolymer);
    peqBox.position.set(0, 0.048, -0.24);
    group.add(peqBox);

    // Under-barrel Vertical Tactical Foregrip
    const foregrip = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 8), gearPolymer);
    foregrip.position.set(0, -0.045, -0.24);
    group.add(foregrip);

    // Cylindrical Tactical Barrel Suppressor / Silencer
    const suppressor = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.22, 12), metal);
    suppressor.rotation.x = Math.PI / 2;
    suppressor.position.set(0, 0.015, -0.46);
    group.add(suppressor);

    // 30-Round Curved Magazine (Tan PMAG) with Textured Base
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.065), tanPolymer);
    mag.position.set(0, -0.09, -0.06);
    mag.rotation.x = -0.22;
    group.add(mag);

    // Ergonomic Stippled Pistol Grip
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.11, 0.045), gearPolymer);
    grip.position.set(0, -0.075, 0.10);
    grip.rotation.x = 0.35;
    group.add(grip);

    // SOPMOD Crane Buttstock
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.095, 0.18), tanPolymer);
    stock.position.set(0, 0.01, 0.24);
    group.add(stock);

    group.scale.set(1.05, 1.05, 1.05);
    return group;
  }

  buildProceduralAnatomicalModel() {
    this.modelRoot = new THREE.Group();
    const scale = this.isFemale ? 0.95 : 1.0;
    this.modelRoot.scale.set(scale, scale, scale);

    const { uniform, femalePants, skin } = this.materials;
    const pantsMat = this.isFemale ? femalePants : uniform;

    // Torso / Combat Shirt
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.48, 0.24), uniform);
    torso.position.set(0, 1.25, 0);
    torso.castShadow = true;
    this.modelRoot.add(torso);

    // Head Base
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), skin);
    head.position.set(0, 1.66, 0);
    this.modelRoot.add(head);

    // Arms
    const armGeo = new THREE.CylinderGeometry(0.055, 0.05, 0.60, 8);
    const leftArm = new THREE.Mesh(armGeo, uniform);
    leftArm.position.set(-0.25, 1.25, 0.08);
    leftArm.rotation.x = 0.4;
    this.modelRoot.add(leftArm);

    const rightArm = new THREE.Mesh(armGeo, uniform);
    rightArm.position.set(0.25, 1.25, 0.08);
    rightArm.rotation.x = 0.4;
    this.modelRoot.add(rightArm);

    // Legs
    const legGeo = new THREE.CylinderGeometry(0.075, 0.065, 0.85, 8);
    const leftLeg = new THREE.Mesh(legGeo, pantsMat);
    leftLeg.position.set(-0.12, 0.48, 0);
    this.modelRoot.add(leftLeg);

    const rightLeg = new THREE.Mesh(legGeo, pantsMat);
    rightLeg.position.set(0.12, 0.48, 0);
    this.modelRoot.add(rightLeg);

    this.root.add(this.modelRoot);

    // Attach all authentic tactical gear to procedural nodes
    const headGear = this.isFemale ? this.buildFemaleHeadGear() : this.buildMaleHeadGear();
    headGear.position.set(0, 1.66, 0);
    this.modelRoot.add(headGear);

    const plateCarrier = this.buildPlateCarrierGear();
    plateCarrier.position.set(0, 1.26, 0);
    this.modelRoot.add(plateCarrier);

    const magPouches = this.buildTripleMagPouches();
    magPouches.position.set(0, 1.12, 0.14);
    this.modelRoot.add(magPouches);

    const holster = this.buildDropLegHolster();
    holster.position.set(0.18, 0.62, 0);
    this.modelRoot.add(holster);

    const thighPouches = this.buildDualThighPouches();
    thighPouches.position.set(-0.18, 0.62, 0);
    this.modelRoot.add(thighPouches);

    const rKnee = this.buildKneePad();
    rKnee.position.set(0.12, 0.45, 0.08);
    this.modelRoot.add(rKnee);

    const lKnee = this.buildKneePad();
    lKnee.position.set(-0.12, 0.45, 0.08);
    this.modelRoot.add(lKnee);

    const rifle = this.buildRealisticAssaultRifle();
    rifle.position.set(0.22, 1.15, 0.22);
    this.weaponGroup = rifle;
    this.modelRoot.add(rifle);
  }

  buildHitboxes() {
    const headHitGeo = new THREE.BoxGeometry(0.38, 0.40, 0.38);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false, wireframe: true });

    this.headMesh = new THREE.Mesh(headHitGeo, hitMat);
    this.headMesh.position.set(0, 1.68, 0);
    this.headMesh.userData = { isHead: true, operator: this };
    this.root.add(this.headMesh);

    const bodyHitGeo = new THREE.CylinderGeometry(0.36, 0.36, 1.45, 8);
    this.bodyMesh = new THREE.Mesh(bodyHitGeo, hitMat);
    this.bodyMesh.position.set(0, 0.82, 0);
    this.bodyMesh.userData = { isHead: false, isBody: true, operator: this };
    this.root.add(this.bodyMesh);
  }

  buildOverheadHUD() {
    // 1. Callsign Nameplate Billboard
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    const isBlue = this.team === 'blue';
    ctx.fillStyle = isBlue ? 'rgba(0, 240, 255, 0.88)' : 'rgba(239, 68, 68, 0.88)';
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

    // 2. Health Bar Billboard
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
    if (this.weaponGroup) {
      this.weaponGroup.position.z += 0.04;
      setTimeout(() => {
        if (this.weaponGroup) this.weaponGroup.position.z -= 0.04;
      }, 55);
    }
  }

  updateAnimation(delta, speed = 0, isGrounded = true, camera = null) {
    if (this.mixer) {
      this.mixer.update(delta);
    }

    // Death collapse state
    if (this.isDead) {
      if (this.modelRoot) {
        this.modelRoot.rotation.x = THREE.MathUtils.lerp(this.modelRoot.rotation.x, -Math.PI / 2, delta * 8.0);
        this.modelRoot.position.y = THREE.MathUtils.lerp(this.modelRoot.position.y, 0.18, delta * 8.0);
      }
      if (this.nameTagSprite) this.nameTagSprite.visible = false;
      if (this.healthBarGroup) this.healthBarGroup.visible = false;
      return;
    }

    // Blend between Idle, Walk, and Run based on actual kinematic speed
    if (this.actions.idle && (this.actions.walk || this.actions.run)) {
      let targetAction = 'idle';
      if (speed > 5.5 && this.actions.run) {
        targetAction = 'run';
      } else if (speed > 0.35 && this.actions.walk) {
        targetAction = 'walk';
      }

      if (targetAction !== this.currentAction) {
        const prev = this.actions[this.currentAction];
        const next = this.actions[targetAction];
        if (prev && next) {
          prev.fadeOut(0.22);
          next.reset().fadeIn(0.22).play();
          this.currentAction = targetAction;
        }
      }
    }

    // Ensure overhead billboards face camera
    if (camera) {
      if (this.healthBarGroup) {
        this.healthBarGroup.quaternion.copy(camera.quaternion);
      }
      if (this.nameTagSprite) {
        this.nameTagSprite.quaternion.copy(camera.quaternion);
      }
    }
  }

  takeDamage(amount, isHeadshot = false) {
    if (this.isDead) return true;

    this.health = Math.max(0, this.health - amount);

    // Update floating health bar width
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

    if (this.modelRoot) {
      this.modelRoot.rotation.x = 0;
      this.modelRoot.position.y = 0;
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
    if (this.root && this.scene) {
      this.scene.remove(this.root);
    }
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
  }
}
