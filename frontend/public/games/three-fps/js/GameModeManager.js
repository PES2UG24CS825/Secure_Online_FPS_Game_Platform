/**
 * SecureFPS: Game Mode & Combat Progression Manager
 * Coordinates Training, Free-for-All, Solo Combat, Multiplayer, and Difficulty Settings,
 * 5-second spawn protection shields, 12:00 match countdown timers, 25-kill target limits,
 * player vitals (Health & Tactical Armour), respawns, kill feed announcements, streak tracking,
 * assist arbitration, winner & MVP determination, and anti-cheat telemetry.
 */

class GameModeManager {
  constructor(audio) {
    this.audio = audio;
    this.currentMode = 'bots'; // 'solo', 'bots', 'training', 'multiplayer'
    this.difficulty = 'normal'; // 'easy', 'normal', 'hard'

    // Player Vitals (Health: 100 HP, Armour: 50 AP)
    this.playerHealth = 100;
    this.maxHealth = 100;
    this.playerArmour = 50;
    this.maxArmour = 50;
    this.isDead = false;

    // 5-Second Tactical Spawn Protection
    this.hasSpawnProtection = true;
    this.spawnProtectionDuration = 5.0;
    this.spawnProtectionTimer = 5.0;

    // Match Metrics & Combat Performance
    this.kills = 0;
    this.deaths = 0;
    this.assists = 0;
    this.headshots = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.damageDealt = 0;
    this.damageReceived = 0;

    // Killstreaks & Multi-kills
    this.currentStreak = 0;
    this.highestStreak = 0;
    this.recentKillTimestamps = [];
    this.enemyDamageHistory = {}; // victimName -> { damage: number, lastHitTime: number }

    // Timers: 12 minutes (720 seconds) for standard timed operations
    this.matchDuration = 720; // 12:00
    this.timeRemaining = 720;
    this.matchActive = false;
    this.isMatchCompleted = false;

    // Score Limits
    this.targetKills = 25; // 25 eliminations for Solo & optional bot target

    // Bot Scores (for scoreboard winner arbitration)
    this.botScores = {
      'Viper-01': { kills: 0, deaths: 0 },
      'Valkyrie-02': { kills: 0, deaths: 0 },
      'Apex-03': { kills: 0, deaths: 0 },
      'Raven-04': { kills: 0, deaths: 0 }
    };

    // DOM Caches
    this.healthVal = document.getElementById('health-val');
    this.healthFill = document.getElementById('health-fill');
    this.armourVal = document.getElementById('armour-val');
    this.armourFill = document.getElementById('armour-fill');
    this.matchKills = document.getElementById('match-kills');
    this.matchDeaths = document.getElementById('match-deaths');
    this.matchAssists = document.getElementById('match-assists');
    this.matchStreak = document.getElementById('match-streak');
    this.matchTimerEl = document.getElementById('match-timer');
    this.killfeedContainer = document.getElementById('killfeed');
    this.deathOverlay = document.getElementById('death-overlay');
    this.respawnTimerEl = document.getElementById('respawn-timer-val');
    this.shieldIndicator = document.getElementById('spawn-shield-indicator');

    this.initEvents();
  }

  setMode(mode) {
    this.currentMode = mode;
    this.resetMatch();
  }

  setDifficulty(diff) {
    this.difficulty = diff;
    if (window.SecureFPSGame?.botManager) {
      window.SecureFPSGame.botManager.setDifficulty(diff);
    }
  }

  initEvents() {
    window.addEventListener('fps:kill', (e) => {
      this.onKill(e.detail);
    });

    window.addEventListener('fps:telemetry_fire', () => {
      this.shotsFired++;
    });

    window.addEventListener('fps:telemetry_hit', (e) => {
      this.shotsHit++;
      if (e.detail?.headshot) this.headshots++;
    });
  }

  startMatch() {
    this.matchActive = true;
    this.isMatchCompleted = false;
    this.timeRemaining = this.matchDuration;
    this.hasSpawnProtection = true;
    this.spawnProtectionTimer = this.spawnProtectionDuration;
    this.playerHealth = this.maxHealth;
    this.playerArmour = this.maxArmour;
    this.isDead = false;
    this.kills = 0;
    this.deaths = 0;
    this.assists = 0;
    this.headshots = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.damageDealt = 0;
    this.damageReceived = 0;
    this.currentStreak = 0;
    this.highestStreak = 0;
    this.recentKillTimestamps = [];
    this.enemyDamageHistory = {};
    this.resetBotScores();
    this.updateHUD();
    this.updateSpawnProtectionHUD();
    this.updateTimerDisplay();
  }

  resetMatch() {
    this.kills = 0;
    this.deaths = 0;
    this.assists = 0;
    this.headshots = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.damageDealt = 0;
    this.damageReceived = 0;
    this.currentStreak = 0;
    this.highestStreak = 0;
    this.recentKillTimestamps = [];
    this.enemyDamageHistory = {};
    this.matchActive = false;
    this.isMatchCompleted = false;
    this.timeRemaining = this.matchDuration;
    this.playerHealth = this.maxHealth;
    this.playerArmour = this.maxArmour;
    this.isDead = false;
    this.hasSpawnProtection = true;
    this.spawnProtectionTimer = this.spawnProtectionDuration;
    this.resetBotScores();
    this.updateHUD();
    this.updateSpawnProtectionHUD();
    this.updateTimerDisplay();
  }

  resetBotScores() {
    this.botScores = {
      'Viper-01': { kills: 0, deaths: 0 },
      'Valkyrie-02': { kills: 0, deaths: 0 },
      'Apex-03': { kills: 0, deaths: 0 },
      'Raven-04': { kills: 0, deaths: 0 }
    };
  }

  update(delta, controller) {
    if (!this.matchActive || this.isMatchCompleted) return;

    // 1. Update Spawn Protection Shield Timer
    if (this.hasSpawnProtection) {
      this.spawnProtectionTimer -= delta;
      if (this.spawnProtectionTimer <= 0) {
        this.hasSpawnProtection = false;
        this.spawnProtectionTimer = 0;
      }
      this.updateSpawnProtectionHUD();
    }

    // 2. Countdown Match Timer (12:00 -> 00:00)
    // Training mode does not run a countdown timer
    if (this.currentMode !== 'training') {
      this.timeRemaining -= delta;
      if (this.timeRemaining <= 0) {
        this.timeRemaining = 0;
        this.completeMatch('time_expired');
      }
      this.updateTimerDisplay();
    }
  }

  updateSpawnProtectionHUD() {
    if (!this.shieldIndicator) {
      this.shieldIndicator = document.getElementById('spawn-shield-indicator');
    }
    if (!this.shieldIndicator) return;

    if (this.hasSpawnProtection && this.spawnProtectionTimer > 0) {
      this.shieldIndicator.style.display = 'flex';
      this.shieldIndicator.innerHTML = `
        <span class="shield-icon">🛡️</span>
        <span class="shield-text">SPAWN PROTECTION: ${this.spawnProtectionTimer.toFixed(1)}s</span>
      `;
    } else {
      this.shieldIndicator.style.display = 'none';
    }
  }

  recordDamageDealt(targetName, amount) {
    if (!targetName) return;
    this.damageDealt += amount;
    if (!this.enemyDamageHistory[targetName]) {
      this.enemyDamageHistory[targetName] = { damage: 0, lastHitTime: Date.now() };
    }
    this.enemyDamageHistory[targetName].damage += amount;
    this.enemyDamageHistory[targetName].lastHitTime = Date.now();
  }

  checkAssist(victimName, killerName) {
    if (!victimName || killerName === 'Operator' || killerName === 'Operator (You)') return;
    const record = this.enemyDamageHistory[victimName];
    if (record) {
      const now = Date.now();
      if (record.damage >= 25 && (now - record.lastHitTime) <= 10000) {
        this.assists++;
        if (this.matchAssists) this.matchAssists.textContent = this.assists;
        if (window.SecureFPSGame?.hud?.showStreakBanner) {
          window.SecureFPSGame.hud.showStreakBanner("ASSIST CONFIRMED", `+50 PTS // Assist on ${victimName}`);
        }
      }
      delete this.enemyDamageHistory[victimName];
    }
  }

  damagePlayer(amount, attackerName, controller, attackerPos = null) {
    // If player is dead, match completed, or has spawn protection active, ignore damage completely
    if (this.isDead || this.hasSpawnProtection || this.isMatchCompleted || !this.matchActive) return;

    // Tactical Armour Absorption: absorbs 65% while AP > 0, remainder penetrates to HP
    let absorbed = 0;
    let healthDmg = amount;
    if (this.playerArmour > 0) {
      const wantAbsorb = amount * 0.65;
      if (wantAbsorb <= this.playerArmour) {
        this.playerArmour -= wantAbsorb;
        absorbed = wantAbsorb;
        healthDmg = amount - absorbed;
      } else {
        absorbed = this.playerArmour;
        this.playerArmour = 0;
        healthDmg = amount - absorbed;
      }
    }

    this.playerHealth = Math.max(0, this.playerHealth - healthDmg);
    this.damageReceived += amount;
    this.updateHUD();

    // Audio hurt & low-health heartbeat
    if (this.audio?.playHurtSound) {
      this.audio.playHurtSound();
    }
    if (this.playerHealth < 25 && this.audio?.playLowHealthHeartbeat) {
      this.audio.playLowHealthHeartbeat();
    }

    // Directional damage arc & screen-edge vignette
    if (window.SecureFPSGame?.hud) {
      window.SecureFPSGame.hud.flashDamageVignette(this.playerHealth < 25);
      if (attackerPos && window.SecureFPSGame.camera) {
        window.SecureFPSGame.hud.showDirectionalDamage(attackerPos, window.SecureFPSGame.camera);
      }
    }

    // Radial screen flash fallback
    this.triggerDamageFlash();

    // Check player elimination
    if (this.playerHealth <= 0) {
      this.onPlayerDeath(attackerName, controller);
    }
  }

  onPlayerDeath(attackerName, controller) {
    if (this.isDead || this.isMatchCompleted) return;

    this.isDead = true;
    this.deaths++;
    this.currentStreak = 0; // Reset streak on death
    this.updateHUD();

    // Track bot kill score
    if (attackerName && this.botScores[attackerName]) {
      this.botScores[attackerName].kills++;
    }

    // Announce in killfeed
    if (window.SecureFPSGame?.hud?.addKillFeedEntry) {
      window.SecureFPSGame.hud.addKillFeedEntry(
        attackerName || "Combat Bot",
        "Operator (You)",
        "P-24 Carbine",
        false,
        false,
        true
      );
    } else {
      this.addKillfeed(attackerName || "Combat Bot", "Operator (You)", false);
    }

    // Show respawn overlay
    if (this.deathOverlay) {
      this.deathOverlay.classList.add('active');
    }

    window.dispatchEvent(new CustomEvent('fps:telemetry_death', {
      detail: { killer: attackerName }
    }));

    // If match ended while dying, do not schedule respawn
    if (this.isMatchCompleted) return;

    // 3-second respawn timer
    let count = 3;
    if (this.respawnTimerEl) this.respawnTimerEl.textContent = `${count}s`;

    const interval = setInterval(() => {
      count--;
      if (this.respawnTimerEl) this.respawnTimerEl.textContent = `${count}s`;
      if (count <= 0 || this.isMatchCompleted) {
        clearInterval(interval);
        if (!this.isMatchCompleted && this.matchActive) {
          this.respawnPlayer(controller);
        }
      }
    }, 1000);
  }

  respawnPlayer(controller) {
    if (this.isMatchCompleted || !this.matchActive) return;

    this.isDead = false;
    this.playerHealth = this.maxHealth;
    this.playerArmour = this.maxArmour;
    this.hasSpawnProtection = true;
    this.spawnProtectionTimer = this.spawnProtectionDuration;
    this.currentStreak = 0;

    if (this.deathOverlay) {
      this.deathOverlay.classList.remove('active');
    }

    this.updateHUD();
    this.updateSpawnProtectionHUD();

    if (controller) {
      controller.respawn(new THREE.Vector3(0, 1.8, 28));
      controller.resetKeys();
      controller.requestLock();
    }
  }

  onKill(detail) {
    if (this.isMatchCompleted || !this.matchActive) return;

    this.kills++;
    this.currentStreak++;
    if (this.currentStreak > this.highestStreak) {
      this.highestStreak = this.currentStreak;
    }
    this.updateHUD();

    const victimName = detail.victim || "Combat Bot";
    if (this.botScores[victimName]) {
      this.botScores[victimName].deaths++;
    }
    delete this.enemyDamageHistory[victimName];

    // Killfeed entry
    if (window.SecureFPSGame?.hud?.addKillFeedEntry) {
      window.SecureFPSGame.hud.addKillFeedEntry(
        "Operator",
        victimName,
        detail.weapon || "P-24 Carbine",
        detail.headshot,
        true,
        false
      );
    } else {
      this.addKillfeed("Operator", victimName, detail.headshot);
    }

    // Multi-Kill Tracking (Rapid eliminations within 4.5 seconds)
    const now = Date.now();
    this.recentKillTimestamps.push(now);
    this.recentKillTimestamps = this.recentKillTimestamps.filter(t => (now - t) <= 4500);
    const multiCount = this.recentKillTimestamps.length;
    if (multiCount === 2) {
      window.SecureFPSGame?.hud?.showStreakBanner("DOUBLE KILL", "Rapid Neutralization (+100 PTS)");
      this.audio?.playStreakSound?.(2);
    } else if (multiCount === 3) {
      window.SecureFPSGame?.hud?.showStreakBanner("TRIPLE KILL", "Dominating the Engagement (+150 PTS)");
      this.audio?.playStreakSound?.(3);
    } else if (multiCount >= 4) {
      window.SecureFPSGame?.hud?.showStreakBanner("MULTI KILL", "Unstoppable Firepower (+200 PTS)");
      this.audio?.playStreakSound?.(4);
    }

    // Killstreak Milestones
    if (this.currentStreak === 3) {
      window.SecureFPSGame?.hud?.showStreakBanner("KILLING SPREE", "3 Consecutive Eliminations");
      this.audio?.playStreakSound?.(3);
    } else if (this.currentStreak === 5) {
      window.SecureFPSGame?.hud?.showStreakBanner("DOMINATING", "5 Consecutive Eliminations");
      this.audio?.playStreakSound?.(5);
    } else if (this.currentStreak === 7) {
      window.SecureFPSGame?.hud?.showStreakBanner("UNSTOPPABLE", "7 Consecutive Eliminations");
      this.audio?.playStreakSound?.(7);
    } else if (this.currentStreak === 10) {
      window.SecureFPSGame?.hud?.showStreakBanner("TACTICAL APEX", "10 Consecutive Eliminations");
      this.audio?.playStreakSound?.(10);
    }

    // Check score limit (25 confirmed kills ends match immediately!)
    if (this.kills >= this.targetKills) {
      this.completeMatch('score_limit_reached');
    }
  }

  addKillfeed(killer, victim, isHeadshot) {
    if (!this.killfeedContainer) return;

    const item = document.createElement('div');
    item.className = `killfeed-item ${isHeadshot ? 'headshot' : ''}`;
    item.innerHTML = `
      <span class="killer">${killer}</span>
      <span style="color:#94a3b8">eliminated</span>
      <span class="victim">${victim}</span>
      ${isHeadshot ? '<span style="color:#fbbf24; font-weight:700;">[HEADSHOT]</span>' : ''}
    `;

    this.killfeedContainer.appendChild(item);

    setTimeout(() => {
      item.remove();
    }, 4500);
  }

  triggerDamageFlash() {
    const flash = document.createElement('div');
    flash.style.position = 'fixed';
    flash.style.inset = '0';
    flash.style.background = 'radial-gradient(circle at center, rgba(239, 68, 68, 0.4) 0%, rgba(220, 38, 38, 0.8) 100%)';
    flash.style.pointerEvents = 'none';
    flash.style.zIndex = '150';
    flash.style.transition = 'opacity 0.2s ease-out';
    document.body.appendChild(flash);

    setTimeout(() => {
      flash.style.opacity = '0';
      setTimeout(() => flash.remove(), 200);
    }, 80);
  }

  updateHUD() {
    if (this.healthVal) {
      this.healthVal.textContent = Math.round(this.playerHealth);
      if (this.playerHealth <= 30) this.healthVal.classList.add('low');
      else this.healthVal.classList.remove('low');
    }

    if (this.healthFill) {
      this.healthFill.style.width = `${Math.round((this.playerHealth / this.maxHealth) * 100)}%`;
      if (this.playerHealth <= 30) this.healthFill.classList.add('health-low');
      else this.healthFill.classList.remove('health-low');
    }

    if (this.armourVal) {
      this.armourVal.textContent = Math.round(this.playerArmour);
    }
    if (this.armourFill) {
      this.armourFill.style.width = `${Math.round((this.playerArmour / this.maxArmour) * 100)}%`;
    }

    if (this.matchKills) this.matchKills.textContent = this.kills;
    if (this.matchDeaths) this.matchDeaths.textContent = this.deaths;
    if (this.matchAssists) this.matchAssists.textContent = this.assists;
    if (this.matchStreak) this.matchStreak.textContent = this.currentStreak;
  }

  updateTimerDisplay() {
    if (!this.matchTimerEl) return;
    const mins = Math.floor(Math.max(0, this.timeRemaining) / 60);
    const secs = Math.floor(Math.max(0, this.timeRemaining) % 60);
    this.matchTimerEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  completeMatch(reason = 'score_limit_reached') {
    if (this.isMatchCompleted) return;
    this.matchActive = false;
    this.isMatchCompleted = true;

    // Stop all bot activity immediately!
    if (window.SecureFPSGame?.botManager) {
      window.SecureFPSGame.botManager.stopAllBots();
    }

    // Determine Winner & Placings
    let winnerName = 'Operator (You)';
    let isVictory = true;
    let isDraw = false;

    // Find highest scoring bot
    let topBotName = null;
    let topBotKills = -1;
    Object.keys(this.botScores).forEach(name => {
      if (this.botScores[name].kills > topBotKills) {
        topBotKills = this.botScores[name].kills;
        topBotName = name;
      }
    });

    const currentPlName = sessionStorage.getItem('securefps_player_name') || 'Operator (You)';
    if (this.kills > topBotKills) {
      winnerName = currentPlName;
      isVictory = true;
    } else if (this.kills === topBotKills) {
      winnerName = 'Draw Match';
      isVictory = false;
      isDraw = true;
    } else {
      winnerName = topBotName || 'Enemy Forces';
      isVictory = false;
    }

    const matchDurationSec = Math.max(1, Math.round(this.matchDuration - this.timeRemaining));
    const accuracy = this.shotsFired > 0 ? (this.shotsHit / this.shotsFired) : 0;
    const kdr = this.deaths > 0 ? (this.kills / this.deaths) : this.kills;
    const totalScore = Math.max(0, this.kills * 100 + this.assists * 50 + this.headshots * 50 + Math.round(this.damageDealt * 0.1) - this.deaths * 25);

    // Match MVP Determination
    let mvpName = currentPlName;
    let mvpScore = totalScore;
    Object.keys(this.botScores).forEach(name => {
      const b = this.botScores[name];
      const bScore = Math.max(0, b.kills * 100 - b.deaths * 25);
      if (bScore > mvpScore) {
        mvpName = name;
        mvpScore = bScore;
      }
    });

    const completionDetail = {
      mode: this.currentMode,
      reason: reason,
      winner: winnerName,
      isVictory: isVictory,
      isDraw: isDraw,
      kills: this.kills,
      deaths: this.deaths,
      assists: this.assists,
      shots: this.shotsFired,
      hits: this.shotsHit,
      accuracy: accuracy,
      headshots: this.headshots,
      kdr: kdr,
      duration: matchDurationSec,
      score: totalScore,
      damageDealt: this.damageDealt,
      damageReceived: this.damageReceived,
      highestStreak: this.highestStreak,
      mvp: { name: mvpName, score: mvpScore },
      botScores: this.botScores
    };

    console.log('[SecureFPS Match] Match completed successfully:', completionDetail);

    // Release pointer lock so player can click buttons on winner screen
    if (document.exitPointerLock) {
      document.exitPointerLock();
    }

    window.dispatchEvent(new CustomEvent('fps:game_completed', {
      detail: completionDetail
    }));
  }
}
