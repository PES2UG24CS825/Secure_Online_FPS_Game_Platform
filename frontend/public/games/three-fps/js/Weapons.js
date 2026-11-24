/**
 * SecureFPS: Weapon Viewmodel, Ballistics & Combat Engine
 * Implements 4 complete weapons (P-24 Carbine, Vector-9 SMG, AWM-50 Sniper, G-18 Pistol),
 * weapon switching (keys 1-4, mouse wheel), procedural 3D viewmodels, recoil kick, idle sway,
 * muzzle flash, hitscan raycasting against bots and remote players, bullet tracers, impact sparks,
 * ammunition management, reload cycles, and telemetry integration.
 */

const WEAPON_REGISTRY = (typeof WeaponConfig !== "undefined" && WeaponConfig.WEAPONS) ? WeaponConfig.WEAPONS : {
  carbine: {
    id: 'carbine',
    name: 'P-24 Carbine',
    caliber: '5.56x45mm NATO',
    slot: 1,
    damage: 25,
    headshotMultiplier: 2.0, // 50 Headshot
    fireRate: 0.13, // ~460 RPM
    bulletSpeed: 240, // 240 m/s
    tracerColor: 0xffb703,
    tracerLength: 0.65,
    tracerRadius: 0.016,
    magSize: 30,
    magAmmo: 30,
    reserveAmmo: 180,
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
    fireRate: 0.09, // ~665 RPM
    bulletSpeed: 175, // 175 m/s
    tracerColor: 0xffaa00,
    tracerLength: 0.45,
    tracerRadius: 0.014,
    magSize: 35,
    magAmmo: 35,
    reserveAmmo: 210,
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
    fireRate: 1.25, // Bolt-Action ~48 RPM
    bulletSpeed: 420, // 420 m/s
    tracerColor: 0x00f0ff,
    tracerLength: 1.2,
    tracerRadius: 0.022,
    magSize: 5,
    magAmmo: 5,
    reserveAmmo: 30,
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
    fireRate: 0.18, // Semi-Auto ~330 RPM
    bulletSpeed: 150, // 150 m/s
    tracerColor: 0xffd166,
    tracerLength: 0.35,
    tracerRadius: 0.013,
    magSize: 17,
    magAmmo: 17,
    reserveAmmo: 85,
    reloadDuration: 1.2,
    baseSpread: 0.005,
    recoilKickZ: 0.06,
    recoilKickY: 0.02,
    recoilRotX: 0.10,
    camRecoil: 0.012,
    soundType: 'pistol'
  }
};

function findBlockingSceneryHit(targetCandidate, sceneHits, isUsableHit, isCombatObject) {
  if (!targetCandidate) return null;
  return sceneHits.find(hit =>
    isUsableHit(hit) &&
    !isCombatObject(hit.object) &&
    hit.distance < targetCandidate.distance - 0.01
  ) || null;
}

class WeaponManager {
  constructor(scene, camera, audio) {
    this.scene = scene;
    this.camera = camera;
    this.audio = audio;

    // Active Weapon Inventory
    this.weapons = JSON.parse(JSON.stringify(WEAPON_REGISTRY));
    Object.keys(this.weapons).forEach((k) => {
      const wep = this.weapons[k];
      if (typeof wep.magAmmo !== 'number' || Number.isNaN(wep.magAmmo)) {
        wep.magAmmo = wep.magSize || 30;
      }
      if (typeof wep.reserveAmmo !== 'number' || Number.isNaN(wep.reserveAmmo)) {
        wep.reserveAmmo = (wep.magSize || 30) * 4;
      }
    });
    this.activeKey = 'carbine';
    this.activeWeapon = this.weapons.carbine;

    // Timing & Combat State
    this.lastShotTime = 0;
    this.isReloading = false;
    this.reloadStartTime = 0;
    this.isSwitching = false;
    this.switchTimer = 0;
    this.targetWeaponKey = null;

    // Demonstration Anomaly Multipliers (Phase 3 & 7)
    this.fireRateMultiplier = 1.0;
    this.demoImpossibleHit = false;
    this.demoHighAccuracy = false;

    // Viewmodel Positioning & Animation State
    this.weaponRoot = new THREE.Object3D();
    this.defaultPos = new THREE.Vector3(0.28, -0.25, -0.52);
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
    this.weaponRoot.scale.setScalar(0.88);
    this.camera.add(this.weaponRoot);

    // Common Materials
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0x252a31,
      roughness: 0.35,
      metalness: 0.85
    });

    const polymerMat = new THREE.MeshStandardMaterial({
      color: 0x171a1f,
      roughness: 0.7,
      metalness: 0.2
    });

    const glassMat = new THREE.MeshBasicMaterial({
      color: 0x8fa2a1,
      transparent: true,
      opacity: 0.6
    });

    // 1. Build P-24 Tactical Assault Rifle Viewmodel (Matching Reference Image)
    const carbineGroup = new THREE.Group();
    const tanMagMat = new THREE.MeshStandardMaterial({ color: 0x5f5649, roughness: 0.72, metalness: 0.12 });
    const reticleMat = new THREE.MeshBasicMaterial({ color: 0xb6c4c1 });

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
    const cBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.34, 16), metalMat);
    cBarrel.rotation.x = Math.PI / 2;
    cBarrel.position.set(0, 0.018, -0.34);
    carbineGroup.add(cBarrel);

    const cHandguard = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.058, 0.22), polymerMat);
    cHandguard.position.set(0, 0.018, -0.30);
    carbineGroup.add(cHandguard);

    for (let i = -2; i <= 2; i++) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.006, 0.012), metalMat);
      rib.position.set(0, -0.012, -0.24 + i * 0.038);
      carbineGroup.add(rib);
    }

    // PEQ-15 Laser Box on Top Front Rail
    const cPeq = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.025, 0.075), tanMagMat);
    cPeq.position.set(0, 0.055, -0.26);
    carbineGroup.add(cPeq);

    // Under-barrel Vertical Foregrip
    const cForegrip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.09, 8), polymerMat);
    cForegrip.position.set(0, -0.045, -0.26);
    carbineGroup.add(cForegrip);

    // Tactical Cylindrical Barrel Suppressor / Silencer
    const cSuppressor = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.024, 0.20, 16), metalMat);
    cSuppressor.rotation.x = Math.PI / 2;
    cSuppressor.position.set(0, 0.018, -0.56);
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

    // 2. Build Vector-9 SMG Viewmodel (Realistic Tactical Submachine Gun)
    const smgGroup = new THREE.Group();
    const sReceiver = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.105, 0.30), polymerMat);
    smgGroup.add(sReceiver);

    const sUpperReceiver = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.045, 0.28), metalMat);
    sUpperReceiver.position.set(0, 0.055, -0.01);
    smgGroup.add(sUpperReceiver);

    const sRail = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.012, 0.26), polymerMat);
    sRail.position.set(0, 0.082, -0.01);
    smgGroup.add(sRail);

    // Reflex Micro Sight
    const sOpticBase = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.016, 0.065), polymerMat);
    sOpticBase.position.set(0, 0.095, -0.02);
    smgGroup.add(sOpticBase);

    const sOpticHood = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.040, 0.06), polymerMat);
    sOpticHood.position.set(0, 0.118, -0.02);
    smgGroup.add(sOpticHood);

    const sOpticLens = new THREE.Mesh(new THREE.CircleGeometry(0.016, 12), glassMat);
    sOpticLens.position.set(0, 0.118, 0.01);
    smgGroup.add(sOpticLens);

    // Threaded barrel & muzzle compensator
    const sBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.16, 12), metalMat);
    sBarrel.rotation.x = Math.PI / 2;
    sBarrel.position.set(0, 0.045, -0.21);
    smgGroup.add(sBarrel);

    const sComp = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.06, 10), metalMat);
    sComp.rotation.x = Math.PI / 2;
    sComp.position.set(0, 0.045, -0.28);
    smgGroup.add(sComp);

    // Angled tactical foregrip
    const sForegrip = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.075, 0.040), polymerMat);
    sForegrip.position.set(0, -0.05, -0.16);
    sForegrip.rotation.x = 0.25;
    smgGroup.add(sForegrip);

    // Curved tactical magazine
    const sMag = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.22, 0.052), tanMagMat);
    sMag.position.set(0, -0.11, -0.04);
    sMag.rotation.x = 0.22;
    smgGroup.add(sMag);

    // Textured pistol grip
    const sGrip = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.13, 0.052), polymerMat);
    sGrip.position.set(0, -0.07, 0.09);
    sGrip.rotation.x = 0.32;
    smgGroup.add(sGrip);

    // Folding tactical stock
    const sStock = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.08, 0.18), polymerMat);
    sStock.position.set(0, 0.03, 0.22);
    smgGroup.add(sStock);

    smgGroup.visible = false;
    this.viewmodelMeshes.smg = smgGroup;
    this.weaponRoot.add(smgGroup);

    // 3. Build AWM-50 Recon Sniper Viewmodel (Precision Tactical Long Rifle)
    const sniperGroup = new THREE.Group();
    const snReceiver = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.095, 0.44), metalMat);
    sniperGroup.add(snReceiver);

    // Heavy fluted precision barrel
    const snBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.015, 0.62, 14), metalMat);
    snBarrel.rotation.x = Math.PI / 2;
    snBarrel.position.set(0, 0.025, -0.53);
    sniperGroup.add(snBarrel);

    // Large ported tactical muzzle brake
    const snBrake = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.044, 0.09), metalMat);
    snBrake.position.set(0, 0.025, -0.87);
    sniperGroup.add(snBrake);

    // Ergonomic sniper chassis stock with adjustable cheekpad
    const snStock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.13, 0.32), polymerMat);
    snStock.position.set(0, -0.02, 0.36);
    sniperGroup.add(snStock);

    const snCheek = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.035, 0.14), tanMagMat);
    snCheek.position.set(0, 0.065, 0.34);
    sniperGroup.add(snCheek);

    // Bolt-action handle
    const snBoltHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.08, 8), metalMat);
    snBoltHandle.rotation.z = Math.PI / 3;
    snBoltHandle.position.set(0.055, 0.04, 0.08);
    sniperGroup.add(snBoltHandle);

    const snBoltKnob = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 8), metalMat);
    snBoltKnob.position.set(0.085, 0.06, 0.08);
    sniperGroup.add(snBoltKnob);

    // High-Power Variable Telescopic Sniper Scope
    const snScopeTube = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.022, 0.30, 16), metalMat);
    snScopeTube.rotation.x = Math.PI / 2;
    snScopeTube.position.set(0, 0.095, -0.08);
    sniperGroup.add(snScopeTube);

    // Scope turrets (windage & elevation)
    const snElevTurret = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.022, 10), polymerMat);
    snElevTurret.position.set(0, 0.125, -0.08);
    sniperGroup.add(snElevTurret);

    const snWindTurret = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.022, 10), polymerMat);
    snWindTurret.rotation.z = Math.PI / 2;
    snWindTurret.position.set(0.030, 0.095, -0.08);
    sniperGroup.add(snWindTurret);

    const snScopeLens = new THREE.Mesh(new THREE.CircleGeometry(0.023, 16), glassMat);
    snScopeLens.position.set(0, 0.095, 0.07);
    sniperGroup.add(snScopeLens);

    // Folded tactical bipod legs
    const bipodMount = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.025, 0.04), polymerMat);
    bipodMount.position.set(0, -0.01, -0.40);
    sniperGroup.add(bipodMount);

    const bipodLegL = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.005, 0.20, 6), metalMat);
    bipodLegL.rotation.x = -Math.PI / 2 + 0.15;
    bipodLegL.position.set(-0.025, -0.02, -0.30);
    sniperGroup.add(bipodLegL);

    const bipodLegR = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.005, 0.20, 6), metalMat);
    bipodLegR.rotation.x = -Math.PI / 2 + 0.15;
    bipodLegR.position.set(0.025, -0.02, -0.30);
    sniperGroup.add(bipodLegR);

    // Detachable box magazine
    const snMag = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.13, 0.075), tanMagMat);
    snMag.position.set(0, -0.08, -0.05);
    sniperGroup.add(snMag);

    sniperGroup.visible = false;
    this.viewmodelMeshes.sniper = sniperGroup;
    this.weaponRoot.add(sniperGroup);

    // 4. Build G-18 Tactical Pistol Viewmodel (Military Combat Handgun)
    const pistolGroup = new THREE.Group();
    // Beveled Gunmetal Slide with cocking serrations
    const pSlide = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.048, 0.22), metalMat);
    pSlide.position.set(0, 0.022, -0.04);
    pistolGroup.add(pSlide);

    // Ejection port cutout
    const pPort = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.016, 0.045), polymerMat);
    pPort.position.set(0.015, 0.036, -0.03);
    pistolGroup.add(pPort);

    // Front blade sight & rear combat notch sight
    const pFrontSight = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.012, 0.012), polymerMat);
    pFrontSight.position.set(0, 0.050, -0.13);
    pistolGroup.add(pFrontSight);

    const pRearSight = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.014, 0.012), polymerMat);
    pRearSight.position.set(0, 0.050, 0.05);
    pistolGroup.add(pRearSight);

    // Polymer ergonomic frame with underbarrel Picatinny rail
    const pFrame = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.042, 0.20), polymerMat);
    pFrame.position.set(0, -0.012, -0.04);
    pistolGroup.add(pFrame);

    // Compact underbarrel laser/tactical light unit
    const pLight = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.026, 0.065), polymerMat);
    pLight.position.set(0, -0.042, -0.09);
    pistolGroup.add(pLight);

    // Trigger guard & curved metal trigger
    const pTriggerGuard = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.004, 6, 12, Math.PI), polymerMat);
    pTriggerGuard.position.set(0, -0.045, -0.01);
    pTriggerGuard.rotation.y = Math.PI / 2;
    pistolGroup.add(pTriggerGuard);

    const pTrigger = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.020, 0.008), metalMat);
    pTrigger.position.set(0, -0.035, -0.01);
    pTrigger.rotation.x = -0.2;
    pistolGroup.add(pTrigger);

    // Stippled pistol combat grip
    const pGrip = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.13, 0.055), polymerMat);
    pGrip.position.set(0, -0.075, 0.045);
    pGrip.rotation.x = 0.32;
    pistolGroup.add(pGrip);

    // Extended magazine bumper baseplate
    const pMagBase = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.018, 0.060), tanMagMat);
    pMagBase.position.set(0, -0.142, 0.068);
    pMagBase.rotation.x = 0.32;
    pistolGroup.add(pMagBase);

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
    const lForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.068, 0.42, 16), sleeveMat);
    lForearm.rotation.set(0.65, 0.35, -0.65);
    lForearm.position.set(-0.22, -0.18, -0.14);
    handsGroup.add(lForearm);

    // Stitched sleeve cuff
    const lCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.048, 0.04, 10), sleeveMat);
    lCuff.rotation.set(0.65, 0.35, -0.65);
    lCuff.position.set(-0.13, -0.10, -0.19);
    handsGroup.add(lCuff);

    // Left tactical glove body
    const lGlove = new THREE.Mesh(new THREE.SphereGeometry(0.070, 16, 10), gloveMat);
    lGlove.scale.set(0.82, 0.72, 1.18);
    lGlove.position.set(-0.09, -0.055, -0.26);
    lGlove.rotation.set(0.25, 0.50, -0.30);
    handsGroup.add(lGlove);

    // Molded composite hard-knuckle armor guard on left glove
    const lKnuckles = new THREE.Mesh(new THREE.SphereGeometry(0.042, 12, 8), knuckleMat);
    lKnuckles.scale.set(1.15, 0.42, 0.72);
    lKnuckles.position.set(-0.075, -0.025, -0.29);
    lKnuckles.rotation.set(0.25, 0.50, -0.30);
    handsGroup.add(lKnuckles);

    // Left thumb supporting grip
    const lThumb = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.045, 0.024), gloveMat);
    lThumb.position.set(-0.05, -0.035, -0.22);
    lThumb.rotation.set(0.3, 0.1, -0.4);
    handsGroup.add(lThumb);

    // --- Right Arm & Hand (Gripping pistol grip & trigger from right) ---
    const rForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.068, 0.42, 16), sleeveMat);
    rForearm.rotation.set(0.75, -0.30, 0.45);
    rForearm.position.set(0.17, -0.20, 0.12);
    handsGroup.add(rForearm);

    // Stitched sleeve cuff
    const rCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.048, 0.04, 10), sleeveMat);
    rCuff.rotation.set(0.75, -0.30, 0.45);
    rCuff.position.set(0.09, -0.13, 0.11);
    handsGroup.add(rCuff);

    // Right tactical glove body
    const rGlove = new THREE.Mesh(new THREE.SphereGeometry(0.068, 16, 10), gloveMat);
    rGlove.scale.set(0.82, 0.72, 1.12);
    rGlove.position.set(0.025, -0.072, 0.085);
    rGlove.rotation.set(0.35, -0.10, 0.20);
    handsGroup.add(rGlove);

    // Molded composite hard-knuckle armor guard on right glove
    const rKnuckles = new THREE.Mesh(new THREE.SphereGeometry(0.040, 12, 8), knuckleMat);
    rKnuckles.scale.set(1.15, 0.42, 0.72);
    rKnuckles.position.set(0.028, -0.048, 0.078);
    rKnuckles.rotation.set(0.35, -0.10, 0.20);
    handsGroup.add(rKnuckles);

    // Right index trigger finger
    const rTriggerFinger = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.048), gloveMat);
    rTriggerFinger.position.set(-0.01, -0.045, 0.06);
    rTriggerFinger.rotation.set(0.1, 0.2, 0.3);
    handsGroup.add(rTriggerFinger);

    for (let finger = 0; finger < 4; finger++) {
      const lFinger = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.045, 8), gloveMat);
      lFinger.rotation.x = Math.PI / 2;
      lFinger.position.set(-0.125 + finger * 0.012, -0.052, -0.275);
      handsGroup.add(lFinger);

      const rFinger = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.040, 8), gloveMat);
      rFinger.rotation.x = Math.PI / 2;
      rFinger.position.set(-0.010 + finger * 0.012, -0.055, 0.095);
      handsGroup.add(rFinger);
    }

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

    // Mouse / Pointer Trigger Press & ADS
    const handleTriggerDown = (e) => {
      if (
        e.target &&
        e.target.closest &&
        e.target.closest(
          "button, input, select, textarea, a, .game-modal-overlay, .hud-modal-overlay, #pause-overlay, #loading-overlay, #main-menu-hub, .mc-actions-row, .modal-card, .pause-card, .hud-btn"
        )
      ) {
        return;
      }

      if (e.button === 0) {
        if (!this.isPlayerAlive()) {
          this.isFiring = false;
          return;
        }
        this.isFiring = true;
        // Immediate shot trigger on click
        const isLocked = !!(this.controller?.isLocked || document.pointerLockElement);
        const inGame = !window.SecureFPSGame?.isMenuOpen && !window.SecureFPSGame?.isPaused;
        if (!this.isReloading && !this.isSwitching && (isLocked || inGame)) {
          const now = performance.now() / 1000;
          const w = this.activeWeapon;
          const effectiveFireRate = w.fireRate / (this.fireRateMultiplier || 1.0);
          if (now - this.lastShotTime >= effectiveFireRate) {
            if (w.magAmmo > 0) {
              this.fire(this.controller, this.botManager);
              this.lastShotTime = now;
            } else {
              if (this.audio) this.audio.playEmptyClick();
              this.lastShotTime = now;
              this.reload();
            }
          }
        }
      }
      if (e.button === 2) {
        e.preventDefault();
        this.isAiming = true;
      }
    };

    const handleTriggerUp = (e) => {
      if (e.button === 0) this.isFiring = false;
      if (e.button === 2) {
        e.preventDefault();
        this.isAiming = false;
      }
    };

    window.addEventListener('mousedown', handleTriggerDown);
    window.addEventListener('mouseup', handleTriggerUp);

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

  resetForMatch() {
    Object.keys(this.weapons).forEach(key => {
      const starting = WEAPON_REGISTRY[key];
      this.weapons[key].magAmmo = starting.magAmmo ?? starting.magSize;
      this.weapons[key].reserveAmmo = starting.reserveAmmo ?? starting.magSize * 4;
    });
    this.isFiring = false;
    this.isReloading = false;
    this.isSwitching = false;
    this.targetWeaponKey = null;
    this.lastShotTime = 0;
    this.isAiming = false;
    this.currentAimAlpha = 0;
    this.updateHUD();
  }

  update(delta, controller, botManager) {
    if (controller) this.controller = controller;
    if (botManager) this.botManager = botManager;
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
    if (!this.isPlayerAlive()) {
      this.isFiring = false;
    }
    const isLocked = !!(controller?.isLocked || this.controller?.isLocked || document.pointerLockElement);
    const inGame = !window.SecureFPSGame?.isMenuOpen && !window.SecureFPSGame?.isPaused;
    if (this.isFiring && this.isPlayerAlive() && !this.isReloading && !this.isSwitching && (isLocked || inGame)) {
      const effectiveFireRate = w.fireRate / (this.fireRateMultiplier || 1.0);
      if (now - this.lastShotTime >= effectiveFireRate) {
        if (w.magAmmo > 0) {
          this.fire(controller || this.controller, botManager || this.botManager);
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

  isPlayerAlive() {
    if (window.SecureFPSGame?.gameMode?.isDead) return false;
    if (window.SecureFPSGame?.gameMode?.isMatchCompleted) return false;
    if (this.controller && (this.controller.isDead || this.controller.health <= 0)) return false;
    return true;
  }

  fire(controller, botManager) {
    const gameMode = window.SecureFPSGame?.gameMode;
    if (gameMode?.isLocalSimulationPaused?.()) {
      this.isFiring = false;
      return;
    }
    if (!this.isPlayerAlive()) {
      this.isFiring = false;
      return;
    }
    const w = this.activeWeapon;
    w.magAmmo--;
    this.shotsFired = (this.shotsFired || 0) + 1;
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

    const camPos = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);

    if (window.SecureFPSGame?.gameMode?.hasSpawnProtection) {
      window.SecureFPSGame.gameMode.hasSpawnProtection = false;
      window.SecureFPSGame.gameMode.spawnProtectionTimer = 0;
      window.SecureFPSGame.gameMode.updateSpawnProtectionHUD?.();
    }

    // Alert nearby tactical AI bots to audible gunfire
    if (botManager && typeof botManager.notifyGunshot === 'function' && !w.isSilenced) {
      const playerPos = controller?.position || camPos;
      botManager.notifyGunshot(playerPos);
    }

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
    if (this.demoHighAccuracy) {
      spread = 0.0;
    } else if (controller) {
      if (!controller.isGrounded) spread *= 3.0;
      else if (controller.isSprinting) spread *= 2.2;
      else if (controller.isCrouching) spread *= 0.6;
    }

    const spreadX = (Math.random() - 0.5) * spread;
    const spreadY = (Math.random() - 0.5) * spread;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(spreadX, spreadY), this.camera);

    // Test target hitboxes separately, then compare them with scene scenery.
    const hitboxMeshes = [];
    if (botManager?.getHitboxMeshes) hitboxMeshes.push(...botManager.getHitboxMeshes());
    if (window.SecureFPSGame?.multiplayer?.getHitboxMeshes) {
      hitboxMeshes.push(...window.SecureFPSGame.multiplayer.getHitboxMeshes());
    }
    if (window.SecureFPSGame?.trainingManager?.getHitboxMeshes) {
      hitboxMeshes.push(...window.SecureFPSGame.trainingManager.getHitboxMeshes());
    }
    raycaster.setFromCamera(new THREE.Vector2(spreadX, spreadY), this.camera);
    const hitboxHits = hitboxMeshes.length ? raycaster.intersectObjects(hitboxMeshes, false) : [];

    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);

    const isCombatObject = (object) => {
      let current = object;
      while (current) {
        const data = current.userData || {};
        if (data.bot || data.remotePlayer || data.target || data.operator?.bot || data.operator?.remotePlayer) {
          return true;
        }
        current = current.parent;
      }
      return false;
    };
    const isUsableHit = (hit) => {
      if (hit.object === this.muzzleMesh || this.weaponRoot.getObjectById(hit.object.id)) {
        return false;
      }
      if (hit.object.userData?.isFX || hit.object.userData?.isUI || hit.object.isSprite || hit.object.type === 'Sprite') {
        return false;
      }
      if (hit.distance < 0.35) return false;
      const toHit = hit.point.clone().sub(camPos).normalize();
      return camDir.dot(toHit) >= 0.1;
    };
    const sceneHits = raycaster.intersectObjects(this.scene.children, true);
    const headCandidate = hitboxHits.find(h => isUsableHit(h) && (h.object.userData?.isHead || h.object.userData?.isHeadshot || h.object.name === 'head' || h.object.parent?.userData?.isHead));
    const anyCandidate = hitboxHits.find(isUsableHit) || null;
    const targetCandidate = headCandidate || anyCandidate;
    const sceneryHits = sceneHits.filter(hit => isUsableHit(hit) && !isCombatObject(hit.object));
    const blocker = findBlockingSceneryHit(targetCandidate, sceneHits, isUsableHit, isCombatObject);
    let targetHit = blocker || targetCandidate || sceneryHits[0] || null;

    let isImpossibleHit = false;
    let hitThroughObstacle = false;
    let hitDist = targetCandidate ? targetCandidate.distance : 10.0;

    // Cheater Demonstration Overrides (Phases 3 & 7)
    // When cheater demo player fires: 100% headshot on registered hits and optional wall penetration
    const isCheaterDemo = Boolean(
      this.demoHighAccuracy ||
      this.demoImpossibleHit ||
      window.SecureFPSGame?.isCheaterDemoActive ||
      window.isDemoGodModeActive
    );

    if (isCheaterDemo) {
      w.reserveAmmo = 999;
      if (w.magAmmo <= 1) w.magAmmo = w.magSize || 30;
    }

    const effectiveBotManager = botManager || this.botManager || window.SecureFPSGame?.botManager;
    let bestBot = null;
    const canWallPenetrate = Boolean(isCheaterDemo && this.demoImpossibleHit);

    if (targetCandidate) {
      if (blocker) {
        if (canWallPenetrate) {
          // Wall Penetration active: shot penetrates solid obstacle to hit the target
          targetHit = targetCandidate;
          hitThroughObstacle = true;
          isImpossibleHit = true;
          hitDist = targetCandidate.distance;
        } else {
          // Wall blocks bullet normally
          targetHit = blocker;
          hitThroughObstacle = false;
          isImpossibleHit = false;
        }
      } else {
        // Direct line of sight hit on target
        targetHit = targetCandidate;
        hitThroughObstacle = false;
        isImpossibleHit = false;
        hitDist = targetCandidate.distance;
      }
    } else if (isCheaterDemo && this.demoHighAccuracy && effectiveBotManager?.bots) {
      // High Accuracy Aim Assist: locks only if bot is in front within forward aim cone (~35 degrees)
      let bestScore = -Infinity;

      for (const bot of effectiveBotManager.bots) {
        if (!bot.isActive || bot.isDead) continue;
        const botPos = bot.position || (bot.mesh && bot.mesh.position) || bot.operator?.root?.position;
        if (!botPos) continue;

        const toBot = botPos.clone().sub(camPos);
        const dist = toBot.length();
        const dir = toBot.normalize();
        const dot = camDir.dot(dir);

        // Target must be in front within forward cone
        if (dot >= 0.82) {
          const score = dot * 100.0 - dist * 0.15;
          if (score > bestScore) {
            bestScore = score;
            bestBot = bot;
          }
        }
      }

      if (bestBot) {
        const botPos = bestBot.position || (bestBot.mesh && bestBot.mesh.position) || bestBot.operator?.root?.position;
        const headTarget = bestBot.operator?.headMesh || bestBot.headMesh || bestBot.mesh || (bestBot.operator && bestBot.operator.root);
        const headPos = botPos.clone().add(new THREE.Vector3(0, 1.65, 0));
        const dist = camPos.distanceTo(headPos);

        targetHit = {
          object: headTarget,
          point: headPos,
          distance: canWallPenetrate ? Math.max(105.0, dist) : dist,
          face: { normal: new THREE.Vector3(0, 0, 1) }
        };
        if (targetHit.object) {
          if (!targetHit.object.userData) targetHit.object.userData = {};
          targetHit.object.userData.bot = bestBot;
          targetHit.object.userData.isHead = true;
          targetHit.object.userData.isHeadshot = true;
        }
        hitDist = targetHit.distance;

        if (canWallPenetrate) {
          hitThroughObstacle = true;
          isImpossibleHit = true;
        }
      }
    }
    let hitPoint = new THREE.Vector3();
    let hitNormal = new THREE.Vector3(0, 1, 0);
    if (targetHit) {
      hitPoint.copy(targetHit.point);
      if (targetHit.face) hitNormal.copy(targetHit.face.normal);
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
      let isHead = !!(obj?.userData?.isHead || obj?.userData?.isHeadshot || obj?.name === 'head');
      let foundBot = null;
      let foundRemote = null;
      let foundTarget = null;

      while (curr) {
        if (curr.userData) {
          if (curr.userData.isHead || curr.userData.isHeadshot) isHead = true;
          if (curr.userData.bot) {
            foundBot = curr.userData.bot;
            break;
          }
          if (curr.userData.remotePlayer) {
            foundRemote = curr.userData.remotePlayer;
            break;
          }
          if (curr.userData.target) {
            foundTarget = curr.userData.target;
            break;
          }
          if (curr.userData.operator?.bot) {
            foundBot = curr.userData.operator.bot;
            break;
          }
          if (curr.userData.operator?.remotePlayer) {
            foundRemote = curr.userData.operator.remotePlayer;
            break;
          }
        }
        if (curr.name === 'head' || curr.name === 'Head') isHead = true;
        curr = curr.parent;
      }

      if (foundBot) return { type: 'bot', bot: foundBot, isHead };
      if (foundRemote) return { type: 'remote', remote: foundRemote, isHead };
      if (foundTarget) return { type: 'target', target: foundTarget, isHead };
      return null;
    };

    const canPenetrate = Boolean(this.demoImpossibleHit || (isCheaterDemo && hitThroughObstacle));
    let resolved = null;
    if (isCheaterDemo && bestBot) {
      resolved = { type: 'bot', bot: bestBot, isHead: true };
    } else if (targetHit && (!blocker || canPenetrate)) {
      resolved = resolveCombatTarget(targetHit.object);
    }
    const isMultiplayer = Boolean(window.SecureFPSGame?.multiplayer?.isInRoom);

    // 1. Check Bot Hit
    if (resolved && resolved.type === 'bot') {
      const bot = resolved.bot;
      if (isCheaterDemo) {
        bot.spawnProtectionTimer = 0;
      }
      const botPos = bot.position || (bot.mesh && bot.mesh.position) || bot.operator?.root?.position;
      const relY = botPos ? (hitPoint.y - botPos.y) : 0;
      isHeadshot = Boolean(
        resolved.isHead ||
        (relY >= 1.35) ||
        isCheaterDemo
      );
      // Cheater demo player deals lethal headshot damage on hit
      const baseDmg = isHeadshot ? w.damage * (w.headshotMultiplier || 2.0) : w.damage;
      const dealtDamage = isCheaterDemo ? Math.max(100, Math.round(baseDmg)) : Math.round(baseDmg);

      this.shotsHit = (this.shotsHit || 0) + 1;
      if (isHeadshot) {
        this.headshots = (this.headshots || 0) + 1;
      }
      if (window.SecureFPSGame?.gameMode) {
        window.SecureFPSGame.gameMode.shotsHit = (window.SecureFPSGame.gameMode.shotsHit || 0) + 1;
        if (isHeadshot) {
          window.SecureFPSGame.gameMode.headshots = (window.SecureFPSGame.gameMode.headshots || 0) + 1;
        }
      }
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
        detail: {
          target: hitTargetName,
          damage: dealtDamage,
          headshot: isHeadshot,
          distance: parseFloat((hitDist || 10.0).toFixed(1)),
          visible_through_wall: hitThroughObstacle,
          through_obstacle: hitThroughObstacle,
          impossible_hit: isImpossibleHit,
          line_of_sight: !hitThroughObstacle,
          player_position: { x: parseFloat(camPos.x.toFixed(2)), y: parseFloat(camPos.y.toFixed(2)), z: parseFloat(camPos.z.toFixed(2)) },
          target_position: { x: parseFloat(hitPoint.x.toFixed(2)), y: parseFloat(hitPoint.y.toFixed(2)), z: parseFloat(hitPoint.z.toFixed(2)) }
        }
      }));

      window.dispatchEvent(new CustomEvent('fps:telemetry_hit_detail', {
        detail: {
          target_id: hitTargetName,
          body_part: isHeadshot ? 'head' : 'body',
          distance: parseFloat((hitDist || 10.0).toFixed(1)),
          damage: dealtDamage
        }
      }));

    // Check Training Target Hit
    } else if (resolved && resolved.type === 'target') {
      if (window.SecureFPSGame?.trainingManager) {
        window.SecureFPSGame.trainingManager.handleBulletHit(targetHit.object);
      }
      this.triggerHitmarkerHUD(resolved.isHead);

    // 2. Check Remote Player Hit (Multiplayer)
    } else if (resolved && resolved.type === 'remote') {
      // Multiplayer hit indicators and combat statistics wait for server confirmation.

    // 3. Environmental Impact (Sparks / Dust & Bullet Audio)
    } else if (targetHit) {
      this.createImpactSparks(hitPoint, hitNormal);
      if (this.audio?.playBulletImpact) {
        const isMetal = !!(targetHit.object?.userData?.isMetal || targetHit.object?.name?.toLowerCase().includes('metal') || targetHit.object?.name?.toLowerCase().includes('crate'));
        this.audio.playBulletImpact(isMetal);
      }

    }

    if (isMultiplayer) {
      window.SecureFPSGame.multiplayer.emitFire(raycaster.ray.origin, raycaster.ray.direction, this.activeKey);
    } else {
      if (window.SecureFPSGame?.gameMode) {
        window.SecureFPSGame.gameMode.shotsFired = Math.max(window.SecureFPSGame.gameMode.shotsFired || 0, this.shotsFired || 0);
      }
      window.dispatchEvent(new CustomEvent('fps:telemetry_fire', {
        detail: { weapon: w.name, shot_id: `shot_${Date.now()}_${Math.random().toString(36).substring(2, 7)}` }
      }));
    }
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
    mesh.userData.isFX = true;
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
      p.userData.isFX = true;
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
    shell.userData.isFX = true;

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
    const w = this.activeWeapon || (this.weapons && this.weapons[this.activeKey]) || WEAPON_REGISTRY[this.activeKey] || WEAPON_REGISTRY.carbine;
    if (!w) return;
    const magSize = Number(w.magSize) || 30;
    const clip = (typeof w.magAmmo === 'number' && !Number.isNaN(w.magAmmo)) ? Math.max(0, Math.floor(w.magAmmo)) : magSize;
    const reserve = (typeof w.reserveAmmo === 'number' && !Number.isNaN(w.reserveAmmo)) ? Math.max(0, Math.floor(w.reserveAmmo)) : (magSize * 4);
    if (this.weaponNameEl) this.weaponNameEl.textContent = w.name || "P-24 Carbine";
    if (this.weaponCaliberEl) this.weaponCaliberEl.textContent = w.caliber || "5.56x45mm NATO";
    if (this.ammoClipEl) this.ammoClipEl.textContent = clip;
    if (this.ammoReserveEl) this.ammoReserveEl.textContent = `/ ${reserve}`;
  }
}
