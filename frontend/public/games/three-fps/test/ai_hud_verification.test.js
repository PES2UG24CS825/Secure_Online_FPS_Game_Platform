/**
 * SecureFPS: Three.js FPS Game AI, Tactical Operator & HUD Automated Test Suite
 * Verifies:
 * 1. Bot profiles dataset integrity & empirical human distributions
 * 2. TacticalOperator character rig & weapon visibility
 * 3. BotManager concurrent engagement, audio-visual feedback, and role routes
 * 4. HUD compact match panel & developer overlay F3 toggle state
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BASE_DIR = path.resolve(__dirname, '..');

describe('Task 1 - Characters & Procedural Articulated Rig', () => {
  const opSrc = fs.readFileSync(path.join(BASE_DIR, 'js/TacticalOperator.js'), 'utf8');

  it('1a: includes binary corruption check (glTF magic & 0xEF 0xBF 0xBD detection)', () => {
    assert.ok(opSrc.includes('0xef') && opSrc.includes('0xbf') && opSrc.includes('0xbd'),
      'TacticalOperator must detect UTF-8 replacement byte corruption');
    assert.ok(opSrc.includes('glTF') || opSrc.includes('0x46546c67'),
      'TacticalOperator must check glTF magic header');
  });

  it('1b: builds articulated anatomical rig with pivots for limbs', () => {
    assert.ok(opSrc.includes('rShoulderGroup') && opSrc.includes('lShoulderGroup'),
      'Must contain articulated shoulder pivot groups');
    assert.ok(opSrc.includes('rElbowGroup') && opSrc.includes('lElbowGroup'),
      'Must contain articulated elbow pivot groups');
    assert.ok(opSrc.includes('rHipGroup') && opSrc.includes('lHipGroup'),
      'Must contain articulated hip pivot groups');
    assert.ok(opSrc.includes('rKneeGroup') && opSrc.includes('lKneeGroup'),
      'Must contain articulated knee pivot groups');
    assert.ok(opSrc.includes('armor') && opSrc.includes('boots'),
      'Must include tactical armor/plates and combat boots');
  });

  it('1c: visible weapons in hands with two-handed grip and firing effects', () => {
    assert.ok(opSrc.includes('weaponSocket') && opSrc.includes('buildWeaponModel'),
      'Must contain weapon socket and procedural weapon factory');
    assert.ok(opSrc.includes('muzzleSprite') && opSrc.includes('muzzleLight'),
      'Must render muzzle flash light and sprite');
    assert.ok(opSrc.includes('activeShells') || opSrc.includes('ejectShell'),
      'Must support brass shell ejection');
    assert.ok(opSrc.includes('weaponRecoilOffset') || opSrc.includes('weaponRecoilPitch'),
      'Must support weapon recoil kick animation');
  });

  it('1d: supports multiple weapon archetypes (carbine, smg, sniper, pistol)', () => {
    assert.ok(opSrc.includes("case 'carbine':") || opSrc.includes("carbine"), 'Supports carbine');
    assert.ok(opSrc.includes("case 'smg':") || opSrc.includes("smg"), 'Supports SMG');
    assert.ok(opSrc.includes("case 'sniper':") || opSrc.includes("sniper"), 'Supports sniper');
    assert.ok(opSrc.includes("case 'pistol':") || opSrc.includes("pistol"), 'Supports pistol');
  });

  it('1e: human tactical operator features (skin tone, face contours, ballistic sunglasses, rolled sleeves, MultiCam)', () => {
    assert.ok(opSrc.includes('createHumanFaceTexture'), 'Must generate procedural human face texture');
    assert.ok(opSrc.includes('createMulticamTexture'), 'Must generate procedural MultiCam camo texture');
    assert.ok(opSrc.includes('sunglassesLens') && opSrc.includes('sunglassesFrame'), 'Must include tactical ballistic sunglasses');
    assert.ok(opSrc.includes('rCuff') && opSrc.includes('lCuff'), 'Must include rolled-up combat shirt sleeves');
    assert.ok(opSrc.includes('rForearmGeo') && opSrc.includes('materials.skin'), 'Forearms must show human skin tone');
    assert.ok(opSrc.includes('watchBand') || opSrc.includes('watchFace'), 'Must feature tactical field watch');
  });
});

describe('Task 2 - Game AI & Dataset-Driven Bots', () => {
  const profilesPath = path.join(BASE_DIR, 'data/bot_profiles.json');
  const botSrc = fs.readFileSync(path.join(BASE_DIR, 'js/BotManager.js'), 'utf8');

  it('2a: bot_profiles.json is generated from human dataset with 64 personas across 3 skill bands', () => {
    assert.ok(fs.existsSync(profilesPath), 'bot_profiles.json must exist');
    const data = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    assert.strictEqual(data.personas.length, 64, 'Must have exactly 64 personas');
    assert.ok(data.difficulty_bands.easy.length >= 20, 'Easy band must have >= 20 personas');
    assert.ok(data.difficulty_bands.normal.length >= 20, 'Normal band must have >= 20 personas');
    assert.ok(data.difficulty_bands.hard.length >= 20, 'Hard band must have >= 20 personas');

    data.personas.forEach(p => {
      assert.ok(p.reaction_time_ms >= 150, `Reaction time ${p.reaction_time_ms}ms must be >= 150ms`);
      assert.ok(p.accuracy_pct >= 10 && p.accuracy_pct <= 90, `Accuracy ${p.accuracy_pct}% in range`);
      assert.ok(p.movement_speed_ms > 0, 'Movement speed must be positive');
      assert.ok(['flanker', 'marksman', 'pointman', 'scout'].includes(p.role), 'Valid role');
    });
  });

  it('2b: BotManager removes artificial token cap and enables concurrent attacks with reaction delay', () => {
    assert.ok(!botSrc.includes('this.activeAttackers.length >='), 'Token bottleneck must be removed');
    assert.ok(botSrc.includes('reaction_time_ms') || botSrc.includes('reactionDelay'),
      'Bot must use reaction delay from persona');
    assert.ok(botSrc.includes('strafeDir') && (botSrc.includes('strafeTimer') || botSrc.includes('combatStrafe')),
      'Bots must execute combat strafing while firing');
  });

  it('2c: full audio-visual feedback (muzzle flash, gunshot audio, tracers, whiz-by)', () => {
    assert.ok(botSrc.includes('playPositionalGunshot'), 'Must trigger 3D positional gunshot audio');
    assert.ok(botSrc.includes('playBulletWhiz'), 'Must trigger bullet whiz-by crack');
    assert.ok(botSrc.includes('activeBotTracers') || botSrc.includes('updateTracers'), 'Must generate visible ballistic tracers');
    assert.ok(botSrc.includes('triggerShoot'), 'Must trigger operator firing effects and muzzle flash');
  });

  it('2d: role-based routes, weapons, gunshot hearing, and FFA rival targeting', () => {
    assert.ok(botSrc.includes('notifyGunshot'), 'Supports gunshot hearing alerts');
    assert.ok(botSrc.includes('flanker') && botSrc.includes('marksman') && botSrc.includes('pointman') && botSrc.includes('scout'),
      'All 4 tactical roles defined');
    assert.ok(botSrc.includes('lookAroundTimer') || botSrc.includes('headYaw'),
      'Bots look around and scan environment when idle/patrolling');
    assert.ok(botSrc.includes('rival'),
      'Bots target closest rival bot in Free-For-All');
  });
});

describe('Task 3 - HUD, UI & Menus', () => {
  const html = fs.readFileSync(path.join(BASE_DIR, 'index.html'), 'utf8');
  const hudSrc = fs.readFileSync(path.join(BASE_DIR, 'js/HUD.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(BASE_DIR, 'js/main.js'), 'utf8');
  const ctrlSrc = fs.readFileSync(path.join(BASE_DIR, 'js/Controller.js'), 'utf8');

  it('3a: compact top-center match panel with dynamic mode, player count, kills, timer, and ping', () => {
    assert.ok(html.includes('id="compact-match-panel"'), 'Compact match panel element must exist');
    assert.ok(html.includes('id="hud-mode-tag"'), 'Mode tag element must exist');
    assert.ok(html.includes('id="match-player-count"'), 'Player count element must exist');
    assert.ok(html.includes('id="match-kills"'), 'Match kills element must exist');
    assert.ok(html.includes('id="match-timer"'), 'Match timer element must exist');
    assert.ok(html.includes('id="match-ping"'), 'Match ping element must exist');
    assert.ok(hudSrc.includes('updateMatchHeader'), 'HUD.js must provide updateMatchHeader method');
  });

  it('3b: developer overlay hidden by default and toggled via F3', () => {
    assert.ok(ctrlSrc.includes('this.debugVisible = false;'), 'debugVisible must default to false');
    assert.ok(html.includes('hud-stats-panel dev-overlay-element') && html.includes('style="display: none;"'),
      'hud-stats-panel must have dev-overlay-element and display: none');
    assert.ok(html.includes('input-debug-hud dev-overlay-element') && html.includes('style="display: none;"'),
      'input-debug-hud must have dev-overlay-element and display: none');
    assert.ok(ctrlSrc.includes('toggleDebugHUD') && ctrlSrc.includes('.dev-overlay-element'),
      'toggleDebugHUD must toggle .dev-overlay-element');
    assert.ok(html.includes('id="clean-fps-badge"'), 'Clean minimal FPS badge must exist');
  });

  it('3c: removes placeholder text (Ghost_01, 14ms, 12:00, 100/100 honour)', () => {
    assert.ok(!html.includes('value="Ghost_01"'), 'Ghost_01 placeholder must be removed from HTML input');
    assert.ok(mainSrc.includes('Operator_'), 'main.js generates dynamic Operator_### callsign');
    assert.ok(!html.includes('>14ms<'), 'Static 14ms ping placeholder removed');
    assert.ok(!html.includes('100/100 (+5 MATCH COMPLETED)'), 'Static match completed honour placeholder removed');
  });

  it('3d: menu clarifies Free Roam vs VS Tactical Bots', () => {
    assert.ok(html.includes('FREE ROAM'), 'Menu tab must display FREE ROAM');
    assert.ok(html.includes('VS TACTICAL BOTS'), 'Menu tab must display VS TACTICAL BOTS');
    assert.ok(mainSrc.includes("mode === 'solo'") && mainSrc.includes("botManager.setEnabled(false)"),
      'Free roam mode must disable hostile bots');
  });
});

it('keeps the authoritative spawn position and preserves the offline default', () => {
  const vm = require('node:vm');
  const managerSource = fs.readFileSync(path.join(BASE_DIR, 'js/GameModeManager.js'), 'utf8');
  class Vector3 {
    constructor(x, y, z) {
      Object.assign(this, { x, y, z });
    }
  }
  const Manager = vm.runInNewContext(managerSource + '\nGameModeManager;', {
    THREE: { Vector3 },
    window: {}
  });
  const manager = Object.assign(Object.create(Manager.prototype), {
    matchActive: true,
    updateHUD() {},
    updateSpawnProtectionHUD() {}
  });
  const respawns = [];
  const controller = {
    respawn(position) { respawns.push(position); },
    resetKeys() {},
    requestLock() {}
  };

  const serverSpawn = new Vector3(14, 0, -12);
  manager.respawnPlayer(controller, serverSpawn);
  manager.respawnPlayer(controller);
  manager.isMatchCompleted = true;
  manager.respawnPlayer(controller, serverSpawn);

  assert.strictEqual(respawns[0], serverSpawn);
  assert.deepStrictEqual(respawns[1], new Vector3(0, 1.8, 28));
  assert.strictEqual(respawns.length, 2);
});
