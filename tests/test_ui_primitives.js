'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const cssPath = path.join(root, 'assets/css/ui-primitives.css');
const fixturePath = path.join(root, 'tests/fixtures/ui-primitives/index.html');
const tokenPath = path.join(root, 'assets/css/core.css');
const css = fs.readFileSync(cssPath, 'utf8');
const html = fs.readFileSync(fixturePath, 'utf8');
const fixtureCss = fs.readFileSync(path.join(__dirname, 'fixtures/ui-primitives/fixture.css'), 'utf8');
const tokenCss = fs.readFileSync(tokenPath, 'utf8');
const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
let passed = 0;

function check(name, predicate, detail = '') {
  assert.ok(predicate, `${name}${detail ? `: ${detail}` : ''}`);
  passed += 1;
  console.log(`PASS ${name}`);
}

function classBlock(className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selector = new RegExp(`\\.ib-primitives \\.${escaped}\\s*\\{([^}]*)\\}`);
  const match = source.match(selector);
  return match ? match[1] : '';
}

function idsIn(tag) {
  const match = tag.match(/\bid="([^"]+)"/);
  return match?.[1] || '';
}

check('authority has no JS runtime', !fs.existsSync(path.join(root, 'assets/js/ui-primitives.js')));

const usedTokens = [...new Set([...source.matchAll(/var\((--ib-token-[\w-]+)/g)].map(match => match[1]))];
const declaredTokens = new Set([...tokenCss.matchAll(/(--ib-token-[\w-]+)\s*:/g)].map(match => match[1]));
check('all consumed D1 tokens are declared', usedTokens.length > 0 && usedTokens.every(token => declaredTokens.has(token)), usedTokens.filter(token => !declaredTokens.has(token)).join(', '));
check('fixture host consumes only a declared canvas token', [...fixtureCss.matchAll(/var\((--ib-token-[\w-]+)/g)].every(match => declaredTokens.has(match[1])) && /var\(--ib-token-canvas\)/.test(fixtureCss));

const hexCount = (source.match(/#[\da-f]{3,8}\b/gi) || []).length;
const rgbaCount = (source.match(/\brgba?\s*\(/gi) || []).length;
const arbitraryShadow = [...source.matchAll(/box-shadow\s*:\s*([^;}]+)/gi)]
  .map(match => match[1].trim())
  .filter(value => value !== 'none' && value !== 'var(--ib-token-elevation-none)');
const arbitraryRadius = [...source.matchAll(/border-radius\s*:\s*([^;}]+)/gi)]
  .map(match => match[1].trim())
  .filter(value => value !== '0' && !/^var\(--ib-token-radius-[\w-]+\)$/.test(value));
const arbitraryMotion = [...source.matchAll(/(?:transition(?:-duration)?|animation(?:-duration)?)\s*:\s*([^;}]+)/gi)]
  .map(match => match[1].trim())
  .filter(value => /(?:\d+(?:\.\d+)?)(?:ms|s)\b/.test(value));
const glassConsumers = (source.match(/glass|--ib-token-surface-elevated|--ib-token-popover|--ib-token-dialog/gi) || []).length;
check('new CSS raw color count is zero', hexCount === 0 && rgbaCount === 0, `hex=${hexCount}, rgba=${rgbaCount}`);
check('new CSS arbitrary shadow count is zero', arbitraryShadow.length === 0, arbitraryShadow.join(', '));
check('new CSS arbitrary radius count is zero', arbitraryRadius.length === 0, arbitraryRadius.join(', '));
check('new CSS arbitrary motion duration count is zero', arbitraryMotion.length === 0, arbitraryMotion.join(', '));
check('new CSS glass consumer count is zero', glassConsumers === 0, String(glassConsumers));

const section = classBlock('ib-section');
check('Section defaults to semantic transparency', /background\s*:\s*var\(--ib-token-surface\)/.test(section));
check('Section has no border or elevation', /border\s*:\s*0\s*;/.test(section) && /box-shadow\s*:\s*var\(--ib-token-elevation-none\)/.test(section));
check('Section hierarchy comes from spacing and typography', /\.ib-section__heading/.test(source) && /\.ib-section \+ \.ib-section/.test(source) && /--ib-token-density-standard-section-gap/.test(source));

const listRow = classBlock('ib-list-row');
check('read-only List Row is transparent and not interactive', /background\s*:\s*var\(--ib-token-surface\)/.test(listRow) && !/\.ib-list-row:hover|\.ib-list-row:active/.test(source));
check('Interactive Row uses focus, hover, pressed, selected and disabled states',
  /\.ib-primitives\s+:where\(a, button, input, select, textarea\):focus-visible/.test(source)
  && ['.ib-interactive-row:hover', '.ib-interactive-row:active', '.ib-interactive-row[aria-current="page"]', '.ib-interactive-row[aria-pressed="true"]', '.ib-interactive-row:disabled'].every(selector => source.includes(selector)));
check('Interactive Row uses native link/button elements', /<a class="ib-interactive-row"\s+href=/.test(html) && /<button class="ib-interactive-row"\s+type="button"/.test(html));
check('Interactive Row target minimum is 44 CSS px', /\.ib-interactive-row\s*\{[^}]*min-block-size\s*:\s*44px/s.test(source));
check('selected Row persists a semantic fill and accent boundary', /\.ib-interactive-row\[aria-current="page"\][\s\S]*?background\s*:\s*var\(--ib-token-surface-selected\)[\s\S]*?border-inline-start\s*:\s*2px solid var\(--ib-token-accent-action\)/.test(source));

const labels = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)];
const controls = [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)];
const labelAssociations = controls.filter(([, , attrs]) => {
  const id = idsIn(attrs);
  if (!id) return false;
  return labels.some(([, labelAttrs]) => new RegExp(`\\bfor="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(labelAttrs));
});
const describedControls = controls.filter(([, , attrs]) => /\baria-describedby="[^"]+"/.test(attrs));
const describedTargetsExist = describedControls.every(([, , attrs]) => {
  const ids = attrs.match(/\baria-describedby="([^"]+)"/)?.[1].split(/\s+/) || [];
  return ids.every(id => new RegExp(`\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(html));
});
const invalidField = html.match(/<input\b(?=[^>]*\bid="display-name")([^>]*)>/)?.[1] || '';
check('Form Group labels are programmatically associated', labelAssociations.length >= 3);
check('Form Group help/error IDs are linked to controls', describedControls.length >= 2 && describedTargetsExist);
check('invalid field links both help and error copy', /aria-invalid="true"/.test(invalidField) && /aria-describedby="display-name-help display-name-error"/.test(invalidField));
check('error state includes text and aria-invalid', /data-state="error"[\s\S]*aria-invalid="true"[\s\S]*class="ib-form-group__error"/.test(html));
check('checkbox and switch labels wrap native controls', /<label class="ib-checkbox-row">\s*<input type="checkbox"/.test(html) && /role="switch"/.test(html));
check('checkbox and switch touch rows meet 44 CSS px', /\.ib-checkbox-row\s*\{[^}]*min-block-size\s*:\s*44px/s.test(source));

const requiredStatuses = ['loading', 'running', 'syncing', 'connected', 'degraded', 'offline', 'warning', 'error', 'success', 'disabled'];
const statusEntries = [...html.matchAll(/<(?:span|p) class="ib-inline-status" data-status="([\w-]+)"[^>]*>\s*([^<]*\S[^<]*?)\s*<span class="ib-inline-status__marker" aria-hidden="true"><\/span>\s*<\/(?:span|p)>/g)];
const presentStatuses = new Set([...html.matchAll(/class="ib-inline-status" data-status="([\w-]+)"/g)].map(match => match[1]));
check('Inline Status covers all semantic states', requiredStatuses.every(status => presentStatuses.has(status)));
check('Inline Status always has readable text and a decorative marker', statusEntries.length === requiredStatuses.length && statusEntries.every(([, , body]) => body.trim().length > 0));
check('dynamic status uses the native status live-region role', /class="ib-inline-status" data-status="syncing" role="status"/.test(html));
check('fixture contains no default L3 technical metadata', !/endpoint|credentialRef|provider\s*id|request\s*id|trace|raw\s*runtime|latency/i.test(html));

check('fixture exercises Internal and Infernal theme entry', /core\.css/.test(html) && /ui-primitives\.css/.test(html) && /theme-infernal/.test(html));
check('fixture host canvas is isolated and token-backed', /fixture\.css/.test(html) && /body\.ib-primitives-fixture[\s\S]*var\(--ib-token-canvas\)/.test(fs.readFileSync(path.join(__dirname, 'fixtures/ui-primitives/fixture.css'), 'utf8')));
check('Page Header has context, title, supporting, action and L1 status slots', /class="ib-page-header"/.test(html) && /class="ib-page-header__context"/.test(html) && /class="ib-page-header__title"/.test(html) && /class="ib-page-header__supporting"/.test(html) && /class="ib-page-header__actions"/.test(html) && /class="ib-inline-status" data-status="connected"/.test(html));
check('fixture tests both decorative and semantic dividers', /class="ib-divider" aria-hidden="true"/.test(html) && /class="ib-divider" role="separator"/.test(html));
check('foundation buttons reuse .btn without a parallel family', /class="btn btn-primary"/.test(html) && !/\.ib-button|\.ib-input/.test(source) && !/class="ib-button|class="ib-input/.test(html));
check('Foundation button states and accessible icon name are represented', /data-variant="text"/.test(html) && /data-variant="destructive"/.test(html) && /data-icon-only[^>]*aria-label=/.test(html) && /aria-busy="true" disabled/.test(html) && /<button[^>]*disabled/.test(html));
check('Foundation control touch targets meet 44 CSS px', /\.ib-primitives \.btn\s*\{[^}]*min-block-size\s*:\s*44px/s.test(source) && /\.ib-form-group :where\(input:not\(\[type="checkbox"\]\), select, textarea\)\s*\{[^}]*min-block-size\s*:\s*44px/s.test(source));
check('reduced motion is explicitly respected', /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(source) && /transition\s*:\s*none/.test(source));
check('responsive composition wraps headers, actions, rows and status', /flex-wrap\s*:\s*wrap/.test(source) && /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/.test(source));
check('fixture has no production shell or route integration', !/navigation-shell|navTo\(|#app-main|data-page=/.test(html));
check('fixture marks the existing main capability boundary', /<main class="ib-app-shell__main"/.test(html) && /\.ib-app-shell__main/.test(source));
check('fixture relies on native keyboard semantics with no click-div runtime', !/\bonclick\s*=/.test(html) && !/\.ib-primitives.*\[role="button"\]/.test(source));

console.log(`UI primitive structural checks: ${passed} passed`);
