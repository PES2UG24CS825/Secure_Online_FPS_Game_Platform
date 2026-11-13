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
});
