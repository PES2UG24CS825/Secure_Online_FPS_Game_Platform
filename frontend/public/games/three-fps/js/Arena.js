/**
 * SecureFPS: Tactical Training Arena Builder
 * Constructs a competitive 3D FPS arena with central combat courtyard,
 * indoor CQB warehouse, covered shooting pavilion, elevated catwalks,
 * accessible ramps, and high-precision physical collision bounds.
 */
class Arena {
  constructor(scene) {
    this.scene = scene;
    this.colliders = []; // Physical bounding volumes for collision detection
    this.spawnPoints = [
      new THREE.Vector3(0, 1.8, 30),      // South spawn
      new THREE.Vector3(-28, 1.8, 0),     // West lane
      new THREE.Vector3(28, 1.8, 14),      // East lane
      new THREE.Vector3(0, 1.8, -30),     // North lane
      new THREE.Vector3(0, 4.0, 0),       // Central platform
      new THREE.Vector3(-25, 1.8, -22),   // Warehouse interior
      new THREE.Vector3(25, 4.2, -22)     // Sniper catwalk
    ];

    this.materials = {};
    this.initMaterials();
    this.build();
  }

  initMaterials() {
    // High-visibility Tactical Floor Material
    const floorTexture = TextureGenerator.createFloorTexture(512);
    floorTexture.repeat.set(16, 16);
    this.materials.floor = new THREE.MeshStandardMaterial({
      map: floorTexture,
      roughness: 0.55,
      metalness: 0.25
    });

    // Outer Terrain Skirt Material (prevents any void gap)
    this.materials.terrain = new THREE.MeshStandardMaterial({
      color: 0x1e2736,
      roughness: 0.85,
      metalness: 0.15
    });

    // Wall Material
    const wallTexture = TextureGenerator.createWallTexture(512);
    wallTexture.repeat.set(4, 2);
    this.materials.wall = new THREE.MeshStandardMaterial({
      map: wallTexture,
      roughness: 0.5,
      metalness: 0.35
    });

    // Platform Top Material
    const platformTexture = TextureGenerator.createFloorTexture(512);
    platformTexture.repeat.set(4, 4);
    this.materials.platform = new THREE.MeshStandardMaterial({
      map: platformTexture,
      roughness: 0.5,
      metalness: 0.3
    });

    // Hazard Trim Material
    const hazardTexture = TextureGenerator.createHazardTexture(256);
    hazardTexture.repeat.set(10, 1);
    this.materials.hazard = new THREE.MeshStandardMaterial({
      map: hazardTexture,
      roughness: 0.45,
      metalness: 0.2
    });

    // Tactical Containers
    this.materials.crateCyan = new THREE.MeshStandardMaterial({
      color: 0x1e3a5f,
      roughness: 0.4,
      metalness: 0.6
    });

    this.materials.crateRed = new THREE.MeshStandardMaterial({
      color: 0x6b213b,
      roughness: 0.4,
      metalness: 0.6
    });

    this.materials.barrier = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.7,
      metalness: 0.2
    });

    // Roof & Ceiling Material
    this.materials.ceiling = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.8,
      metalness: 0.2,
      side: THREE.DoubleSide
    });

    // Emissive Accent Materials
    this.materials.glowCyan = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
    this.materials.glowAmber = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
    this.materials.glowRed = new THREE.MeshBasicMaterial({ color: 0xff0055 });

    // Target Material
    this.materials.target = new THREE.MeshBasicMaterial({
      map: TextureGenerator.createTargetTexture(256)
    });
  }

  build() {
    this.buildGroundAndPerimeter();
    this.buildCentralCompound();
    this.buildCoverBarriers();
    this.buildShootingRange();
    this.buildWarehouseBuilding();
    this.buildParkourCourse();
    this.buildDecorations();
  }

  /**
   * Main arena floor (80m x 80m) + expanded terrain skirt (280m x 280m)
   */
  buildGroundAndPerimeter() {
    // 1. Expanded outer terrain skirt (prevents black void from any viewing angle)
    const terrainGeo = new THREE.PlaneGeometry(280, 280);
    const terrainMesh = new THREE.Mesh(terrainGeo, this.materials.terrain);
    terrainMesh.rotation.x = -Math.PI / 2;
    terrainMesh.position.y = -0.05;
    terrainMesh.receiveShadow = true;
    this.scene.add(terrainMesh);

    // 2. High-contrast main tactical arena floor
    const floorGeo = new THREE.PlaneGeometry(80, 80);
    const floorMesh = new THREE.Mesh(floorGeo, this.materials.floor);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = 0;
    floorMesh.receiveShadow = true;
    this.scene.add(floorMesh);

    // 3. Perimeter walls (80m x 80m x 8m tall)
    const wallHeight = 8;
    const wallThickness = 2;
    const arenaSize = 80;

    const wallsData = [
      { x: 0, y: wallHeight / 2, z: -arenaSize / 2, w: arenaSize, h: wallHeight, d: wallThickness },
      { x: 0, y: wallHeight / 2, z: arenaSize / 2, w: arenaSize, h: wallHeight, d: wallThickness },
      { x: arenaSize / 2, y: wallHeight / 2, z: 0, w: wallThickness, h: wallHeight, d: arenaSize },
      { x: -arenaSize / 2, y: wallHeight / 2, z: 0, w: wallThickness, h: wallHeight, d: arenaSize }
    ];

    wallsData.forEach(data => {
      const geo = new THREE.BoxGeometry(data.w, data.h, data.d);
      const wall = new THREE.Mesh(geo, this.materials.wall);
      wall.position.set(data.x, data.y, data.z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.scene.add(wall);
      this.addBoxCollider(data.x, data.y, data.z, data.w, data.h, data.d);

      // Glowing neon runner strip near top of perimeter walls
      const isZAxis = data.w > data.d;
      const stripGeo = new THREE.BoxGeometry(isZAxis ? data.w : 0.35, 0.25, isZAxis ? 0.35 : data.d);
      const strip = new THREE.Mesh(stripGeo, this.materials.glowCyan);
      strip.position.set(data.x, wallHeight - 1.2, data.z);
      this.scene.add(strip);
    });
  }

  /**
   * Central elevated tactical compound (16m x 16m x 2.0m) with sloped ramps
   */
  buildCentralCompound() {
    const platformW = 16;
    const platformD = 16;
    const platformH = 2.0;

    // Platform Base
    const platGeo = new THREE.BoxGeometry(platformW, platformH, platformD);
    const platform = new THREE.Mesh(platGeo, this.materials.platform);
    platform.position.set(0, platformH / 2, 0);
    platform.receiveShadow = true;
    platform.castShadow = true;
    this.scene.add(platform);
    this.addBoxCollider(0, platformH / 2, 0, platformW, platformH, platformD);

    // Hazard edge trim around top of platform
    const trimGeo = new THREE.BoxGeometry(platformW + 0.2, 0.15, platformD + 0.2);
    const trim = new THREE.Mesh(trimGeo, this.materials.hazard);
    trim.position.set(0, platformH + 0.05, 0);
    this.scene.add(trim);

    // Central high-tech tower spire
    const spireBaseGeo = new THREE.CylinderGeometry(2, 2.4, 4, 8);
    const spireBase = new THREE.Mesh(spireBaseGeo, this.materials.wall);
    spireBase.position.set(0, platformH + 2, 0);
    spireBase.castShadow = true;
    spireBase.receiveShadow = true;
    this.scene.add(spireBase);
    this.addBoxCollider(0, platformH + 2, 0, 4, 4, 4);

    // North Ramp
    this.buildRamp(0, -platformD / 2 - 3, 5, 6, platformH, 'north');
    // South Ramp
    this.buildRamp(0, platformD / 2 + 3, 5, 6, platformH, 'south');

    // Railings on East & West sides of platform
    const parapetGeo = new THREE.BoxGeometry(0.5, 1.1, platformD);
    const westParapet = new THREE.Mesh(parapetGeo, this.materials.barrier);
    westParapet.position.set(-platformW / 2 + 0.25, platformH + 0.55, 0);
    westParapet.castShadow = true;
    this.scene.add(westParapet);
    this.addBoxCollider(-platformW / 2 + 0.25, platformH + 0.55, 0, 0.5, 1.1, platformD);

    const eastParapet = new THREE.Mesh(parapetGeo, this.materials.barrier);
    eastParapet.position.set(platformW / 2 - 0.25, platformH + 0.55, 0);
    eastParapet.castShadow = true;
    this.scene.add(eastParapet);
    this.addBoxCollider(platformW / 2 - 0.25, platformH + 0.55, 0, 0.5, 1.1, platformD);
  }

  /**
   * Constructs an accessible physical ramp with sloped mesh and collider
   */
  buildRamp(cx, cz, width, length, height, direction) {
    const rampGeo = new THREE.BoxGeometry(width, 0.3, length);
    const rampMesh = new THREE.Mesh(rampGeo, this.materials.platform);

    const angle = Math.atan2(height, length);
    if (direction === 'north') {
      rampMesh.rotation.x = angle;
      rampMesh.position.set(cx, height / 2, cz);
      this.colliders.push({
        type: 'ramp',
        axis: 'z',
        dir: 1,
        minX: cx - width / 2,
        maxX: cx + width / 2,
        minZ: cz - length / 2,
        maxZ: cz + length / 2,
        startY: 0,
        endY: height
      });
    } else if (direction === 'south') {
      rampMesh.rotation.x = -angle;
      rampMesh.position.set(cx, height / 2, cz);
      this.colliders.push({
        type: 'ramp',
        axis: 'z',
        dir: -1,
        minX: cx - width / 2,
        maxX: cx + width / 2,
        minZ: cz - length / 2,
        maxZ: cz + length / 2,
        startY: height,
        endY: 0
      });
    }

    rampMesh.receiveShadow = true;
    rampMesh.castShadow = true;
    this.scene.add(rampMesh);

    // Hazard edges on ramp sides
    const edgeGeo = new THREE.BoxGeometry(0.2, 0.4, length);
    const edgeLeft = new THREE.Mesh(edgeGeo, this.materials.hazard);
    edgeLeft.rotation.x = rampMesh.rotation.x;
    edgeLeft.position.set(cx - width / 2, height / 2, cz);
    this.scene.add(edgeLeft);

    const edgeRight = new THREE.Mesh(edgeGeo, this.materials.hazard);
    edgeRight.rotation.x = rampMesh.rotation.x;
    edgeRight.position.set(cx + width / 2, height / 2, cz);
    this.scene.add(edgeRight);
  }

  /**
   * Tactical cover barriers and cargo containers
   */
  buildCoverBarriers() {
    const containers = [
      { x: -18, y: 1.3, z: 12, w: 6, h: 2.6, d: 2.8, rotY: Math.PI / 6, mat: this.materials.crateCyan },
      { x: 18, y: 1.3, z: 12, w: 6, h: 2.6, d: 2.8, rotY: -Math.PI / 6, mat: this.materials.crateRed },
      { x: -18, y: 1.3, z: -12, w: 6, h: 2.6, d: 2.8, rotY: -Math.PI / 8, mat: this.materials.crateRed },
      { x: 18, y: 1.3, z: -12, w: 6, h: 2.6, d: 2.8, rotY: Math.PI / 8, mat: this.materials.crateCyan }
    ];

    containers.forEach(item => {
      const geo = new THREE.BoxGeometry(item.w, item.h, item.d);
      const mesh = new THREE.Mesh(geo, item.mat);
      mesh.position.set(item.x, item.y, item.z);
      mesh.rotation.y = item.rotY || 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      const extent = Math.max(item.w, item.d);
      this.addBoxCollider(item.x, item.y, item.z, extent * 0.85, item.h, extent * 0.85);

      const trimGeo = new THREE.BoxGeometry(item.w + 0.05, 0.1, item.d + 0.05);
      const trim = new THREE.Mesh(trimGeo, this.materials.glowAmber);
      trim.position.set(item.x, item.y + item.h / 2, item.z);
      trim.rotation.y = item.rotY || 0;
      this.scene.add(trim);
    });

    // Low Jersey Barriers (Half-cover: 3m x 1.1m x 0.6m)
    const lowBarriers = [
      { x: -7, z: 18, rotY: 0 },
      { x: 7, z: 18, rotY: 0 },
      { x: -7, z: -18, rotY: 0 },
      { x: 7, z: -18, rotY: 0 },
      { x: -28, z: 8, rotY: Math.PI / 2 },
      { x: 28, z: 8, rotY: Math.PI / 2 }
    ];

    lowBarriers.forEach(b => {
      const geo = new THREE.BoxGeometry(3, 1.1, 0.6);
      const mesh = new THREE.Mesh(geo, this.materials.barrier);
      mesh.position.set(b.x, 0.55, b.z);
      mesh.rotation.y = b.rotY;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      const isRot = b.rotY !== 0;
      this.addBoxCollider(b.x, 0.55, b.z, isRot ? 0.6 : 3, 1.1, isRot ? 3 : 0.6);

      const lineGeo = new THREE.BoxGeometry(isRot ? 0.1 : 2.8, 0.05, isRot ? 2.8 : 0.1);
      const line = new THREE.Mesh(lineGeo, this.materials.glowCyan);
      line.position.set(b.x, 1.12, b.z);
      this.scene.add(line);
    });
  }

  /**
   * Covered Shooting Range Pavilion (Indoor/Outdoor structure)
   */
  buildShootingRange() {
    const laneX = -32;

    // Firing line booth platform
    const boothGeo = new THREE.BoxGeometry(10, 0.25, 12);
    const booth = new THREE.Mesh(boothGeo, this.materials.platform);
    booth.position.set(laneX, 0.125, 24);
    booth.receiveShadow = true;
    this.scene.add(booth);

    // Overhead Shooting Canopy (Roof)
    const roofGeo = new THREE.BoxGeometry(12, 0.3, 14);
    const roof = new THREE.Mesh(roofGeo, this.materials.ceiling);
    roof.position.set(laneX, 4.5, 24);
    roof.castShadow = true;
    this.scene.add(roof);
    this.addBoxCollider(laneX, 4.5, 24, 12, 0.3, 14);

    // Roof Support Pillars
    const pillarPositions = [
      [laneX - 5, 24 - 6], [laneX + 5, 24 - 6],
      [laneX - 5, 24 + 6], [laneX + 5, 24 + 6]
    ];
    pillarPositions.forEach(([px, pz]) => {
      const pilGeo = new THREE.BoxGeometry(0.4, 4.5, 0.4);
      const pil = new THREE.Mesh(pilGeo, this.materials.barrier);
      pil.position.set(px, 2.25, pz);
      pil.castShadow = true;
      this.scene.add(pil);
      this.addBoxCollider(px, 2.25, pz, 0.4, 4.5, 0.4);
    });

    // Shooting targets at 10m, 20m, 30m, and 38m
    const targetDistances = [14, 4, -6, -16];
    targetDistances.forEach((zPos, idx) => {
      const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, 2.0);
      const pole = new THREE.Mesh(poleGeo, this.materials.barrier);
      pole.position.set(laneX, 1.0, zPos);
      pole.castShadow = true;
      this.scene.add(pole);

      const boardGeo = new THREE.PlaneGeometry(1.2, 1.2);
      const target = new THREE.Mesh(boardGeo, this.materials.target);
      target.position.set(laneX, 1.6, zPos + 0.01);
      this.scene.add(target);

      const markerGeo = new THREE.BoxGeometry(2, 0.02, 0.5);
      const marker = new THREE.Mesh(markerGeo, this.materials.glowCyan);
      marker.position.set(laneX, 0.02, zPos + 1.2);
      this.scene.add(marker);
    });
  }

  /**
   * Indoor CQB Warehouse / Bunker Building (North-West)
   */
  buildWarehouseBuilding() {
    const wx = -24;
    const wz = -24;
    const ww = 16;
    const wd = 14;
    const wh = 5.0;

    // Roof
    const roofGeo = new THREE.BoxGeometry(ww, 0.3, wd);
    const roof = new THREE.Mesh(roofGeo, this.materials.ceiling);
    roof.position.set(wx, wh, wz);
    roof.castShadow = true;
    roof.receiveShadow = true;
    this.scene.add(roof);
    this.addBoxCollider(wx, wh, wz, ww, 0.3, wd);

    // North wall (full)
    const nWallGeo = new THREE.BoxGeometry(ww, wh, 0.5);
    const nWall = new THREE.Mesh(nWallGeo, this.materials.wall);
    nWall.position.set(wx, wh / 2, wz - wd / 2);
    nWall.castShadow = true;
    this.scene.add(nWall);
    this.addBoxCollider(wx, wh / 2, wz - wd / 2, ww, wh, 0.5);

    // West wall (full)
    const wWallGeo = new THREE.BoxGeometry(0.5, wh, wd);
    const wWall = new THREE.Mesh(wWallGeo, this.materials.wall);
    wWall.position.set(wx - ww / 2, wh / 2, wz);
    wWall.castShadow = true;
    this.scene.add(wWall);
    this.addBoxCollider(wx - ww / 2, wh / 2, wz, 0.5, wh, wd);

    // South wall with open doorway
    const sWallPartGeo = new THREE.BoxGeometry(5.5, wh, 0.5);
    const sWall1 = new THREE.Mesh(sWallPartGeo, this.materials.wall);
    sWall1.position.set(wx - 4.5, wh / 2, wz + wd / 2);
    sWall1.castShadow = true;
    this.scene.add(sWall1);
    this.addBoxCollider(wx - 4.5, wh / 2, wz + wd / 2, 5.5, wh, 0.5);

    const sWall2 = new THREE.Mesh(sWallPartGeo, this.materials.wall);
    sWall2.position.set(wx + 4.5, wh / 2, wz + wd / 2);
    sWall2.castShadow = true;
    this.scene.add(sWall2);
    this.addBoxCollider(wx + 4.5, wh / 2, wz + wd / 2, 5.5, wh, 0.5);

    // Doorway lintel
    const lintelGeo = new THREE.BoxGeometry(5, 1.8, 0.5);
    const lintel = new THREE.Mesh(lintelGeo, this.materials.wall);
    lintel.position.set(wx, wh - 0.9, wz + wd / 2);
    this.scene.add(lintel);
    this.addBoxCollider(wx, wh - 0.9, wz + wd / 2, 5, 1.8, 0.5);

    // Indoor glowing ceiling light
    const intLight = new THREE.PointLight(0x00f0ff, 1.8, 14, 2);
    intLight.position.set(wx, wh - 0.5, wz);
    this.scene.add(intLight);
  }

  /**
   * Parkour Course & High Catwalk
   */
  buildParkourCourse() {
    const startX = 28;
    const startZ = -24;

    const steps = [
      { y: 0.5, z: 0 },
      { y: 1.0, z: 4 },
      { y: 1.6, z: 8 },
      { y: 2.2, z: 12 },
      { y: 2.8, z: 16 }
    ];

    steps.forEach(step => {
      const geo = new THREE.BoxGeometry(2.2, step.y, 2.2);
      const mesh = new THREE.Mesh(geo, this.materials.platform);
      mesh.position.set(startX, step.y / 2, startZ + step.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.addBoxCollider(startX, step.y / 2, startZ + step.z, 2.2, step.y, 2.2);

      const trimGeo = new THREE.BoxGeometry(2.3, 0.06, 2.3);
      const trim = new THREE.Mesh(trimGeo, this.materials.glowAmber);
      trim.position.set(startX, step.y + 0.03, startZ + step.z);
      this.scene.add(trim);
    });

    // Elevated Sniper Perch & Catwalk (3.2m height)
    const perchW = 6;
    const perchD = 6;
    const perchH = 3.2;
    const perchGeo = new THREE.BoxGeometry(perchW, perchH, perchD);
    const perch = new THREE.Mesh(perchGeo, this.materials.platform);
    perch.position.set(startX, perchH / 2, startZ + 22);
    perch.castShadow = true;
    perch.receiveShadow = true;
    this.scene.add(perch);
    this.addBoxCollider(startX, perchH / 2, startZ + 22, perchW, perchH, perchD);
  }

  /**
   * Pylons & Architectural Accents
   */
  buildDecorations() {
    const pylonPositions = [
      [-12, -12], [12, -12], [-12, 12], [12, 12],
      [-36, -36], [36, -36], [-36, 36], [36, 36]
    ];

    pylonPositions.forEach(([px, pz]) => {
      const pillarGeo = new THREE.CylinderGeometry(0.35, 0.45, 6, 12);
      const pillar = new THREE.Mesh(pillarGeo, this.materials.wall);
      pillar.position.set(px, 3, pz);
      pillar.castShadow = true;
      this.scene.add(pillar);
      this.addBoxCollider(px, 3, pz, 0.9, 6, 0.9);

      const ringGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.3, 12);
      const ring = new THREE.Mesh(ringGeo, this.materials.glowCyan);
      ring.position.set(px, 5.5, pz);
      this.scene.add(ring);
    });
  }

  addBoxCollider(x, y, z, w, h, d) {
    this.colliders.push({
      type: 'box',
      minX: x - w / 2,
      maxX: x + w / 2,
      minY: y - h / 2,
      maxY: y + h / 2,
      minZ: z - d / 2,
      maxZ: z + d / 2
    });
  }

  /**
   * Authoritative tactical ground elevation query.
   * Returns precise elevation for floor, ramps, elevated compound, and catwalks.
   */
  getGroundHeight(x, z) {
    // 1. Sloped Access Ramps to Central Compound
    // South Ramp: x in [-2.5, 2.5], z in [8, 14]
    if (Math.abs(x) <= 2.5 && z >= 8.0 && z <= 14.0) {
      const progress = (14.0 - z) / 6.0; // 0.0 at z=14 (ground), 1.0 at z=8 (compound)
      return Math.max(0.0, Math.min(2.0, progress * 2.0));
    }
    // North Ramp: x in [-2.5, 2.5], z in [-14, -8]
    if (Math.abs(x) <= 2.5 && z >= -14.0 && z <= -8.0) {
      const progress = (z - (-14.0)) / 6.0; // 0.0 at z=-14 (ground), 1.0 at z=-8 (compound)
      return Math.max(0.0, Math.min(2.0, progress * 2.0));
    }

    // 2. Central Elevated Compound (16m x 16m at 2.0m height)
    if (Math.abs(x) <= 8.0 && Math.abs(z) <= 8.0) {
      return 2.0;
    }

    // 3. Parkour Progression Steps & High Sniper Perch
    if (x >= 26.5 && x <= 29.5) {
      if (z >= -25.5 && z <= -22.5) return 0.5;
      if (z >= -21.5 && z <= -18.5) return 1.0;
      if (z >= -17.5 && z <= -14.5) return 1.6;
      if (z >= -13.5 && z <= -10.5) return 2.2;
      if (z >= -9.5 && z <= -6.5) return 2.8;
    }
    if (x >= 25.0 && x <= 31.0 && z >= -5.0 && z <= 1.0) {
      return 3.2;
    }

    // Default: Ground tactical arena floor
    return 0.0;
  }
}
