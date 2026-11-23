const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootDir = path.resolve(__dirname, '..');
const readGameFile = (name) => fs.readFileSync(path.join(rootDir, 'js', name), 'utf8');

function createGameMode() {
  const listeners = new Map();
  const dispatched = [];
  const context = {
    document: {
      getElementById: () => null,
      exitPointerLock: () => {},
    },
    window: {
      SecureFPSGame: {},
      addEventListener: (name, callback) => listeners.set(name, callback),
      dispatchEvent: (event) => dispatched.push(event),
    },
    sessionStorage: { getItem: () => null },
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    console: { log: () => {} },
  };
  vm.runInNewContext(`${readGameFile('GameModeManager.js')}\nthis.GameModeManager = GameModeManager;`, context);
  return {
    manager: new context.GameModeManager(null),
    listeners,
    dispatched,
    context,
  };
}

describe('Gameplay regression checks', () => {
  it('blocks Bot Combat and Training targets behind nearer scenery', () => {
    const weaponsSource = readGameFile('Weapons.js');
    const context = { window: {} };
    vm.runInNewContext(
      `${weaponsSource}\nthis.findBlockingSceneryHit = findBlockingSceneryHit;`,
      context,
    );
    const isUsable = () => true;
    const isCombatObject = (object) => object.isCombatObject;
    const wall = { distance: 3, object: { isCombatObject: false } };

    for (const targetType of ['bot', 'training']) {
      const target = { distance: 5, object: { isCombatObject: true, targetType } };
      assert.equal(
        context.findBlockingSceneryHit(target, [wall, target], isUsable, isCombatObject),
        wall,
        `${targetType} target must be occluded`,
      );
    }

    const behindTargetScenery = { distance: 6, object: { isCombatObject: false } };
    assert.equal(
      context.findBlockingSceneryHit(
        { distance: 5, object: { isCombatObject: true } },
        [behindTargetScenery],
        isUsable,
        isCombatObject,
      ),
      null,
      'scenery behind the target must not block it',
    );
  });

  it('freezes local timers, damage, and target progression while paused', () => {
    const { manager, listeners, context } = createGameMode();
    manager.setMode('bots');
    manager.startMatch();
    manager.hasSpawnProtection = false;
    const before = manager.timeRemaining;
    const health = manager.playerHealth;
    context.window.SecureFPSGame.isPaused = true;

    manager.update(3, null);
    manager.damagePlayer(25, 'Viper-01', null);
    listeners.get('fps:kill')({ detail: { victim: 'Viper-01' } });

    assert.equal(manager.timeRemaining, before);
    assert.equal(manager.playerHealth, health);
    assert.equal(manager.kills, 0);

    context.window.SecureFPSGame.isPaused = false;
    manager.update(3, null);
    assert.equal(manager.timeRemaining, before - 3);
  });

  it('counts multiplayer combat only once per server-confirmed shot', () => {
    const { manager, listeners } = createGameMode();
    manager.setMode('multiplayer', 480);
    manager.startMatch();

    const fire = listeners.get('fps:telemetry_fire');
    const hit = listeners.get('fps:telemetry_hit');
    fire({ detail: { shot_id: 'server-shot-1' } });
    fire({ detail: { shot_id: 'server-shot-1' } });
    fire({ detail: { shot_id: 'server-shot-2' } });
    hit({ detail: { shot_id: 'unconfirmed-shot', headshot: true } });
    hit({ detail: { shot_id: 'server-shot-1', headshot: true } });
    hit({ detail: { shot_id: 'server-shot-1', headshot: true } });

    assert.equal(manager.shotsFired, 2);
    assert.equal(manager.shotsHit, 1);
    assert.equal(manager.headshots, 1);
  });

  it('completes Bot Combat by score or timeout and resets a rematch', () => {
    const { manager, listeners, dispatched } = createGameMode();
    manager.setMode('bots');
    manager.startMatch();
    assert.equal(manager.matchDuration, 480);
    assert.equal(manager.targetKills, 10);

    const kill = listeners.get('fps:kill');
    for (let index = 0; index < 10; index += 1) {
      kill({ detail: { victim: 'Viper-01' } });
    }
    assert.equal(manager.isMatchCompleted, true);
    assert.equal(dispatched.at(-1)?.detail?.reason, 'score_limit_reached');

    manager.setMode('bots');
    manager.startMatch();
    assert.equal(manager.kills, 0);
    assert.equal(manager.deaths, 0);
    assert.equal(manager.shotsFired, 0);
    assert.equal(manager.playerHealth, 100);
    assert.equal(manager.hasSpawnProtection, true);

    manager.update(480, null);
    assert.equal(manager.isMatchCompleted, true);
    assert.equal(dispatched.at(-1)?.detail?.reason, 'time_expired');
  });

  it('restarts local matches with reset bots, ammo, stats, timer, and telemetry', () => {
    const mainSource = readGameFile('main.js');
    assert.match(mainSource, /window\.SecureFPSGame\.deployLocalMatch\s*=\s*deployLocalMatch/);
    assert.match(mainSource, /botManager\.resetAllBots/);
    assert.match(mainSource, /weapons\?\.resetForMatch\(\)/);
    assert.match(mainSource, /gameMode\.startMatch\(\)/);
    assert.match(mainSource, /telemetry\.startSession\(mode/);
    assert.match(mainSource, /await window\.SecureFPSGame\.deployLocalMatch\?\.\(gameMode\.currentMode,\s*gameMode\.difficulty\)/);
  });

  it('preserves multiplayer state while reconnecting and keeps the new limits visible', () => {
    const clientSource = readGameFile('MultiplayerClient.js');
    const mainSource = readGameFile('main.js');
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');

    assert.match(clientSource, /fps:game_reconnected/);
    assert.match(mainSource, /gameMode\.matchActive\s*=\s*true/);
    assert.match(mainSource, /controller\.position\.set\(localPlayer\.x,\s*localPlayer\.y,\s*localPlayer\.z\)/);
    assert.match(mainSource, /telemetry\.resumeSession\(\)/);
    assert.match(mainSource, /gameMode\.targetKills\s*=\s*Number\(snapshot\.scoreLimit\)\s*\|\|\s*10/);
    assert.match(html, /First to 10 kills wins; otherwise the match ends at 08:00/);
    assert.match(html, /matches end at 10 kills or 08:00/i);
  });

  it('uses active bots, current ping, and one K/D calculation for every scoreboard row', () => {
    const mainSource = readGameFile('main.js');
    assert.match(mainSource, /if\s*\(!b\.isActive\)\s*return/);
    assert.match(mainSource, /multiplayer\?\.currentPing/);
    assert.match(mainSource, /const kd = formatKD\(kills,\s*deaths\)/);
    assert.match(mainSource, /const pKd = formatKD\(pKills,\s*pDeaths\)/);
  });
});
