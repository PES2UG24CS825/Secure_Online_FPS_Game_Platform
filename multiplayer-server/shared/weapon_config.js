/**
 * SecureFPS: Shared Weapon Configuration
 * Authoritative definition of weapons, damages, fire rates, multipliers, and ballistics.
 * Compatible with Node.js (CommonJS) and browser globals / modules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WeaponConfig = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WEAPONS = {
    carbine: {
      id: 'carbine',
      name: 'P-24 Carbine',
      caliber: '5.56x45mm NATO',
      slot: 1,
      damage: 25,
      headshotMultiplier: 2.0,
      fireRate: 0.13, // ~460 RPM
      bulletSpeed: 240,
      range: 160,
      tracerColor: 0xffb703,
      tracerLength: 0.65,
      tracerRadius: 0.016,
      magSize: 30,
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
      headshotMultiplier: 2.0,
      fireRate: 0.09, // ~665 RPM
      bulletSpeed: 175,
      range: 110,
      tracerColor: 0xffaa00,
      tracerLength: 0.45,
      tracerRadius: 0.014,
      magSize: 35,
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
      fireRate: 1.25, // bolt-action ~48 RPM
      bulletSpeed: 420,
      range: 300,
      tracerColor: 0x00f0ff,
      tracerLength: 1.2,
      tracerRadius: 0.022,
      magSize: 5,
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
      fireRate: 0.18, // semi-auto ~330 RPM
      bulletSpeed: 150,
      range: 90,
      tracerColor: 0xffd166,
      tracerLength: 0.35,
      tracerRadius: 0.013,
      magSize: 17,
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

  function getWeapon(key) {
    if (!key || typeof key !== 'string') return WEAPONS.carbine;
    const clean = key.trim().toLowerCase();
    return WEAPONS[clean] || WEAPONS.carbine;
  }

  function isValidWeapon(key) {
    if (!key || typeof key !== 'string') return false;
    return Object.prototype.hasOwnProperty.call(WEAPONS, key.trim().toLowerCase());
  }

  /**
   * Minimum allowable milliseconds between shots for server anti-rapid-fire check.
   * Tolerates up to 15% network jitter buffer.
   */
  function minFireIntervalMs(key) {
    const w = getWeapon(key);
    return Math.floor(w.fireRate * 1000 * 0.85);
  }

  function computeDamage(weaponKey, isHeadshot) {
    const w = getWeapon(weaponKey);
    const damage = Math.round(isHeadshot ? (w.damage * w.headshotMultiplier) : w.damage);
    return {
      damage: Math.max(1, damage),
      headshot: !!isHeadshot,
      weaponName: w.name
    };
  }

  return {
    WEAPONS,
    getWeapon,
    isValidWeapon,
    minFireIntervalMs,
    computeDamage
  };
}));
