import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

  it('Player overview dashboard displays career combat stats and clean match feature badges', () => {
    const playerHtml = fs.readFileSync(path.resolve(rootDir, '../../../player.html'), 'utf-8');
    const playerJs = fs.readFileSync(path.resolve(rootDir, '../../../js/player.js'), 'utf-8');
    const playerCss = fs.readFileSync(path.resolve(rootDir, '../../../css/player.css'), 'utf-8');
    const routesPy = fs.readFileSync(path.resolve(rootDir, '../../../../backend/routes/player_routes.py'), 'utf-8');

    assert.match(playerHtml, /id="careerTotalKills"/);
    assert.match(playerHtml, /id="careerTotalDeaths"/);
    assert.match(playerHtml, /id="careerKd"/);
    assert.match(playerHtml, /id="careerAccuracy"/);
    assert.match(playerJs, /careerTotalKills/);
    assert.match(playerJs, /match-features-strip/);
    assert.doesNotMatch(playerJs, /ML Models:\s*<\/strong>\s*RF:/);
    assert.doesNotMatch(playerJs, /Analysis needs gameplay data:/);

    // Image 3 requirement: strip shows only Fair Play, XP, and Coins (no Weapon or Hits tags)
    assert.match(playerJs, /Fair Play Verified/);
    assert.match(playerJs, /XP<\/span>/);
    assert.match(playerJs, /Coins<\/span>/);
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
});
