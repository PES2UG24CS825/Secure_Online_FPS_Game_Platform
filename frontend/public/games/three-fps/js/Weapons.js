/**
 * SecureFPS: Weapon Viewmodel, Ballistics & Combat Engine
 * Implements 4 complete weapons (P-24 Carbine, Vector-9 SMG, AWM-50 Sniper, G-18 Pistol),
 * weapon switching (keys 1-4, mouse wheel), procedural 3D viewmodels, recoil kick, idle sway,
 * muzzle flash, hitscan raycasting against bots and remote players, bullet tracers, impact sparks,
 * ammunition management, reload cycles, and telemetry integration.
 */

const WEAPON_REGISTRY = {
  carbine: {
    id: 'carbine',
    name: 'P-24 Carbine',
    caliber: '5.56x45mm NATO',
    slot: 1,
    damage: 25,
    headshotMultiplier: 2.0, // 50 Headshot
    fireRate: 0.11, // ~545 RPM
    bulletSpeed: 240, // 240 m/s
    tracerColor: 0xffb703,
    tracerLength: 0.65,
    tracerRadius: 0.016,
    magSize: 30,
    magAmmo: 30,
    reserveAmmo: 120,
    reloadDuration: 1.6,
    baseSpread: 0.004,
    recoilKickZ: 0.08,
    recoilKickY: 0.02,
    recoilRotX: 0.09,
    camRecoil: 0.014,
    soundType: 'rifle'
  },
  smg: {
    id: 'smg',
    name: 'Vector-9 SMG',
    caliber: '9x19mm Parabellum',
    slot: 2,
    damage: 18,
    headshotMultiplier: 2.0, // 36 Headshot
    fireRate: 0.07, // ~850 RPM
    bulletSpeed: 175, // 175 m/s
    tracerColor: 0xffaa00,
    tracerLength: 0.45,
    tracerRadius: 0.014,
    magSize: 35,
    magAmmo: 35,
    reserveAmmo: 140,
    reloadDuration: 1.3,
    baseSpread: 0.007,
    recoilKickZ: 0.05,
    recoilKickY: 0.015,
    recoilRotX: 0.06,
    camRecoil: 0.009,
    soundType: 'smg'
  },
  sniper: {
    id: 'sniper',
    name: 'AWM-50 Recon',
    caliber: '.338 Lapua Magnum',
    slot: 3,
    damage: 80,
    headshotMultiplier: 1.375, // 110 Headshot
    fireRate: 1.1, // Bolt-Action ~55 RPM
    bulletSpeed: 420, // 420 m/s
    tracerColor: 0x00f0ff,
    tracerLength: 1.2,
    tracerRadius: 0.022,
    magSize: 5,
    magAmmo: 5,
    reserveAmmo: 25,
    reloadDuration: 2.4,
    baseSpread: 0.0005,
    recoilKickZ: 0.18,
    recoilKickY: 0.05,
    recoilRotX: 0.22,
    camRecoil: 0.038,
    soundType: 'sniper'
  },
  pistol: {
    id: 'pistol',
    name: 'G-18 Tactical',
    caliber: '9x19mm Luger',
    slot: 4,
    damage: 22,
    headshotMultiplier: 2.0, // 44 Headshot
    fireRate: 0.15, // Semi-Auto ~400 RPM
    bulletSpeed: 150, // 150 m/s
    tracerColor: 0xffd166,
    tracerLength: 0.35,
    tracerRadius: 0.013,
    magSize: 17,
    magAmmo: 17,
    reserveAmmo: 68,
    reloadDuration: 1.2,
    baseSpread: 0.005,
    recoilKickZ: 0.06,
    recoilKickY: 0.02,
    recoilRotX: 0.10,
    camRecoil: 0.012,
    soundType: 'pistol'
  }
};

class WeaponManager {
  constructor(scene, camera, audio) {
    this.scene = scene;
    this.camera = camera;
    this.audio = audio;

    // Active Weapon Inventory
    this.weapons = JSON.parse(JSON.stringify(WEAPON_REGISTRY));
    this.activeKey = 'carbine';
    this.activeWeapon = this.weapons.carbine;

    // Timing & Combat State
    this.lastShotTime = 0;
    this.isReloading = false;
    this.reloadStartTime = 0;
    this.isSwitching = false;
    this.switchTimer = 0;
    this.targetWeaponKey = null;

    // Viewmodel Positioning & Animation State
    this.weaponRoot = new THREE.Object3D();
    this.defaultPos = new THREE.Vector3(0.24, -0.22, -0.48);
    this.adsPos = new THREE.Vector3(0, -0.19, -0.38);
    this.isAiming = false;
    this.currentAimAlpha = 0;
    this.baseFov = 75;
    this.sniperScopeOverlay = document.getElementById('sniper-scope-overlay');
    this.currentRecoil = new THREE.Vector3(0, 0, 0);
    this.recoilRot = new THREE.Euler(0, 0, 0);
    this.swayPos = new THREE.Vector3(0, 0, 0);

    // Muzzle Flash & Visual FX
    this.muzzleLight = null;
    this.muzzleMesh = null;
    this.flashTimer = 0;
    this.tracers = [];
    this.activeTracers = [];
    this.shellCasings = [];
    this.impactParticles = [];

    // Weapon 3D Viewmodel Meshes Map
    this.viewmodelMeshes = {};

    // Input Trigger State
    this.isFiring = false;

    // DOM Elements
    this.weaponNameEl = document.querySelector('.weapon-name');
    this.weaponCaliberEl = document.querySelector('.weapon-caliber');
    this.ammoClipEl = document.getElementById('ammo-clip');
    this.ammoReserveEl = document.querySelector('.ammo-reserve');
    this.reloadingIndicator = document.getElementById('reloading-indicator');
    this.hitmarkerEl = document.getElementById('hitmarker');

    this.initViewmodels();
    this.initEvents();
    this.updateHUD();
  }

  initViewmodels() {
    this.weaponRoot.position.copy(this.defaultPos);
    this.camera.add(this.weaponRoot);

    // Common Materials
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0x1f2937,
      roughness: 0.35,
      metalness: 0.85
    });

    const polymerMat = new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.7,
      metalness: 0.2
    });

    const glassMat = new THREE.MeshBasicMaterial({
      color: 0x00f0ff,
      transparent: true,
      opacity: 0.6
    });

    // 1. Build P-24 Tactical Assault Rifle Viewmodel (Matching Reference Image)
    const carbineGroup = new THREE.Group();
    const tanMagMat = new THREE.MeshStandardMaterial({ color: 0x826c50, roughness: 0.6, metalness: 0.2 });
    const reticleMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });

    // Receiver (Upper & Lower)
    const cReceiver = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.085, 0.38), metalMat);
    carbineGroup.add(cReceiver);

    // Top Picatinny Rail
    const cRail = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.015, 0.32), polymerMat);
    cRail.position.set(0, 0.048, -0.06);
    carbineGroup.add(cRail);

    // Holographic Weapon Sight (EOTech Style with Hood & Illuminated Reticle)
    const cOpticBase = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.016, 0.09), polymerMat);
    cOpticBase.position.set(0, 0.062, -0.06);
    carbineGroup.add(cOpticBase);

    const cOpticHood = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.046, 0.08), polymerMat);
    cOpticHood.position.set(0, 0.088, -0.06);
    carbineGroup.add(cOpticHood);

    const cOpticGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.030, 0.030), glassMat);
    cOpticGlass.position.set(0, 0.088, -0.10);
    carbineGroup.add(cOpticGlass);

    const cOpticReticle = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.005, 0.005), reticleMat);
    cOpticReticle.position.set(0, 0.088, -0.06);
    carbineGroup.add(cOpticReticle);

    // Forward Handguard & Barrel
    const cBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.30, 12), metalMat);
    cBarrel.rotation.x = Math.PI / 2;
    cBarrel.position.set(0, 0.02, -0.32);
    carbineGroup.add(cBarrel);

    const cHandguard = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.054, 0.22), polymerMat);
    cHandguard.position.set(0, 0.02, -0.28);
    carbineGroup.add(cHandguard);

    // PEQ-15 Laser Box on Top Front Rail
    const cPeq = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.025, 0.075), tanMagMat);
    cPeq.position.set(0, 0.055, -0.26);
    carbineGroup.add(cPeq);

    // Under-barrel Vertical Foregrip
    const cForegrip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.09, 8), polymerMat);
    cForegrip.position.set(0, -0.045, -0.26);
    carbineGroup.add(cForegrip);

    // Tactical Cylindrical Barrel Suppressor / Silencer
    const cSuppressor = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.22, 12), metalMat);
    cSuppressor.rotation.x = Math.PI / 2;
    cSuppressor.position.set(0, 0.02, -0.54);
    carbineGroup.add(cSuppressor);

    // 30-Round Curved Magazine (Tan PMAG) with Textured Base
    const cMag = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.17, 0.07), tanMagMat);
    cMag.position.set(0, -0.09, -0.05);
    cMag.rotation.x = -0.20;
    carbineGroup.add(cMag);

    // Ergonomic Stippled Pistol Grip
    const cGrip = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.13, 0.05), polymerMat);
    cGrip.position.set(0, -0.08, 0.12);
    cGrip.rotation.x = 0.35;
    carbineGroup.add(cGrip);

    // SOPMOD Crane Stock
    const cStock = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.095, 0.20), tanMagMat);
    cStock.position.set(0, -0.01, 0.26);
    carbineGroup.add(cStock);

    this.viewmodelMeshes.carbine = carbineGroup;
    this.weaponRoot.add(carbineGroup);

    // 2. Build Vector-9 SMG Viewmodel
    const smgGroup = new THREE.Group();
    const sReceiver = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.11, 0.28), polymerMat);
    smgGroup.add(sReceiver);

    const sBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.18, 12), metalMat);
    sBarrel.rotation.x = Math.PI / 2;
    sBarrel.position.set(0, 0.02, -0.23);
    smgGroup.add(sBarrel);

    const sMag = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.20, 0.05), metalMat);
    sMag.position.set(0, -0.12, -0.08);
    sMag.rotation.x = 0.25;
    smgGroup.add(sMag);

    const sGrip = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.12, 0.05), polymerMat);
    sGrip.position.set(0, -0.07, 0.08);
    sGrip.rotation.x = 0.32;
    smgGroup.add(sGrip);

    smgGroup.visible = false;
    this.viewmodelMeshes.smg = smgGroup;
    this.weaponRoot.add(smgGroup);

    // 3. Build AWM-50 Recon Sniper Viewmodel
    const sniperGroup = new THREE.Group();
    const snReceiver = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.09, 0.44), metalMat);
    sniperGroup.add(snReceiver);

    const snBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.58, 12), metalMat);
    snBarrel.rotation.x = Math.PI / 2;
    snBarrel.position.set(0, 0.02, -0.51);
    sniperGroup.add(snBarrel);

    const snBrake = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.08), metalMat);
    snBrake.position.set(0, 0.02, -0.82);
    sniperGroup.add(snBrake);

    const snStock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.12, 0.30), polymerMat);
    snStock.position.set(0, -0.02, 0.35);
    sniperGroup.add(snStock);

    // Telescopic Sniper Scope
    const snScopeTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.26, 16), metalMat);
    snScopeTube.rotation.x = Math.PI / 2;
    snScopeTube.position.set(0, 0.08, -0.06);
    sniperGroup.add(snScopeTube);

    const snScopeLens = new THREE.Mesh(new THREE.CircleGeometry(0.021, 16), glassMat);
    snScopeLens.position.set(0, 0.08, 0.07);
    sniperGroup.add(snScopeLens);

    sniperGroup.visible = false;
    this.viewmodelMeshes.sniper = sniperGroup;
    this.weaponRoot.add(sniperGroup);

    // 4. Build G-18 Tactical Pistol Viewmodel
    const pistolGroup = new THREE.Group();
    const pSlide = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.22), metalMat);
    pSlide.position.set(0, 0.02, -0.04);
    pistolGroup.add(pSlide);

    const pFrame = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.04, 0.20), polymerMat);
    pFrame.position.set(0, -0.01, -0.04);
    pistolGroup.add(pFrame);

    const pGrip = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.12, 0.055), polymerMat);
    pGrip.position.set(0, -0.07, 0.04);
    pGrip.rotation.x = 0.32;
    pistolGroup.add(pGrip);

    pistolGroup.visible = false;
    this.viewmodelMeshes.pistol = pistolGroup;
    this.weaponRoot.add(pistolGroup);

    // 5. Build Realistic First-Person Tactical Hands & Forearms (Matching Reference Image)
    const gloveMat = new THREE.MeshStandardMaterial({
      color: 0x181a1f,
      roughness: 0.60,
      metalness: 0.25
    });
    const knuckleMat = new THREE.MeshStandardMaterial({
      color: 0x0f1115,
      roughness: 0.30,
      metalness: 0.55
    });
    const sleeveMat = new THREE.MeshStandardMaterial({
      color: 0x141820,
      roughness: 0.80,
      metalness: 0.10
    });

    const handsGroup = new THREE.Group();

    // --- Left Arm & Hand (Supporting forward handguard & vertical grip from below) ---
    const lForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.052, 0.38, 10), sleeveMat);
    lForearm.rotation.set(0.65, 0.35, -0.65);
    lForearm.position.set(-0.20, -0.16, -0.14);
    handsGroup.add(lForearm);

    // Stitched sleeve cuff
    const lCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.048, 0.04, 10), sleeveMat);
    lCuff.rotation.set(0.65, 0.35, -0.65);
    lCuff.position.set(-0.13, -0.10, -0.19);
    handsGroup.add(lCuff);

    // Left tactical glove body
    const lGlove = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.062, 0.095), gloveMat);
    lGlove.position.set(-0.08, -0.05, -0.23);
    lGlove.rotation.set(0.25, 0.50, -0.30);
    handsGroup.add(lGlove);

    // Molded composite hard-knuckle armor guard on left glove
    const lKnuckles = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.022, 0.035), knuckleMat);
    lKnuckles.position.set(-0.075, -0.03, -0.25);
    lKnuckles.rotation.set(0.25, 0.50, -0.30);
    handsGroup.add(lKnuckles);

    // Left thumb supporting grip
    const lThumb = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.045, 0.024), gloveMat);
    lThumb.position.set(-0.05, -0.035, -0.22);
    lThumb.rotation.set(0.3, 0.1, -0.4);
    handsGroup.add(lThumb);

    // --- Right Arm & Hand (Gripping pistol grip & trigger from right) ---
    const rForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.052, 0.38, 10), sleeveMat);
    rForearm.rotation.set(0.75, -0.30, 0.45);
    rForearm.position.set(0.16, -0.19, 0.12);
    handsGroup.add(rForearm);

    // Stitched sleeve cuff
    const rCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.048, 0.04, 10), sleeveMat);
    rCuff.rotation.set(0.75, -0.30, 0.45);
    rCuff.position.set(0.09, -0.13, 0.11);
    handsGroup.add(rCuff);

    // Right tactical glove body
    const rGlove = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.062, 0.090), gloveMat);
    rGlove.position.set(0.02, -0.07, 0.10);
    rGlove.rotation.set(0.35, -0.10, 0.20);
    handsGroup.add(rGlove);

    // Molded composite hard-knuckle armor guard on right glove
    const rKnuckles = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.022, 0.035), knuckleMat);
    rKnuckles.position.set(0.025, -0.05, 0.09);
    rKnuckles.rotation.set(0.35, -0.10, 0.20);
    handsGroup.add(rKnuckles);

    // Right index trigger finger
    const rTriggerFinger = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.048), gloveMat);
    rTriggerFinger.position.set(-0.01, -0.045, 0.06);
    rTriggerFinger.rotation.set(0.1, 0.2, 0.3);
    handsGroup.add(rTriggerFinger);

    this.weaponRoot.add(handsGroup);
    this.handsGroup = handsGroup;

    // Muzzle Flash Effect (Shared)
    const flashGeo = new THREE.PlaneGeometry(0.18, 0.18);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xfff066,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide
    });
    this.muzzleMesh = new THREE.Mesh(flashGeo, flashMat);
    this.muzzleMesh.position.set(0, 0.02, -0.56);
    this.weaponRoot.add(this.muzzleMesh);

    this.muzzleLight = new THREE.PointLight(0xffb703, 0, 10);
    this.muzzleLight.position.set(0, 0.02, -0.56);
    this.weaponRoot.add(this.muzzleLight);
  }

  initEvents() {
    // Prevent browser context menu so Right-Click ADS works cleanly
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    // Mouse Trigger Press / Release & ADS
    window.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.isFiring = true;
      if (e.button === 2) {
        e.preventDefault();
        this.isAiming = true;
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.isFiring = false;
      if (e.button === 2) {
        e.preventDefault();
        this.isAiming = false;
      }
    });

    // Weapon Switch via Keys (1 - 4) & Reload (R)
    window.addEventListener('keydown', (e) => {
      if (window.SecureFPSGame?.isMenuOpen && e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      const code = e.code;
      const key = e.key;

      if (code === 'Digit1' || key === '1') this.switchWeapon('carbine');
      else if (code === 'Digit2' || key === '2') this.switchWeapon('smg');
      else if (code === 'Digit3' || key === '3') this.switchWeapon('sniper');
      else if (code === 'Digit4' || key === '4') this.switchWeapon('pistol');
      else if (code === 'KeyR' || key === 'r' || key === 'R') this.reload();
    });

    // Weapon Switch via Mouse Scroll Wheel
    window.addEventListener('wheel', (e) => {
      const keys = ['carbine', 'smg', 'sniper', 'pistol'];
      const currentIndex = keys.indexOf(this.activeKey);
      let nextIndex = currentIndex;
      if (e.deltaY > 0) {
        nextIndex = (currentIndex + 1) % keys.length;
      } else if (e.deltaY < 0) {
        nextIndex = (currentIndex - 1 + keys.length) % keys.length;
      }
      if (nextIndex !== currentIndex) {
        this.switchWeapon(keys[nextIndex]);
      }
    });

    // Action listener
    window.addEventListener('fps:action', (e) => {
      if (e.detail?.type === 'reload') this.reload();
    });
  }

  switchWeapon(newKey) {
    if (!this.weapons[newKey] || this.activeKey === newKey || this.isSwitching) return;

    this.isSwitching = true;
    this.targetWeaponKey = newKey;
    this.switchTimer = 0.22; // Lower duration
    this.isReloading = false;
    if (this.reloadingIndicator) this.reloadingIndicator.classList.remove('active');

    if (this.audio) this.audio.playSwitch();
  }

  reload() {
    const w = this.activeWeapon;
    if (this.isReloading || this.isSwitching) return;
    if (w.magAmmo >= w.magSize || w.reserveAmmo <= 0) return;

    this.isReloading = true;
    this.reloadStartTime = performance.now() / 1000;

    if (this.audio) {
      if (typeof this.audio.playWeaponReload === 'function') {
        this.audio.playWeaponReload(this.activeKey, w.reloadDuration);
      } else {
        this.audio.playReload();
      }
    }
    if (this.reloadingIndicator) this.reloadingIndicator.classList.add('active');
  }

  update(delta, controller, botManager) {
    const now = performance.now() / 1000;
    const w = this.activeWeapon;

    // 1. Weapon Switch Transition (Smooth Lower & Raise)
    if (this.isSwitching) {
      this.switchTimer -= delta;
      if (this.switchTimer <= 0) {
        if (this.targetWeaponKey) {
          // Switch active viewmodel mesh
          Object.keys(this.viewmodelMeshes).forEach(k => {
            this.viewmodelMeshes[k].visible = (k === this.targetWeaponKey);
          });
          this.activeKey = this.targetWeaponKey;
          this.activeWeapon = this.weapons[this.activeKey];
          this.targetWeaponKey = null;
          this.switchTimer = 0.18; // Raise duration
          this.updateHUD();
        } else {
          this.isSwitching = false;
        }
      }
    }

    // 2. Handle Reload Completion & Procedural Weapon Reload Motion
    let reloadOffset = new THREE.Vector3(0, 0, 0);
    let reloadRotOffset = new THREE.Vector3(0, 0, 0);

    if (this.isReloading) {
      const elapsed = now - this.reloadStartTime;
      const progress = Math.min(1.0, elapsed / w.reloadDuration);

      if (progress >= 1.0) {
        const needed = w.magSize - w.magAmmo;
        const available = Math.min(needed, w.reserveAmmo);
        w.magAmmo += available;
        w.reserveAmmo -= available;
        this.isReloading = false;
        if (this.reloadingIndicator) this.reloadingIndicator.classList.remove('active');
        this.updateHUD();
      } else {
        // Natural tactical reload curve: dip weapon down and tilt receiver
        const curve = Math.sin(progress * Math.PI);
        reloadOffset.y = -curve * 0.16;
        reloadOffset.z = -curve * 0.08;
        reloadRotOffset.x = -curve * 0.28;
        reloadRotOffset.z = curve * 0.22;
      }
    }

    // 3. Firing Logic (Automatic Trigger Check)
    if (this.isFiring && !this.isReloading && !this.isSwitching && controller?.isLocked) {
      if (now - this.lastShotTime >= w.fireRate) {
        if (w.magAmmo > 0) {
          this.fire(controller, botManager);
          this.lastShotTime = now;
        } else {
          // Empty click & auto-reload
          if (this.audio) this.audio.playEmptyClick();
          this.lastShotTime = now;
          this.reload();
        }
      }
    }

    // 4. Update Muzzle Flash Light Decay
    if (this.flashTimer > 0) {
      this.flashTimer -= delta;
      if (this.flashTimer <= 0) {
        this.muzzleLight.intensity = 0;
        this.muzzleMesh.material.opacity = 0;
      }
    }

    // 5. Weapon Recoil Spring Recovery
    this.currentRecoil.lerp(new THREE.Vector3(0, 0, 0), delta * 14.0);
    this.recoilRot.x = THREE.MathUtils.lerp(this.recoilRot.x, 0, delta * 12.0);

    // 6. Aim Down Sights (ADS) & Optical Scope Interpolation
    const targetAimAlpha = (this.isAiming && controller?.isLocked) ? 1.0 : 0.0;
    this.currentAimAlpha += (targetAimAlpha - this.currentAimAlpha) * Math.min(1.0, delta * 14.0);

    const targetWeaponPos = this.defaultPos.clone().lerp(this.adsPos, this.currentAimAlpha);

    // Camera FOV Optical Zoom
    let targetFov = this.baseFov;
    if (this.isAiming && controller?.isLocked) {
      targetFov = (this.activeKey === 'sniper') ? 22.0 : 52.0;
    }
    if (this.camera && Math.abs(this.camera.fov - targetFov) > 0.1) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1.0, delta * 14.0);
      this.camera.updateProjectionMatrix();
    }

    // Sniper Scope Overlay Toggle
    if (!this.sniperScopeOverlay) this.sniperScopeOverlay = document.getElementById('sniper-scope-overlay');
    if (this.sniperScopeOverlay) {
      if (this.activeKey === 'sniper' && this.currentAimAlpha > 0.85 && controller?.isLocked) {
        this.sniperScopeOverlay.style.display = 'flex';
        this.weaponRoot.visible = false;
      } else {
        this.sniperScopeOverlay.style.display = 'none';
        this.weaponRoot.visible = true;
      }
    }

    // Viewmodel Idle Sway & Movement Breathing
    const swaySpeed = controller?.isSprinting ? 11.0 : controller?.isGrounded && (controller?.keys.forward || controller?.keys.backward || controller?.keys.left || controller?.keys.right) ? 8.0 : 2.5;
    const swayAmp = this.isAiming ? 0.002 : (controller?.isSprinting ? 0.024 : 0.008);

    this.swayPos.x = Math.sin(now * swaySpeed * 0.5) * swayAmp;
    this.swayPos.y = Math.cos(now * swaySpeed) * (swayAmp * 0.6);

    // Apply Switch Lowering Offset
    const switchLowerY = this.isSwitching ? -0.35 : 0;

    // Apply Composite Position & Rotation
    this.weaponRoot.position.set(
      targetWeaponPos.x + this.swayPos.x + this.currentRecoil.x + reloadOffset.x,
      targetWeaponPos.y + this.swayPos.y + this.currentRecoil.y + switchLowerY + reloadOffset.y,
      targetWeaponPos.z + this.currentRecoil.z + reloadOffset.z
    );

    this.weaponRoot.rotation.set(
      this.recoilRot.x + reloadRotOffset.x,
      this.recoilRot.y + reloadRotOffset.y,
      this.recoilRot.z + reloadRotOffset.z
    );

    // 7. Update Active Particle FX
    try {
      this.updateParticles(delta);
    } catch (err) {
      console.warn('[WeaponManager] Particle update suppressed:', err);
    }
  }

  fire(controller, botManager) {
    const w = this.activeWeapon;
    w.magAmmo--;
    this.updateHUD();

    // Play Caliber-Specific Gunshot Audio
    if (this.audio) this.audio.playGunshot(w.soundType);

    // Trigger Visual Muzzle Flash
    this.muzzleLight.intensity = w.id === 'sniper' ? 4.5 : 2.5;
    this.muzzleMesh.material.opacity = 0.95;
    this.muzzleMesh.rotation.z = Math.random() * Math.PI * 2;
    this.flashTimer = 0.045;

    // Eject Brass Bullet Casing
    this.spawnShellEjection();

    // Recoil Kick
    this.currentRecoil.z = w.recoilKickZ;
    this.currentRecoil.y = w.recoilKickY;
    this.recoilRot.x = w.recoilRotX;

    // Camera Recoil Pitch
    if (controller) {
      controller.pitch += w.camRecoil;
    }

    // Spread Calculation
    let spread = w.baseSpread;
    if (controller) {
      if (!controller.isGrounded) spread *= 3.0;
      else if (controller.isSprinting) spread *= 2.2;
      else if (controller.isCrouching) spread *= 0.6;
    }

    const spreadX = (Math.random() - 0.5) * spread;
    const spreadY = (Math.random() - 0.5) * spread;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(spreadX, spreadY), this.camera);

    // Query scene for hits (Bots, Remote Players, Arena Colliders)
    const hits = raycaster.intersectObjects(this.scene.children, true);

    let targetHit = null;
    let hitPoint = new THREE.Vector3();
    let hitNormal = new THREE.Vector3(0, 1, 0);

    const camPos = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);

    for (const hit of hits) {
      // Discard viewmodel self-intersections or muzzle mesh
      if (hit.object === this.muzzleMesh || this.weaponRoot.getObjectById(hit.object.id)) {
        continue;
      }
      // Ignore self-clipping under 0.35m
      if (hit.distance < 0.35) continue;
      // Strictly prevent hits behind or perpendicular to player
      const toHit = hit.point.clone().sub(camPos).normalize();
      if (camDir.dot(toHit) < 0.2) continue;

      targetHit = hit;
      hitPoint.copy(hit.point);
      if (hit.face) hitNormal.copy(hit.face.normal);
      break;
    }

    if (!targetHit) {
      hitPoint.copy(raycaster.ray.origin).add(raycaster.ray.direction.clone().multiplyScalar(120));
    }

    // Render Tracer Line safely
    try {
      this.createTracer(hitPoint);
    } catch (e) {
      console.warn('[WeaponManager] Tracer creation suppressed:', e);
    }

    // Process Combat Damage
    let hitTargetName = null;
    let isHeadshot = false;

    // Target Resolver: traverse up hierarchy to find bot or remote player
    const resolveCombatTarget = (obj) => {
      let curr = obj;
      while (curr) {
        if (curr.userData) {
          if (curr.userData.bot) return { type: 'bot', bot: curr.userData.bot, isHead: !!obj.userData?.isHead };
          if (curr.userData.remotePlayer) return { type: 'remote', remote: curr.userData.remotePlayer, isHead: !!obj.userData?.isHead };
          if (curr.userData.target) return { type: 'target', target: curr.userData.target, isHead: !!obj.userData?.isHead };
          if (curr.userData.operator?.bot) return { type: 'bot', bot: curr.userData.operator.bot, isHead: !!obj.userData?.isHead };
          if (curr.userData.operator?.remotePlayer) return { type: 'remote', remote: curr.userData.operator.remotePlayer, isHead: !!obj.userData?.isHead };
        }
        curr = curr.parent;
      }
      return null;
    };

    const resolved = targetHit ? resolveCombatTarget(targetHit.object) : null;

    // 1. Check Bot Hit
    if (resolved && resolved.type === 'bot') {
      const bot = resolved.bot;
      isHeadshot = resolved.isHead;
      const dealtDamage = Math.round(isHeadshot ? w.damage * w.headshotMultiplier : w.damage);

      const botDead = bot.takeDamage(dealtDamage, isHeadshot);
      hitTargetName = bot.name || "Combat Bot";

      // Record damage dealt for combat stats & assist tracking
      if (window.SecureFPSGame?.gameMode?.recordDamageDealt) {
        window.SecureFPSGame.gameMode.recordDamageDealt(hitTargetName, dealtDamage);
      }

      if (this.audio) this.audio.playHitmarker(isHeadshot);
      this.triggerHitmarkerHUD(isHeadshot);

      // Render Floating Damage Numbers in Screen Space
      if (this.camera && window.SecureFPSGame?.hud?.showFloatingDamage) {
        const screenPos = hitPoint.clone().project(this.camera);
        const screenX = (screenPos.x * 0.5 + 0.5) * window.innerWidth;
        const screenY = (-(screenPos.y * 0.5) + 0.5) * window.innerHeight;
        window.SecureFPSGame.hud.showFloatingDamage(screenX, screenY, dealtDamage, isHeadshot);
      }

      if (botDead) {
        if (window.SecureFPSGame?.hud?.showElimination) {
          window.SecureFPSGame.hud.showElimination(bot.name, isHeadshot);
        }
        if (this.audio?.playEliminationSound) {
          this.audio.playEliminationSound(isHeadshot);
        }
        window.dispatchEvent(new CustomEvent('fps:kill', {
          detail: { victim: bot.name, headshot: isHeadshot, weapon: w.name }
        }));
      }

      window.dispatchEvent(new CustomEvent('fps:telemetry_hit', {
        detail: { target: hitTargetName, damage: dealtDamage, headshot: isHeadshot }
      }));

    // Check Training Target Hit
    } else if (resolved && resolved.type === 'target') {
      if (window.SecureFPSGame?.trainingManager) {
        window.SecureFPSGame.trainingManager.handleBulletHit(targetHit.object);
      }
      this.triggerHitmarkerHUD(resolved.isHead);

    // 2. Check Remote Player Hit (Multiplayer)
    } else if (resolved && resolved.type === 'remote') {
      const remote = resolved.remote;
      isHeadshot = !!targetHit.object.userData.isHead;
      const dealtDamage = Math.round(isHeadshot ? w.damage * w.headshotMultiplier : w.damage);
      hitTargetName = remote.name || "Remote Operator";

      if (window.SecureFPSGame?.gameMode?.recordDamageDealt) {
        window.SecureFPSGame.gameMode.recordDamageDealt(hitTargetName, dealtDamage);
      }

      if (this.audio) this.audio.playHitmarker(isHeadshot);
      this.triggerHitmarkerHUD(isHeadshot);

      if (this.camera && window.SecureFPSGame?.hud?.showFloatingDamage) {
        const screenPos = hitPoint.clone().project(this.camera);
        const screenX = (screenPos.x * 0.5 + 0.5) * window.innerWidth;
        const screenY = (-(screenPos.y * 0.5) + 0.5) * window.innerHeight;
        window.SecureFPSGame.hud.showFloatingDamage(screenX, screenY, dealtDamage, isHeadshot);
      }

      if (window.SecureFPSGame?.multiplayer) {
        window.SecureFPSGame.multiplayer.emitFire(
          raycaster.ray.origin,
          hitPoint,
          remote.id,
          isHeadshot,
          this.activeKey
        );
      }

      window.dispatchEvent(new CustomEvent('fps:telemetry_hit', {
        detail: { target: hitTargetName, damage: dealtDamage, headshot: isHeadshot }
      }));

    // 3. Environmental Impact (Sparks / Dust & Bullet Audio)
    } else if (targetHit) {
      this.createImpactSparks(hitPoint, hitNormal);
      if (this.audio?.playBulletImpact) {
        const isMetal = !!(targetHit.object?.userData?.isMetal || targetHit.object?.name?.toLowerCase().includes('metal') || targetHit.object?.name?.toLowerCase().includes('crate'));
        this.audio.playBulletImpact(isMetal);
      }

      if (window.SecureFPSGame?.multiplayer) {
        window.SecureFPSGame.multiplayer.emitFire(
          raycaster.ray.origin,
          hitPoint
        );
      }
    } else {
      if (window.SecureFPSGame?.multiplayer) {
        window.SecureFPSGame.multiplayer.emitFire(
          raycaster.ray.origin,
          hitPoint
        );
      }
    }

    // Telemetry Weapon Fire Notification
    window.dispatchEvent(new CustomEvent('fps:telemetry_fire', {
      detail: { weapon: w.name }
    }));
  }

  getActiveConfig() {
    return this.activeWeapon || (this.weapons && this.weapons[this.activeKey]) || WEAPON_REGISTRY[this.activeKey] || WEAPON_REGISTRY.carbine;
  }

  createTracer(endPoint) {
    if (!endPoint) return;
    const muzzleWorld = new THREE.Vector3();
    if (this.muzzleMesh && typeof this.muzzleMesh.getWorldPosition === 'function') {
      this.muzzleMesh.getWorldPosition(muzzleWorld);
    } else if (this.camera) {
      this.camera.getWorldPosition(muzzleWorld);
      muzzleWorld.y -= 0.15;
    }

    const w = this.getActiveConfig();
    const speed = w?.bulletSpeed || 220;
    const tracerColor = w?.tracerColor || (this.activeKey === 'sniper' ? 0x00f0ff : 0xffb703);
    const tracerLength = w?.tracerLength || 0.6;
    const tracerRadius = w?.tracerRadius || 0.015;

    const totalDistance = muzzleWorld.distanceTo(endPoint);
    if (totalDistance < 0.2) return;

    const direction = endPoint.clone().sub(muzzleWorld).normalize();

    const geo = new THREE.CylinderGeometry(tracerRadius, tracerRadius * 0.6, tracerLength, 6);
    const mat = new THREE.MeshBasicMaterial({
      color: tracerColor,
      transparent: true,
      opacity: 0.95
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    mesh.position.copy(muzzleWorld);
    if (this.scene) this.scene.add(mesh);

    if (!Array.isArray(this.activeTracers)) this.activeTracers = [];
    this.activeTracers.push({
      mesh,
      geo,
      mat,
      startPos: muzzleWorld.clone(),
      endPos: endPoint.clone(),
      direction,
      speed,
      totalDistance,
      traveled: 0
    });
  }

  createImpactSparks(point, normal) {
    if (!Array.isArray(this.impactParticles)) this.impactParticles = [];
    const particleCount = 6;
    for (let i = 0; i < particleCount; i++) {
      const geo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffb703 });
      const p = new THREE.Mesh(geo, mat);
      p.position.copy(point);

      const vel = normal.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 1.5,
        (Math.random() - 0.5) * 1.5,
        (Math.random() - 0.5) * 1.5
      )).normalize().multiplyScalar(4.0 + Math.random() * 4.0);

      this.scene.add(p);
      this.impactParticles.push({ mesh: p, vel: vel, life: 0.25 });
    }
  }

  spawnShellEjection() {
    if (!this.camera || !this.weaponRoot) return;
    if (!Array.isArray(this.shellCasings)) this.shellCasings = [];
    const geo = new THREE.CylinderGeometry(0.007, 0.007, 0.024, 6);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      roughness: 0.3,
      metalness: 0.85
    });
    const shell = new THREE.Mesh(geo, mat);

    const portWorld = new THREE.Vector3();
    this.weaponRoot.getWorldPosition(portWorld);
    portWorld.y += 0.02;
    shell.position.copy(portWorld);

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);

    const velocity = right.multiplyScalar(1.6 + Math.random() * 0.4)
      .add(up.multiplyScalar(1.1 + Math.random() * 0.4))
      .add(back.multiplyScalar(0.4 + Math.random() * 0.3));

    this.scene.add(shell);
    this.shellCasings.push({
      mesh: shell,
      velocity: velocity,
      rotVel: new THREE.Vector3(Math.random() * 18, Math.random() * 18, Math.random() * 18),
      lifetime: 0.6
    });
  }

  updateParticles(delta) {
    if (!delta || isNaN(delta) || delta <= 0) return;

    // Defensively ensure all collections exist as valid arrays
    const tracers = Array.isArray(this.activeTracers) ? this.activeTracers : [];
    this.activeTracers = tracers;

    const shells = Array.isArray(this.shellCasings) ? this.shellCasings : [];
    this.shellCasings = shells;

    const sparks = Array.isArray(this.impactParticles) ? this.impactParticles : [];
    this.impactParticles = sparks;

    // 1. Update physical ballistic projectile tracers
    for (let i = tracers.length - 1; i >= 0; i--) {
      const tr = tracers[i];
      if (!tr || !tr.mesh) {
        tracers.splice(i, 1);
        continue;
      }
      try {
        tr.traveled = (tr.traveled || 0) + (tr.speed || 240) * delta;
        if (tr.traveled >= (tr.totalDistance || 100)) {
          if (this.scene && tr.mesh) this.scene.remove(tr.mesh);
          if (tr.geo && typeof tr.geo.dispose === 'function') tr.geo.dispose();
          if (tr.mat && typeof tr.mat.dispose === 'function') tr.mat.dispose();
          tracers.splice(i, 1);
        } else if (tr.direction && tr.startPos) {
          tr.mesh.position.copy(tr.startPos).addScaledVector(tr.direction, tr.traveled);
        }
      } catch (err) {
        tracers.splice(i, 1);
      }
    }

    // 2. Update spent brass shell casings
    for (let i = shells.length - 1; i >= 0; i--) {
      const casing = shells[i];
      if (!casing || !casing.mesh) {
        shells.splice(i, 1);
        continue;
      }
      try {
        casing.lifetime = (casing.lifetime || 0.6) - delta;
        if (casing.velocity) {
          casing.velocity.y -= 9.8 * delta;
          casing.mesh.position.addScaledVector(casing.velocity, delta);
        }
        if (casing.rotVel) {
          casing.mesh.rotation.x += casing.rotVel.x * delta;
          casing.mesh.rotation.y += casing.rotVel.y * delta;
          casing.mesh.rotation.z += casing.rotVel.z * delta;
        }

        if (casing.lifetime <= 0) {
          if (this.scene && casing.mesh) this.scene.remove(casing.mesh);
          if (casing.mesh.geometry && typeof casing.mesh.geometry.dispose === 'function') {
            casing.mesh.geometry.dispose();
          }
          if (casing.mesh.material && typeof casing.mesh.material.dispose === 'function') {
            casing.mesh.material.dispose();
          }
          shells.splice(i, 1);
        }
      } catch (err) {
        shells.splice(i, 1);
      }
    }

    // 3. Update impact spark particles
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      if (!p || !p.mesh) {
        sparks.splice(i, 1);
        continue;
      }
      try {
        p.life = (p.life || 0.25) - delta;
        if (p.vel) {
          p.mesh.position.addScaledVector(p.vel, delta);
          p.vel.y -= 18.0 * delta; // Gravity
        }

        if (p.life <= 0) {
          if (this.scene && p.mesh) this.scene.remove(p.mesh);
          if (p.mesh.geometry && typeof p.mesh.geometry.dispose === 'function') {
            p.mesh.geometry.dispose();
          }
          if (p.mesh.material && typeof p.mesh.material.dispose === 'function') {
            p.mesh.material.dispose();
          }
          sparks.splice(i, 1);
        }
      } catch (err) {
        sparks.splice(i, 1);
      }
    }
  }

  triggerHitmarkerHUD(isHeadshot) {
    if (!this.hitmarkerEl) return;
    this.hitmarkerEl.classList.remove('active', 'headshot');
    void this.hitmarkerEl.offsetWidth; // Force CSS reflow
    this.hitmarkerEl.classList.add('active');
    if (isHeadshot) this.hitmarkerEl.classList.add('headshot');

    setTimeout(() => {
      if (this.hitmarkerEl) this.hitmarkerEl.classList.remove('active', 'headshot');
    }, 140);
  }

  updateHUD() {
    const w = this.activeWeapon;
    if (this.weaponNameEl) this.weaponNameEl.textContent = w.name;
    if (this.weaponCaliberEl) this.weaponCaliberEl.textContent = w.caliber;
    if (this.ammoClipEl) this.ammoClipEl.textContent = w.magAmmo;
    if (this.ammoReserveEl) this.ammoReserveEl.textContent = `/ ${w.reserveAmmo}`;
  }
}
