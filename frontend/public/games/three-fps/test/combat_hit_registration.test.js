const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

describe('Combat & Hit Registration Verification', () => {
  it('hitbox material must NOT use visible: false (so Raycaster can intersect it)', () => {
    const code = fs.readFileSync(path.join(rootDir, 'js/TacticalOperator.js'), 'utf-8');
    assert.match(code, /transparent:\s*true/);
    assert.match(code, /opacity:\s*0/);
    assert.doesNotMatch(code, /hitMat\s*=\s*new\s*THREE\.MeshBasicMaterial\(\{\s*visible:\s*false/);
  });

  it('dev model notice banner is hidden and suppressed', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
    const css = fs.readFileSync(path.join(rootDir, 'css/game.css'), 'utf-8');
    const opJs = fs.readFileSync(path.join(rootDir, 'js/TacticalOperator.js'), 'utf-8');
    
    assert.match(html, /id="dev-model-notice-banner"[^>]*display:\s*none/);
    assert.match(css, /#dev-model-notice-banner[\s\S]*display:\s*none\s*!important/);
    assert.match(opJs, /noticeBanner\.style\.display\s*=\s*['"]none['"]/);
  });

  it('Weapons.js ignores FX particles, tracers, and UI sprites during combat raycasting', () => {
    const code = fs.readFileSync(path.join(rootDir, 'js/Weapons.js'), 'utf-8');
    assert.match(code, /isFX/);
    assert.match(code, /isUI/);
    assert.match(code, /isSprite/);
  });

  it('Weapons and shared config initialize valid numeric magAmmo and reserveAmmo', () => {
    const configCode = fs.readFileSync(path.join(rootDir, 'js/shared/weapon_config.js'), 'utf-8');
    const wepCode = fs.readFileSync(path.join(rootDir, 'js/Weapons.js'), 'utf-8');
    assert.match(configCode, /magAmmo:\s*30/);
    assert.match(configCode, /magAmmo:\s*35/);
    assert.match(configCode, /magAmmo:\s*5/);
    assert.match(configCode, /magAmmo:\s*17/);
    assert.match(wepCode, /wep\.magAmmo\s*=\s*wep\.magSize/);
  });

  it('Game Hub in player.html has removed quick-launch features and only displays games', () => {
    const html = fs.readFileSync(path.resolve(rootDir, '../../../player.html'), 'utf-8');
    assert.doesNotMatch(html, /class="quick-launch-strip"/);
    assert.match(html, /<h2>FPS Training Arenas<\/h2>/);
    assert.match(html, /CyberStrike 3D/);
    assert.match(html, /FPS Microgame/);
  });

  it('Weapons.js prevents firing and damage after player death', () => {
    const wepCode = fs.readFileSync(path.join(rootDir, 'js/Weapons.js'), 'utf-8');
    assert.match(wepCode, /isPlayerAlive\(\)/);
    assert.match(wepCode, /if\s*\(!this\.isPlayerAlive\(\)\)\s*\{\s*this\.isFiring\s*=\s*false;\s*return;\s*\}/);
  });

  it('BotManager.js implements penetration resolution and anti-stuck wall sliding', () => {
    const botCode = fs.readFileSync(path.join(rootDir, 'js/BotManager.js'), 'utf-8');
    assert.match(botCode, /resolvePenetration\(\)/);
    assert.match(botCode, /this\.resolvePenetration\(\)/);
  });

  it('Match completion displays total shots, hits landed, and accuracy calculation transparency', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
    const mainJs = fs.readFileSync(path.join(rootDir, 'js/main.js'), 'utf-8');
    assert.match(html, /id="mc-shots"/);
    assert.match(html, /id="mc-hits"/);
    assert.match(mainJs, /setEl\('mc-shots'/);
    assert.match(mainJs, /setEl\('mc-hits'/);
  });

  it('Player overview dashboard stays compact and match details keep clean feature badges', () => {
    const playerHtml = fs.readFileSync(path.resolve(rootDir, '../../../player.html'), 'utf-8');
    const playerJs = fs.readFileSync(path.resolve(rootDir, '../../../js/player.js'), 'utf-8');
    const playerCss = fs.readFileSync(path.resolve(rootDir, '../../../css/player.css'), 'utf-8');
    const routesPy = fs.readFileSync(path.resolve(rootDir, '../../../../backend/routes/player_routes.py'), 'utf-8');

    assert.match(playerHtml, /id="matchesCount"/);
    assert.match(playerHtml, /id="accountStatus"/);
    assert.match(playerHtml, /id="mfaStatus"/);
    assert.doesNotMatch(playerHtml, /careerTotalKills|careerTotalDeaths|careerKd|careerAccuracy/);
    assert.match(playerJs, /match-features-strip/);
    assert.doesNotMatch(playerJs, /ML Models:\s*<\/strong>\s*RF:/);
    assert.doesNotMatch(playerJs, /Analysis needs gameplay data:/);

    // Image 3 requirement: strip shows only Fair Play, XP, and Coins (no Weapon or Hits tags)
    assert.match(playerJs, /Fair Play Verified/);
    assert.match(playerJs, /rewardText/);
    assert.doesNotMatch(playerJs, /xpEarned\s*=|coinsEarned\s*=/);
    assert.match(playerJs, /reward_credit/);
    assert.doesNotMatch(playerJs, /🎯 Weapon:/);

    // Accuracy stat box displays only percentage without total shots in card
    assert.match(playerJs, /const accuracyStr = match\.accuracy == null \? "—" : `\$\{Number\(match\.accuracy\)\.toFixed\(1\)\}%`;/);

    // Useful rewards store
    assert.match(routesPy, /Recoil Compensator/);
    assert.match(routesPy, /Tactical Extended Mags/);

    // Equippable skins and banners in reward store
    assert.match(routesPy, /skin_valkyrie_void/);
    assert.match(routesPy, /skin_ghost_specops/);
    assert.match(routesPy, /banner_cyber_metropolis/);
    assert.match(routesPy, /banner_orbital_bastion/);
    assert.match(routesPy, /profile_customization\.avatar/);
    assert.match(routesPy, /profile_customization\.banner/);
    assert.match(routesPy, /"hidden":\s*True/);

    // Purple featured center styling for CyberStrike and sidebar navigation
    assert.match(playerCss, /cyberstrike-card-theme/);
    assert.match(playerCss, /#7c3aed/i);
    assert.match(playerCss, /linear-gradient\(135deg,\s*#7c3aed/i);
    assert.match(playerCss, /reward-filter-pill/);
  });

  it('BotManager prevents elevation floating and checks full diagonal step collision', () => {
    const botCode = fs.readFileSync(path.join(rootDir, 'js/BotManager.js'), 'utf-8');
    assert.match(botCode, /this\.position\.y\s*=\s*0\.0;/);
    assert.match(botCode, /!this\.checkCollisionAt\(nextX,\s*nextZ\)/);
    assert.match(botCode, /hasLineOfSight\(targetPos\)/);
  });

  it('rigged head hitboxes follow skeletal bones and difficulty caps active bots', () => {
    const opCode = fs.readFileSync(path.join(rootDir, 'js/TacticalOperator.js'), 'utf-8');
    const botCode = fs.readFileSync(path.join(rootDir, 'js/BotManager.js'), 'utf-8');
    assert.match(opCode, /this\.headBone\.add\(this\.headMesh\)/);
    assert.match(opCode, /root\.updateMatrixWorld\(true\)/);
    assert.match(botCode, /diff\s*===\s*['"]easy['"]\s*\?\s*2/);
    assert.match(botCode, /diff\s*===\s*['"]normal['"]\s*\?\s*3\s*:\s*4/);
  });

  it('multiplayer hit confirmations update hit and headshot telemetry', () => {
    const mpCode = fs.readFileSync(path.join(rootDir, 'js/MultiplayerClient.js'), 'utf-8');
    const serverCode = fs.readFileSync(path.resolve(rootDir, '../../../../multiplayer-server/server.js'), 'utf-8');
    assert.match(mpCode, /new CustomEvent\(['"]fps:telemetry_hit['"]/);
    assert.match(serverCode, /playerState\.headshots\s*=\s*\(playerState\.headshots\s*\|\|\s*0\)\s*\+\s*1/);
  });

  it('risk calculation is evidence-capped and Settings is removed from player navigation', () => {
    const riskCode = fs.readFileSync(path.resolve(rootDir, '../../../../backend/services/anti_cheat_intelligence.py'), 'utf-8');
    const playerHtml = fs.readFileSync(path.resolve(rootDir, '../../../player.html'), 'utf-8');
    assert.match(riskCode, /calibrated_risk\s*=\s*min\(raw_risk,\s*39\.0\)/);
    assert.doesNotMatch(playerHtml, /href="#settings"|id="settings"|Player Settings/);
  });

  it('keeps profile banners separate from the shared Sakura dashboard artwork', () => {
    const playerJs = fs.readFileSync(path.resolve(rootDir, '../../../js/player.js'), 'utf-8');
    const sharedCss = fs.readFileSync(path.resolve(rootDir, '../../../css/ui-polish.css'), 'utf-8');
    assert.match(playerJs, /getElementById\("profileBanner"\)/);
    assert.doesNotMatch(playerJs, /overviewBanner/);
    assert.doesNotMatch(playerJs, /body\.dataset\.playerBanner|--player-scene-image/);
    assert.match(sharedCss, /SecureFPS_Sakura_Anime_Background\.png/);
  });

  it('multiplayer weapons use balanced ammo, realistic viewmodel materials, and health-only armour HUD', () => {
    const weaponCode = fs.readFileSync(path.join(rootDir, 'js/Weapons.js'), 'utf-8');
    const sharedCode = fs.readFileSync(path.join(rootDir, 'js/shared/weapon_config.js'), 'utf-8');
    const modeCode = fs.readFileSync(path.join(rootDir, 'js/GameModeManager.js'), 'utf-8');
    assert.match(sharedCode, /reserveAmmo:\s*180/);
    assert.match(sharedCode, /fireRate:\s*0\.13/);
    assert.match(weaponCode, /weaponRoot\.scale\.setScalar\(0\.88\)/);
    assert.match(weaponCode, /color:\s*0x252a31/);
    assert.match(modeCode, /armourCard\.style\.display\s*=\s*this\.currentMode\s*===\s*['"]multiplayer['"]/);
  });

  it('sidebars use the original logo lockup and sticky player topbar is opaque', () => {
    const playerHtml = fs.readFileSync(path.resolve(rootDir, '../../../player.html'), 'utf-8');
    const adminHtml = fs.readFileSync(path.resolve(rootDir, '../../../admin.html'), 'utf-8');
    const playerCss = fs.readFileSync(path.resolve(rootDir, '../../../css/player.css'), 'utf-8');
    const adminCss = fs.readFileSync(path.resolve(rootDir, '../../../css/admin.css'), 'utf-8');
    assert.match(playerHtml, /securefps-logo-crop\.png/);
    assert.match(adminHtml, /securefps-logo-crop\.png/);
    assert.match(playerHtml, /sidebar-logo-lockup/);
    assert.match(adminHtml, /sidebar-logo-lockup/);
    assert.match(playerCss, /\.player-topbar\s*\{\s*display:\s*none/);
    assert.match(adminCss, /admin-sidebar \.brand-lockup\s*\{\s*display:none/);
  });

  it('prevents overlapping bot spawns and hides inactive bots with clean matchmaking admission fallback', () => {
    const botCode = fs.readFileSync(path.join(rootDir, 'js/BotManager.js'), 'utf-8');
    const wepCode = fs.readFileSync(path.join(rootDir, 'js/Weapons.js'), 'utf-8');
    const serverCode = fs.readFileSync(path.resolve(rootDir, '../../../../multiplayer-server/server.js'), 'utf-8');
    const gameRoutes = fs.readFileSync(path.resolve(rootDir, '../../../../backend/routes/game_routes.py'), 'utf-8');

    // Bot spawns must be distinct across bots
    assert.match(botCode, /index\s*\*\s*2\)\s*%\s*TACTICAL_SPAWN_POINTS\.length/);
    // Inactive bots displaced far away so they never block raycasts or linger in arena
    assert.match(botCode, /bot\.position\.set\(0,\s*-999,\s*0\)/);
    // Weapons.js initializes camPos before notifyGunshot
    assert.match(wepCode, /const\s+camPos\s*=\s*new\s+THREE\.Vector3\(\);[\s\S]*notifyGunshot\(playerPos\)/);
    // Server has matchmaking policy dev fallback
    assert.match(serverCode, /ALLOW_ANONYMOUS\s*\|\|\s*process\.env\.NODE_ENV\s*!==\s*['"]production['"]/);
    // Internal request authentication must use only the configured secret.
    assert.doesNotMatch(gameRoutes, /fallback_(secret|sig)\s*=/);
  });
});
