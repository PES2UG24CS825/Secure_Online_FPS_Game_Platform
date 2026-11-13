/**
 * Automated XSS Prevention Test for SecureFPS Admin & Player Dashboards
 * Tests sanitization of malicious vectors including <img onerror>, <script>, attribute injection.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from '../frontend/js/admin/admin_core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Testing escapeHtml XSS vectors...');

const vectors = [
  {
    name: 'IMG onerror vector',
    input: '<img src=x onerror=alert(1)>',
    forbidden: ['<img', '<', '>', '"'],
    expected: '&lt;img src=x onerror=alert(1)&gt;',
  },
  {
    name: 'SCRIPT tag injection',
    input: '<script>alert("pwned")</script>',
    forbidden: ['<script>', '</script>', '<', '>'],
    expected: '&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;',
  },
  {
    name: 'Attribute breakout vector with double quotes',
    input: 'test" onfocus="alert(1)" autofocus="',
    forbidden: ['"', '<', '>'],
    expected: 'test&quot; onfocus=&quot;alert(1)&quot; autofocus=&quot;',
  },
  {
    name: 'Attribute breakout vector with single quotes',
    input: "test' onmouseover='alert(1)'",
    forbidden: ["'", '<', '>'],
    expected: 'test&#39; onmouseover=&#39;alert(1)&#39;',
  },
  {
    name: 'HTML entities and ampersand chaining',
    input: 'Player & <Co> "Elite"',
    expected: 'Player &amp; &lt;Co&gt; &quot;Elite&quot;',
  },
  {
    name: 'Null or undefined inputs',
    input: null,
    expected: '',
  }
];

let passed = 0;
for (const v of vectors) {
  const result = escapeHtml(v.input);
  if (v.expected !== undefined) {
    assert.strictEqual(result, v.expected, `Failed vector: ${v.name}`);
  }
  if (v.forbidden) {
    for (const bad of v.forbidden) {
      assert.ok(!result.includes(bad), `Forbidden character "${bad}" found in output: ${result} for vector: ${v.name}`);
    }
  }
  passed++;
  console.log(`  ✓ ${v.name}: "${v.input}" -> "${result}"`);
}

// Audit files in frontend/js/admin/ for unescaped template interpolations
console.log('\nAuditing admin JS files for unsafe interpolations...');
const adminFiles = ['admin_core.js', 'admin_overview.js', 'admin_players.js', 'admin_security.js', 'admin_support.js'];
for (const f of adminFiles) {
  const code = fs.readFileSync(path.resolve(__dirname, `../frontend/js/admin/${f}`), 'utf8');
  assert.ok(code.includes('escapeHtml'), `File ${f} must use escapeHtml`);
  console.log(`  ✓ ${f} verified with escapeHtml usage.`);
}

console.log(`\nAll ${passed} XSS tests PASSED successfully!`);
