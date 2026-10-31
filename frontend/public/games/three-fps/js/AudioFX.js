/**
 * SecureFPS: High-Performance Procedural Audio Engine
 * Generates dynamic combat sound effects using Web Audio API:
 * Assault Rifle (P-24 Carbine), SMG (Vector-9), Sniper (AWM-50), and Pistol (G-18),
 * mechanical reload sequences, hitmarker audio, dry-fire clicks, and footsteps.
 * Zero external audio files required - zero load latency, 100% reliable.
 */
class AudioFX {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.isMuted = false;
    this.initialized = false;
    this.lastHeartbeatTime = 0;
  }

  init() {
    if (this.initialized) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.9, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.setValueAtTime(0.85, this.ctx.currentTime);
      this.sfxGain.connect(this.masterGain);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.setValueAtTime(0.7, this.ctx.currentTime);
      this.musicGain.connect(this.masterGain);

      this.initialized = true;
    } catch (e) {
      console.warn('[SecureFPS Audio] Web Audio API not supported:', e);
    }
  }

  setMasterVolume(vol) {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(Math.max(0, Math.min(1, vol)), this.ctx.currentTime);
    }
  }

  setSFXVolume(vol) {
    if (this.sfxGain && this.ctx) {
      this.sfxGain.gain.setValueAtTime(Math.max(0, Math.min(1, vol)), this.ctx.currentTime);
    }
  }

  setMusicVolume(vol) {
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setValueAtTime(Math.max(0, Math.min(1, vol)), this.ctx.currentTime);
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * Procedural gunshot report supporting multiple weapon calibers:
   * 'rifle' (5.56), 'smg' (9mm rapid), 'sniper' (.338 Lapua), 'pistol' (9mm)
   */
  playGunshot(weaponType = 'rifle', isSilenced = false) {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    this.resume();

    const now = this.ctx.currentTime;
    const dest = this.sfxGain || this.masterGain || this.ctx.destination;

    let noiseDuration = 0.08;
    let noiseFreq = 2200;
    let bassStart = 140;
    let bassEnd = 35;
    let bassDuration = 0.12;
    let bassGainVal = 0.7;

    if (weaponType === 'smg') {
      noiseDuration = 0.05;
      noiseFreq = 2800;
      bassStart = 120;
      bassEnd = 50;
      bassDuration = 0.08;
      bassGainVal = 0.55;
    } else if (weaponType === 'sniper') {
      noiseDuration = 0.14;
      noiseFreq = 1600;
      bassStart = 180;
      bassEnd = 24;
      bassDuration = 0.28;
      bassGainVal = 1.0;
    } else if (weaponType === 'pistol') {
      noiseDuration = 0.06;
      noiseFreq = 2400;
      bassStart = 160;
      bassEnd = 60;
      bassDuration = 0.09;
      bassGainVal = 0.5;
    }

    // 1. Transient supersonic noise burst
    const bufferSize = Math.floor(this.ctx.sampleRate * noiseDuration);
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = (Math.random() * 2 - 1) * Math.exp(-i / (this.ctx.sampleRate * 0.015));
    }

    const whiteNoise = this.ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;

    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = isSilenced ? 'lowpass' : 'bandpass';
    noiseFilter.frequency.setValueAtTime(isSilenced ? 800 : noiseFreq, now);
    noiseFilter.Q.setValueAtTime(1.5, now);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(isSilenced ? 0.35 : 0.85, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + noiseDuration);

    whiteNoise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(dest);
    whiteNoise.start(now);

    // 2. Low-frequency kinetic punch (bass thump)
    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(bassStart, now);
    osc.frequency.exponentialRampToValueAtTime(bassEnd, now + bassDuration);

    oscGain.gain.setValueAtTime(bassGainVal, now);
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + bassDuration);

    osc.connect(oscGain);
    oscGain.connect(dest);
    osc.start(now);
    osc.stop(now + bassDuration);
  }

  /**
   * Tactical hit confirmation tick
   */
  playHitmarker(isHeadshot = false) {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    this.resume();

    const now = this.ctx.currentTime;
    const dest = this.sfxGain || this.masterGain || this.ctx.destination;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = isHeadshot ? 'triangle' : 'sine';
    const freq = isHeadshot ? 2600 : 1850;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.8, now + 0.06);

    gain.gain.setValueAtTime(isHeadshot ? 0.6 : 0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.06);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  /**
   * Dry fire empty magazine click
   */
  playEmptyClick() {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    this.resume();

    const now = this.ctx.currentTime;
    const dest = this.sfxGain || this.masterGain || this.ctx.destination;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(800, now);
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.03);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.03);
  }

  /**
   * Weapon switch mechanical unholster / bolt draw sound
   */
  playSwitch() {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    this.resume();
    const now = this.ctx.currentTime;
    this.playTone(380, 0.05, now, 0.25);
    this.playTone(520, 0.07, now + 0.05, 0.3);
  }

  /**
   * Multi-stage mechanical reload sound
   */
  playReload() {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    this.resume();

    const now = this.ctx.currentTime;

    // Mag out click (0.1s)
    this.playTone(450, 0.06, now + 0.1, 0.3);
    // Mag insert lock (0.9s)
    this.playTone(320, 0.08, now + 0.85, 0.4);
    // Bolt release slide (1.4s)
    this.playTone(650, 0.1, now + 1.35, 0.5);
  }

  playTone(freq, duration, startTime, vol = 0.3) {
    const dest = this.sfxGain || this.masterGain || this.ctx.destination;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(vol, startTime);
    gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  /**
   * Footstep acoustic tap
   */

  /**
   * Elimination confirmation chime (distinguishes body vs headshot kills)
   */
  playEliminationSound(isHeadshot = false) {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    this.resume();
    const now = this.ctx.currentTime;
    const dest = this.sfxGain || this.masterGain || this.ctx.destination;

    if (isHeadshot) {
      // High-pitched tactical glass/metallic chime
      this.playTone(1760, 0.08, now, 0.45);
      this.playTone(2640, 0.12, now + 0.06, 0.55);
      this.playTone(3520, 0.18, now + 0.12, 0.4);
    } else {
      // Powerful tactical confirmation cue
      this.playTone(660, 0.07, now, 0.4);
      this.playTone(990, 0.14, now + 0.05, 0.45);
    }
  }

  /**
   * Kill Streak & Multi-Kill heroic fanfare
   */
  playStreakSound(streakCount = 3) {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    this.resume();
    const now = this.ctx.currentTime;
    const chord = streakCount >= 5 ? [523.25, 659.25, 783.99, 1046.50] : [440, 554.37, 659.25];
    chord.forEach((freq, idx) => {
      this.playTone(freq, 0.25, now + idx * 0.06, 0.35);
    });
  }

  /**
   * Heavy kinetic hurt impact
   */
  playHurtSound() {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    this.resume();
    const now = this.ctx.currentTime;
    const dest = this.sfxGain || this.masterGain || this.ctx.destination;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 0.12);

    gain.gain.setValueAtTime(0.55, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /**
   * Low health heartbeat throb (called periodically when HP < 25)
   */
  playLowHealthHeartbeat() {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    const now = performance.now();
    if (now - this.lastHeartbeatTime < 950) return;
    this.lastHeartbeatTime = now;
    this.resume();

    const t = this.ctx.currentTime;
    const dest = this.sfxGain || this.masterGain || this.ctx.destination;

    // First lub
    const osc1 = this.ctx.createOscillator();
    const g1 = this.ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(65, t);
    osc1.frequency.exponentialRampToValueAtTime(38, t + 0.08);
    g1.gain.setValueAtTime(0.4, t);
    g1.gain.exponentialRampToValueAtTime(0.01, t + 0.08);
    osc1.connect(g1);
    g1.connect(dest);
    osc1.start(t);
    osc1.stop(t + 0.08);

    // Second dub
    const osc2 = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(55, t + 0.12);
    osc2.frequency.exponentialRampToValueAtTime(32, t + 0.22);
    g2.gain.setValueAtTime(0.35, t + 0.12);
    g2.gain.exponentialRampToValueAtTime(0.01, t + 0.22);
    osc2.connect(g2);
    g2.connect(dest);
    osc2.start(t + 0.12);
    osc2.stop(t + 0.22);
  }

  /**
   * Bullet obstacle impact (concrete thud or metallic ping)
   */
  playBulletImpact(isMetal = false) {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    this.resume();
    const now = this.ctx.currentTime;
    if (isMetal) {
      this.playTone(1800 + Math.random() * 600, 0.06, now, 0.35);
    } else {
      this.playTone(220 + Math.random() * 80, 0.04, now, 0.28);
    }
  }

  /**
   * Weapon-specific reload sequences
   */
  playWeaponReload(weaponKey = 'carbine', duration = 1.6) {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    this.resume();
    const now = this.ctx.currentTime;

    if (weaponKey === 'sniper') {
      // Bolt-action sequence: Bolt up, pull back, chamber round, bolt down
      this.playTone(420, 0.08, now + 0.15, 0.4);
      this.playTone(340, 0.10, now + 0.55, 0.45);
      this.playTone(510, 0.08, now + 1.45, 0.4);
      this.playTone(680, 0.12, now + 1.95, 0.5);
    } else if (weaponKey === 'smg') {
      // Fast mag release, rapid slap
      this.playTone(480, 0.05, now + 0.1, 0.35);
      this.playTone(560, 0.08, now + 0.65, 0.45);
      this.playTone(720, 0.09, now + 1.05, 0.4);
    } else if (weaponKey === 'pistol') {
      // Crisp slide pull and mag snap
      this.playTone(520, 0.05, now + 0.1, 0.3);
      this.playTone(600, 0.07, now + 0.6, 0.4);
      this.playTone(750, 0.08, now + 0.95, 0.45);
    } else {
      // Carbine standard 30-round mag cycle
      this.playTone(450, 0.06, now + 0.12, 0.35);
      this.playTone(380, 0.08, now + 0.85, 0.45);
      this.playTone(650, 0.10, now + 1.35, 0.5);
    }
  }

  playFootstep() {
    if (!this.initialized || !this.ctx || this.isMuted) return;
    this.resume();

    const now = this.ctx.currentTime;
    const dest = this.sfxGain || this.masterGain || this.ctx.destination;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(90 + Math.random() * 20, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.05);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.05);
  }
}

// Global audio singleton
window.gameAudio = new AudioFX();
