/**
 * SecureFPS: In-Game Heads-Up Display (HUD) Manager
 * Updates crosshair spread, tactical compass, movement telemetry,
 * stamina, coordinates, and system performance metrics.
 */
class HUD {
  constructor(controller) {
    this.controller = controller;

    // Cache DOM Elements
    this.compassReadout = document.getElementById('compass-readout');
    this.compassSub = document.getElementById('compass-sub');
    this.crosshair = document.getElementById('crosshair');
    this.hudCoords = document.getElementById('hud-coords');
    this.hudSpeed = document.getElementById('hud-speed');
    this.hudFps = document.getElementById('hud-fps');
    this.hudFrameTime = document.getElementById('hud-frame-time');
    this.hudDrawCalls = document.getElementById('hud-draw-calls');
    this.hudTriangles = document.getElementById('hud-triangles');
    this.movementTag = document.getElementById('movement-tag');
    this.staminaFill = document.getElementById('stamina-fill');
    this.staminaVal = document.getElementById('stamina-val');

    // Combat Indicators & HUD Additions
    this.armourFill = document.getElementById('armour-fill');
    this.armourVal = document.getElementById('armour-val');
    this.matchAssists = document.getElementById('match-assists');
    this.matchStreak = document.getElementById('match-streak');
    this.matchPing = document.getElementById('match-ping');
    this.damageVignette = document.getElementById('damage-vignette');
    this.directionalDamageContainer = document.getElementById('directional-damage-container');
    this.floatingDamageContainer = document.getElementById('floating-damage-container');
    this.eliminationBanner = document.getElementById('elimination-banner');
    this.streakBanner = document.getElementById('streak-banner');
    this.killfeed = document.getElementById('killfeed');

    this.enemyRaycaster = new THREE.Raycaster();
    this.lastEnemyCheckTime = 0;

    // Stamina system (100 max)
    this.maxStamina = 100;
    this.stamina = 100;
    this.staminaDrainRate = 28; // points/sec while sprinting
    this.staminaRegenRate = 35; // points/sec while resting

    // FPS calculation state
    this.frameCount = 0;
    this.lastFpsUpdate = performance.now();
    this.fps = 60;
  }

  update(delta) {
    // 1. Calculate FPS & Frame time
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsUpdate >= 500) {
      this.fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsUpdate));
      const frameTimeMs = (1000 / (this.fps || 1)).toFixed(1);
      if (this.hudFps) this.hudFps.textContent = `${this.fps} FPS`;
      if (this.hudFrameTime) this.hudFrameTime.textContent = `${frameTimeMs} ms`;

      const renderer = window.SecureFPSGame?.renderer;
      if (renderer && renderer.info && renderer.info.render) {
        if (this.hudDrawCalls) this.hudDrawCalls.textContent = renderer.info.render.calls || 0;
        if (this.hudTriangles) this.hudTriangles.textContent = (renderer.info.render.triangles || 0).toLocaleString();
      }

      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }

    // 2. Tactical Compass
    if (this.compassReadout && this.controller) {
      const heading = this.controller.getCompassHeading();
      const cardinal = this.getCardinalDirection(heading);
      this.compassReadout.textContent = `${heading.toString().padStart(3, '0')}°`;
      if (this.compassSub) this.compassSub.textContent = cardinal;
    }

    // 3. Movement Coordinates & Speedometer
    if (this.controller) {
      const pos = this.controller.position;
      if (this.hudCoords) {
        this.hudCoords.textContent = `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;
      }

      const horizSpeed = Math.sqrt(
        this.controller.velocity.x * this.controller.velocity.x +
        this.controller.velocity.z * this.controller.velocity.z
      );
      if (this.hudSpeed) {
        this.hudSpeed.textContent = `${horizSpeed.toFixed(1)} m/s`;
      }

      // 4. Movement State Tag & Dynamic Crosshair Spread
      let state = 'STATIONARY';
      let spread = false;

      if (!this.controller.isGrounded) {
        state = 'AIRBORNE';
        spread = true;
      } else if (this.controller.isCrouching) {
        state = horizSpeed > 0.3 ? 'CROUCH WALK' : 'CROUCH';
        spread = false;
      } else if (this.controller.isSprinting && horizSpeed > 0.3) {
        state = 'SPRINTING';
        spread = true;
      } else if (horizSpeed > 0.3) {
        state = 'WALKING';
        spread = true;
      }

      if (this.movementTag) {
        this.movementTag.textContent = state;
      }

      if (this.crosshair) {
        if (spread) {
          this.crosshair.classList.add('spread');
        } else {
          this.crosshair.classList.remove('spread');
        }
      }

      // 5. Stamina mechanics
      if (this.controller.isSprinting && horizSpeed > 0.5) {
        this.stamina = Math.max(0, this.stamina - this.staminaDrainRate * delta);
        if (this.stamina <= 0) {
          // Force sprint to turn off if exhausted
          this.controller.keys.sprint = false;
        }
      } else {
        this.stamina = Math.min(this.maxStamina, this.stamina + this.staminaRegenRate * delta);
      }

      if (this.staminaFill) {
        this.staminaFill.style.width = `${Math.round(this.stamina)}%`;
      }
      if (this.staminaVal) {
        this.staminaVal.textContent = `${Math.round(this.stamina)}%`;
      }
    }
  }


  /**
   * Dynamic Enemy-Aware Crosshair Raycast
   * Evaluates center-screen raycast against enemy hitboxes within effective weapon range.
   * Immediately turns crosshair bright red on enemy, reverts when pointing away or obstructed by walls.
   */
  checkEnemyUnderCrosshair(camera, scene) {
    if (!this.crosshair || !camera || !scene) return;
    this.enemyRaycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = this.enemyRaycaster.intersectObjects(scene.children, true);
    let enemyFound = false;

    for (const hit of hits) {
      if (hit.distance < 0.45) continue;
      const obj = hit.object;

      // Check if hit object belongs to a combat bot
      const bot = obj.userData?.bot;
      if (bot) {
        if (!bot.isDead && bot.spawnProtectionTimer <= 0 && hit.distance <= 80.0) {
          enemyFound = true;
        }
        break; // Hit enemy hitbox
      }

      // Check if hit object belongs to a remote multiplayer player
      const remote = obj.userData?.remotePlayer;
      if (remote) {
        if (remote.health > 0 && hit.distance <= 80.0) {
          enemyFound = true;
        }
        break;
      }

      // If hit is a solid barrier, wall, or floor, vision is obstructed
      if (obj.userData?.isArenaCollider || obj.userData?.isGlass === false || (!obj.userData?.isNonBlocking && !obj.userData?.isMuzzle)) {
        break;
      }
    }

    if (enemyFound) {
      this.crosshair.classList.add('enemy-lock');
    } else {
      this.crosshair.classList.remove('enemy-lock');
    }
  }

  /**
   * Directional Damage Indicator
   * Computes angular delta from camera forward to attacker position and renders fading arc.
   */
  showDirectionalDamage(attackerPos, camera) {
    if (!attackerPos || !camera || !this.directionalDamageContainer) return;

    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);

    const dx = attackerPos.x - camPos.x;
    const dz = attackerPos.z - camPos.z;
    const angleToAttacker = Math.atan2(dx, dz);

    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const camAngle = Math.atan2(camDir.x, camDir.z);

    const relAngle = angleToAttacker - camAngle;
    const deg = (relAngle * 180 / Math.PI + 180) % 360;

    const arc = document.createElement('div');
    arc.className = 'damage-arc';
    arc.style.transform = `rotate(${deg}deg)`;
    this.directionalDamageContainer.appendChild(arc);

    setTimeout(() => {
      arc.style.opacity = '0';
    }, 120);

    setTimeout(() => {
      arc.remove();
    }, 850);
  }

  /**
   * Screen Damage Vignette Flash & Low-Health Warning
   */
  flashDamageVignette(isLowHealth = false) {
    if (!this.damageVignette) return;
    this.damageVignette.classList.add('flash');
    setTimeout(() => {
      if (this.damageVignette) this.damageVignette.classList.remove('flash');
    }, 280);

    if (isLowHealth) {
      this.damageVignette.classList.add('low-health');
      if (window.gameAudio) window.gameAudio.playLowHealthHeartbeat();
    } else {
      this.damageVignette.classList.remove('low-health');
    }
  }

  /**
   * Floating 3D / Screen Damage Numbers
   */
  showFloatingDamage(screenX, screenY, amount, isHeadshot = false) {
    if (!this.floatingDamageContainer) return;
    const el = document.createElement('div');
    el.className = `floating-damage ${isHeadshot ? 'headshot' : 'body'}`;
    el.textContent = isHeadshot ? `CRIT -${amount}` : `-${amount}`;
    el.style.left = `${screenX + (Math.random() - 0.5) * 24}px`;
    el.style.top = `${screenY + (Math.random() - 0.5) * 24}px`;
    this.floatingDamageContainer.appendChild(el);

    setTimeout(() => {
      el.remove();
    }, 650);
  }

  /**
   * Elimination Confirmation Banner
   */
  showElimination(victimName, isHeadshot = false) {
    if (!this.eliminationBanner) return;
    const textEl = document.getElementById('elim-text');
    const ptsEl = document.getElementById('elim-pts');

    if (textEl) {
      textEl.textContent = isHeadshot ? `HEADSHOT // ${victimName}` : `ELIMINATED // ${victimName}`;
    }
    if (ptsEl) {
      ptsEl.textContent = isHeadshot ? '+150 PTS' : '+100 PTS';
    }

    this.eliminationBanner.classList.add('active');
    setTimeout(() => {
      if (this.eliminationBanner) this.eliminationBanner.classList.remove('active');
    }, 1600);
  }

  /**
   * Kill Streak & Multi-Kill Announcement Banner
   */
  showStreakBanner(title, subtitle) {
    if (!this.streakBanner) return;
    const titleEl = document.getElementById('streak-title');
    const subEl = document.getElementById('streak-sub');

    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;

    this.streakBanner.classList.add('active');
    setTimeout(() => {
      if (this.streakBanner) this.streakBanner.classList.remove('active');
    }, 2200);
  }

  /**
   * Kill Feed Notification Entry
   */
  addKillFeedEntry(killer, victim, weaponName, isHeadshot, isLocalKiller, isLocalVictim) {
    if (!this.killfeed) return;
    const row = document.createElement('div');
    row.className = `killfeed-row ${isLocalKiller ? 'local-kill' : (isLocalVictim ? 'local-death' : '')}`;

    const headshotMarker = isHeadshot ? ' <span class="killfeed-headshot">🎯</span>' : '';
    row.innerHTML = `<span class="killfeed-killer">${this.escapeHtml(killer)}</span> <span class="killfeed-weapon">${weaponName}${headshotMarker}</span> <span class="killfeed-victim">${this.escapeHtml(victim)}</span>`;

    this.killfeed.appendChild(row);

    // Limit maximum rows
    while (this.killfeed.children.length > 5) {
      this.killfeed.removeChild(this.killfeed.firstChild);
    }

    setTimeout(() => {
      row.style.opacity = '0';
      setTimeout(() => row.remove(), 400);
    }, 4500);
  }

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Update Armour Vitals
   */
  updateArmour(currentArmour, maxArmour = 50) {
    if (this.armourVal) this.armourVal.textContent = Math.max(0, Math.round(currentArmour));
    if (this.armourFill) {
      const pct = Math.max(0, Math.min(100, Math.round((currentArmour / maxArmour) * 100)));
      this.armourFill.style.width = `${pct}%`;
    }
  }

  updateAssists(assists) {
    if (this.matchAssists) this.matchAssists.textContent = assists;
  }

  updateStreak(streak) {
    if (this.matchStreak) this.matchStreak.textContent = streak;
  }

  updatePing(pingMs) {
    if (this.matchPing) this.matchPing.textContent = `${pingMs}ms`;
  }

  setCrosshairColor(colorKey) {
    if (!this.crosshair) return;
    this.crosshair.classList.remove('color-green', 'color-yellow', 'color-white', 'color-magenta');
    if (colorKey && colorKey !== 'cyan') {
      this.crosshair.classList.add(`color-${colorKey}`);
    }
  }

  setCrosshairSize(sizeKey) {
    if (!this.crosshair) return;
    this.crosshair.classList.remove('size-small', 'size-large');
    if (sizeKey === 'small') this.crosshair.classList.add('size-small');
    else if (sizeKey === 'large') this.crosshair.classList.add('size-large');
  }

  setCrosshairVisible(visible) {
    if (!this.crosshair) return;
    this.crosshair.style.display = visible ? 'block' : 'none';
  }

  getCardinalDirection(deg) {
    if (deg >= 337.5 || deg < 22.5) return 'NORTH';
    if (deg >= 22.5 && deg < 67.5) return 'NORTH-EAST';
    if (deg >= 67.5 && deg < 112.5) return 'EAST';
    if (deg >= 112.5 && deg < 157.5) return 'SOUTH-EAST';
    if (deg >= 157.5 && deg < 202.5) return 'SOUTH';
    if (deg >= 202.5 && deg < 247.5) return 'SOUTH-WEST';
    if (deg >= 247.5 && deg < 292.5) return 'WEST';
    return 'NORTH-WEST';
  }
}
