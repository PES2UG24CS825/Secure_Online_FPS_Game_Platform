/**
 * SecureFPS: Shared Arena Geometry & Collision Engine
 * Authoritative physical bounding boxes, spawn points, elevation queries,
 * and raycast occlusion testing against static arena obstacles.
 * Compatible with Node.js (CommonJS) and browser environments.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ArenaCollision = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 8 Strategic Spawn Points across the 80m x 80m compound
  const ARENA_SPAWNS = [
    { x: 0, y: 0.0, z: 28 },
    { x: 0, y: 0.0, z: -28 },
    { x: -26, y: 0.0, z: 0 },
    { x: 26, y: 0.0, z: 14 },
    { x: -20, y: 0.0, z: 18 },
    { x: 20, y: 0.0, z: -18 },
    { x: 0, y: 2.0, z: 0 },   // Central elevated platform
    { x: 15, y: 0.0, z: 15 }
  ];

  // Tactical Arena Playable Boundaries (meters)
  const ARENA_BOUNDS = {
    minX: -38.5,
    maxX: 38.5,
    minY: 0.0,
    maxY: 12.0,
    minZ: -38.5,
    maxZ: 38.5
  };

  function createBox(x, y, z, w, h, d, name = '') {
    return {
      name,
      minX: x - w / 2,
      maxX: x + w / 2,
      minY: y - h / 2,
      maxY: y + h / 2,
      minZ: z - d / 2,
      maxZ: z + d / 2
    };
  }

  // Pre-compiled authoritative AABB list matching Arena.js
  const COLLIDERS = [];

  // 1. Perimeter Walls (80m x 80m, height 8m, thickness 2m)
  COLLIDERS.push(createBox(0, 4, -40, 80, 8, 2, 'wall_north'));
  COLLIDERS.push(createBox(0, 4, 40, 80, 8, 2, 'wall_south'));
  COLLIDERS.push(createBox(40, 4, 0, 2, 8, 80, 'wall_east'));
  COLLIDERS.push(createBox(-40, 4, 0, 2, 8, 80, 'wall_west'));

  // 2. Central Compound (16m x 16m at 2.0m height)
  COLLIDERS.push(createBox(0, 1.0, 0, 16, 2.0, 16, 'central_platform'));
  COLLIDERS.push(createBox(0, 4.0, 0, 4, 4, 4, 'central_spire'));
  // Parapets
  COLLIDERS.push(createBox(-7.75, 2.55, 0, 0.5, 1.1, 16, 'parapet_west'));
  COLLIDERS.push(createBox(7.75, 2.55, 0, 0.5, 1.1, 16, 'parapet_east'));

  // 3. Cargo Containers (extent * 0.85 approx 5.1m)
  COLLIDERS.push(createBox(-18, 1.3, 12, 5.1, 2.6, 5.1, 'crate_sw'));
  COLLIDERS.push(createBox(18, 1.3, 12, 5.1, 2.6, 5.1, 'crate_se'));
  COLLIDERS.push(createBox(-18, 1.3, -12, 5.1, 2.6, 5.1, 'crate_nw'));
  COLLIDERS.push(createBox(18, 1.3, -12, 5.1, 2.6, 5.1, 'crate_ne'));

  // 4. Low Barriers
  COLLIDERS.push(createBox(-7, 0.55, 18, 3, 1.1, 0.6, 'barrier_1'));
  COLLIDERS.push(createBox(7, 0.55, 18, 3, 1.1, 0.6, 'barrier_2'));
  COLLIDERS.push(createBox(-7, 0.55, -18, 3, 1.1, 0.6, 'barrier_3'));
  COLLIDERS.push(createBox(7, 0.55, -18, 3, 1.1, 0.6, 'barrier_4'));
  COLLIDERS.push(createBox(-28, 0.55, 8, 0.6, 1.1, 3, 'barrier_5'));
  COLLIDERS.push(createBox(28, 0.55, 8, 0.6, 1.1, 3, 'barrier_6'));

  // 5. Shooting Range Canopy & Pillars
  COLLIDERS.push(createBox(-32, 4.5, 24, 12, 0.3, 14, 'range_roof'));
  COLLIDERS.push(createBox(-37, 2.25, 18, 0.4, 4.5, 0.4, 'range_pil_1'));
  COLLIDERS.push(createBox(-27, 2.25, 18, 0.4, 4.5, 0.4, 'range_pil_2'));
  COLLIDERS.push(createBox(-37, 2.25, 30, 0.4, 4.5, 0.4, 'range_pil_3'));
  COLLIDERS.push(createBox(-27, 2.25, 30, 0.4, 4.5, 0.4, 'range_pil_4'));

  // 6. Indoor CQB Warehouse
  const wx = -24;
  const wz = -24;
  const ww = 16;
  const wd = 14;
  const wh = 5.0;
  COLLIDERS.push(createBox(wx, wh, wz, ww, 0.3, wd, 'warehouse_roof'));
  COLLIDERS.push(createBox(wx, wh / 2, wz - wd / 2, ww, wh, 0.5, 'warehouse_n_wall'));
  COLLIDERS.push(createBox(wx - ww / 2, wh / 2, wz, 0.5, wh, wd, 'warehouse_w_wall'));
  COLLIDERS.push(createBox(wx - 4.5, wh / 2, wz + wd / 2, 5.5, wh, 0.5, 'warehouse_s_wall_1'));
  COLLIDERS.push(createBox(wx + 4.5, wh / 2, wz + wd / 2, 5.5, wh, 0.5, 'warehouse_s_wall_2'));
  COLLIDERS.push(createBox(wx, wh - 0.9, wz + wd / 2, 5.0, 1.8, 0.5, 'warehouse_lintel'));

  // 7. Parkour Course & Sniper Perch
  COLLIDERS.push(createBox(28, 0.25, -24, 2.2, 0.5, 2.2, 'step_1'));
  COLLIDERS.push(createBox(28, 0.5, -20, 2.2, 1.0, 2.2, 'step_2'));
  COLLIDERS.push(createBox(28, 0.8, -16, 2.2, 1.6, 2.2, 'step_3'));
  COLLIDERS.push(createBox(28, 1.1, -12, 2.2, 2.2, 2.2, 'step_4'));
  COLLIDERS.push(createBox(28, 1.4, -8, 2.2, 2.8, 2.2, 'step_5'));
  COLLIDERS.push(createBox(28, 1.6, -2, 6, 3.2, 6, 'sniper_perch'));

  // 8. Pylons
  const pylons = [
    [-12, -12], [12, -12], [-12, 12], [12, 12],
    [-36, -36], [36, -36], [-36, 36], [36, 36]
  ];
  pylons.forEach(([px, pz], i) => {
    COLLIDERS.push(createBox(px, 3, pz, 0.9, 6, 0.9, `pylon_${i + 1}`));
  });

  /**
   * Ground elevation query (floor, ramps, central compound, parkour steps, catwalk)
   */
  function getGroundHeight(x, z) {
    // 1. Central ramps
    if (Math.abs(x) <= 2.5 && z >= 8.0 && z <= 14.0) {
      const progress = (14.0 - z) / 6.0;
      return Math.max(0.0, Math.min(2.0, progress * 2.0));
    }
    if (Math.abs(x) <= 2.5 && z >= -14.0 && z <= -8.0) {
      const progress = (z - (-14.0)) / 6.0;
      return Math.max(0.0, Math.min(2.0, progress * 2.0));
    }

    // 2. Central Compound
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

    return 0.0;
  }

  /**
   * Raycast AABB intersection test using slab method.
   * Returns distance t if ray hits box within [0, maxDistance], else null.
   */
  function intersectRayBox(origX, origY, origZ, dirX, dirY, dirZ, box, maxDistance = Infinity) {
    let tmin = 0.0;
    let tmax = maxDistance;

    // X slab
    if (Math.abs(dirX) < 1e-6) {
      if (origX < box.minX || origX > box.maxX) return null;
    } else {
      const invD = 1.0 / dirX;
      let t1 = (box.minX - origX) * invD;
      let t2 = (box.maxX - origX) * invD;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }

    // Y slab
    if (Math.abs(dirY) < 1e-6) {
      if (origY < box.minY || origY > box.maxY) return null;
    } else {
      const invD = 1.0 / dirY;
      let t1 = (box.minY - origY) * invD;
      let t2 = (box.maxY - origY) * invD;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }

    // Z slab
    if (Math.abs(dirZ) < 1e-6) {
      if (origZ < box.minZ || origZ > box.maxZ) return null;
    } else {
      const invD = 1.0 / dirZ;
      let t1 = (box.minZ - origZ) * invD;
      let t2 = (box.maxZ - origZ) * invD;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }

    return tmin <= maxDistance ? tmin : null;
  }

  /**
   * Check if a line of sight between origin and target is occluded by static arena obstacles.
   * Tolerates a small skin margin at start and end points (0.15m) so shooters peeking edges are not self-occluded.
   */
  function checkRaycastOcclusion(origin, target) {
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const dz = target.z - origin.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist <= 0.3) return false;

    const dirX = dx / dist;
    const dirY = dy / dist;
    const dirZ = dz / dist;

    // Offset start slightly along ray to prevent self-collider collision
    const startOffset = 0.2;
    const endOffset = 0.2;
    const rayDist = dist - endOffset;
    if (rayDist <= startOffset) return false;

    const startX = origin.x + dirX * startOffset;
    const startY = origin.y + dirY * startOffset;
    const startZ = origin.z + dirZ * startOffset;
    const maxT = rayDist - startOffset;

    for (let i = 0; i < COLLIDERS.length; i++) {
      const box = COLLIDERS[i];
      const hitT = intersectRayBox(startX, startY, startZ, dirX, dirY, dirZ, box, maxT);
      if (hitT !== null && hitT >= 0.05 && hitT <= maxT) {
        return true; // Occluded by static obstacle
      }
    }
    return false;
  }

  /**
   * Check if a 3D point penetrates any static collision box (with optional player cylinder/sphere radius)
   */
  function checkPointCollision(x, y, z, radius = 0.35, height = 1.8) {
    const minP_y = y;
    const maxP_y = y + height;

    for (let i = 0; i < COLLIDERS.length; i++) {
      const box = COLLIDERS[i];
      // Skip roofs if player is below or above them
      if (box.name.includes('roof') && (y < box.minY || y > box.maxY)) continue;

      const overlapX = (x + radius > box.minX) && (x - radius < box.maxX);
      const overlapZ = (z + radius > box.minZ) && (z - radius < box.maxZ);
      const overlapY = (maxP_y > box.minY) && (minP_y < box.maxY);

      if (overlapX && overlapZ && overlapY) {
        return box;
      }
    }
    return null;
  }

  /**
   * Check if position is within valid arena bounds
   */
  function isWithinBounds(x, y, z) {
    return (
      x >= ARENA_BOUNDS.minX && x <= ARENA_BOUNDS.maxX &&
      z >= ARENA_BOUNDS.minZ && z <= ARENA_BOUNDS.maxZ &&
      y >= ARENA_BOUNDS.minY - 0.5 && y <= ARENA_BOUNDS.maxY
    );
  }

  return {
    ARENA_SPAWNS,
    ARENA_BOUNDS,
    COLLIDERS,
    getGroundHeight,
    intersectRayBox,
    checkRaycastOcclusion,
    checkPointCollision,
    isWithinBounds
  };
}));
