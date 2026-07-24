'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const SERVER_PATH = path.join(ROOT, 'server.js');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const MULTIPLAYER_PATH = path.join(ROOT, 'public', 'multiplayer.html');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const V55_PATH = path.join(ROOT, 'apply-server-authority-v55.js');
const V56_PATH = path.join(ROOT, 'apply-live-seat-profile-fix-v56.js');
const LEGACY_DIR = path.join(ROOT, 'legacy-patches');
const TEST_DIR = path.join(ROOT, 'tests');
const BASELINE_MARKER = 'SIVEL_CLEAN_BASELINE_V57';
const MULTIPLAYER_MARKER = 'SIVEL_CLEAN_MULTIPLAYER_V57';
const SEAT_OWNERSHIP_MARKER = 'SIVEL_V57_SEAT_ROOT_OWNERSHIP_FIX';

function fail(message) {
  throw new Error(message);
}

function requireFile(file) {
  if (!fs.existsSync(file)) fail(`Missing required file: ${path.relative(ROOT, file)}`);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.v57-tmp-${process.pid}`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, file);
}

function checkJavaScript(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) fail(result.stderr || result.stdout || `Syntax check failed: ${file}`);
}

function makeBackup(files) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(ROOT, '.v57-backup', stamp);
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const relative = path.relative(ROOT, file);
    const target = path.join(backupRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
  return backupRoot;
}

function applyCurrentRuntimePatches(serverSource, indexSource) {
  const v55 = require(V55_PATH);
  const v56 = require(V56_PATH);
  if (typeof v55.patchServer !== 'function' || typeof v55.patchIndex !== 'function') {
    fail('The V55 patch module does not expose patchServer and patchIndex.');
  }
  if (typeof v56.patchIndex !== 'function') fail('The V56 patch module does not expose patchIndex.');
  return {
    server: v55.patchServer(serverSource),
    index: v56.patchIndex(v55.patchIndex(indexSource))
  };
}

function extractEmbeddedMultiplayer(indexSource) {
  const matches = [...indexSource.matchAll(/const encoded='([A-Za-z0-9+/=]+)';/g)];
  if (matches.length !== 1) {
    fail(`Expected exactly one embedded multiplayer client, found ${matches.length}.`);
  }
  let html;
  try {
    html = Buffer.from(matches[0][1], 'base64').toString('utf8');
  } catch (error) {
    fail(`Unable to decode the embedded multiplayer client: ${error.message}`);
  }
  if (!/^\s*<!doctype html>/i.test(html) || !/<\/html>\s*$/i.test(html)) {
    fail('Decoded multiplayer client is not a complete HTML document.');
  }
  return { html, match: matches[0] };
}

function nearestContainingFunction(source, position) {
  const prefix = source.slice(0, position);
  const expression = /(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let found = null;
  for (const match of prefix.matchAll(expression)) found = match;
  if (!found) fail('Could not identify the multiplayer loader function.');
  return found;
}

function externalizeMultiplayer(indexSource) {
  const extracted = extractEmbeddedMultiplayer(indexSource);
  const encodedStart = extracted.match.index;
  const encodedEnd = encodedStart + extracted.match[0].length;
  const loader = [
    "const multiplayerTemplatePromise=fetch('/multiplayer.html',{cache:'no-store'}).then(response=>{",
    "    if(!response.ok)throw new Error(`Unable to load multiplayer client (${response.status}).`);",
    '    return response.text();',
    '  });'
  ].join('\n  ');
  let rewritten = indexSource.slice(0, encodedStart) + loader + indexSource.slice(encodedEnd);

  const decodePattern = /let\s+multiplayerHtml\s*=\s*new TextDecoder\(\)\.decode\(Uint8Array\.from\(atob\(encoded\),\s*c\s*=>\s*c\.charCodeAt\(0\)\)\);/g;
  const decodes = [...rewritten.matchAll(decodePattern)];
  if (decodes.length !== 1) fail(`Expected one embedded-client decode call, found ${decodes.length}.`);
  const decodePosition = decodes[0].index;
  const owner = nearestContainingFunction(rewritten, decodePosition);
  if (!owner[1]) {
    rewritten = rewritten.slice(0, owner.index) + 'async ' + rewritten.slice(owner.index);
  }
  rewritten = rewritten.replace(decodePattern, 'let multiplayerHtml=await multiplayerTemplatePromise;');

  if (rewritten.includes("const encoded='")) fail('Embedded multiplayer payload remains after externalization.');
  if (/atob\(encoded\)/.test(rewritten)) fail('Legacy embedded-client decoder remains after externalization.');
  if (!rewritten.includes('await multiplayerTemplatePromise')) fail('External multiplayer loader was not installed.');

  if (!rewritten.includes(BASELINE_MARKER)) {
    rewritten = rewritten.replace('</head>', `<!-- ${BASELINE_MARKER} -->\n</head>`);
  }
  const markedMultiplayer = extracted.html.includes(MULTIPLAYER_MARKER)
    ? extracted.html
    : extracted.html.replace(/<!doctype html>/i, `<!doctype html>\n<!-- ${MULTIPLAYER_MARKER} -->`);
  const multiplayer = fixMultiplayerSeatOwnership(markedMultiplayer);
  return { index: rewritten, multiplayer };
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0) fail(`V57 seat ownership fix could not find ${label}.`);
  if (first !== last) fail(`V57 seat ownership fix found multiple copies of ${label}.`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function fixMultiplayerSeatOwnership(source) {
  if (source.includes(SEAT_OWNERSHIP_MARKER)) return source;

  source = replaceExactlyOnce(
    source,
    "function renderStableMultiplayerSeats(assignments,g){\n  const container=$('seats');if(!container)return;\n  const desired=new Set();",
    "function renderStableMultiplayerSeats(assignments,g){\n  const container=$('seats');if(!container)return;\n  /* " + SEAT_OWNERSHIP_MARKER + ": active-hand rendering exclusively owns direct table-seat nodes. */\n  const ownedRoots=new Set(Array.from(sivelStableSeatNodes.values(),function(record){return record&&record.root}).filter(Boolean));\n  Array.from(container.children||[]).forEach(function(node){\n    if(node.classList&&node.classList.contains('seat')&&!ownedRoots.has(node))node.remove();\n  });\n  const desired=new Set();",
    'stable multiplayer seat renderer'
  );

  source = replaceExactlyOnce(
    source,
    "  $('seats').innerHTML=assignments.map(({p,slot})=>",
    "  sivelStableSeatNodes.forEach(function(record){if(record&&record.root){try{record.root.remove()}catch(_err){}}});\n  sivelStableSeatNodes.clear();\n  $('seats').innerHTML=assignments.map(({p,slot,originalIndex})=>",
    'public waiting-table seat renderer'
  );

  source = replaceExactlyOnce(
    source,
    "<div class=\"seat slot-${slot} ${p.isSelf?'self-seat':''} ${!p.connected?'disconnected':''}\">",
    "<div class=\"seat slot-${slot} ${p.isSelf?'self-seat':''} ${!p.connected?'disconnected':''}\" data-player-index=\"${originalIndex}\">",
    'waiting-table seat element'
  );

  return source;
}

function cleanServerVersion(serverSource) {
  let result = serverSource;
  result = result.replace(
    "version: 'server-authority-v55', authority: 'server'",
    "version: 'clean-baseline-v57', baseline: 'V57', authority: 'server'"
  );
  if (!result.includes('clean-baseline-v57')) {
    result = `// ${BASELINE_MARKER}\n` + result;
  }
  return result;
}

function buildPackage(existing) {
  const pkg = JSON.parse(existing);
  pkg.version = '2.1.1';
  pkg.description = 'Sivel Poker clean V57 baseline with persistent accounts and server-authoritative multiplayer poker.';
  pkg.sivelBaseline = 'V57';
  pkg.scripts = {
    start: 'node server.js',
    test: 'node --check server.js && node --check account-store.js && node --test tests/v57-baseline.test.js',
    'verify:v57': 'node --test tests/v57-baseline.test.js'
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function archiveLegacyPatches() {
  fs.mkdirSync(LEGACY_DIR, { recursive: true });
  for (const file of [V55_PATH, V56_PATH]) {
    if (!fs.existsSync(file)) continue;
    const target = path.join(LEGACY_DIR, path.basename(file));
    if (fs.existsSync(target)) fs.unlinkSync(file);
    else fs.renameSync(file, target);
  }
  const note = `# Legacy runtime patches\n\nThese scripts produced the V55/V56 behavior that was permanently baked into the clean V57 source baseline. They are retained for audit and rollback only and are not executed by npm start.\n`;
  writeAtomic(path.join(LEGACY_DIR, 'README.md'), note);
}

function writeBaselineTest() {
  const test = `'use strict';\n\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst vm = require('node:vm');\n\nconst ROOT = path.resolve(__dirname, '..');\nconst read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');\n\ntest('V57 starts the server without runtime patch scripts', () => {\n  const pkg = JSON.parse(read('package.json'));\n  assert.equal(pkg.sivelBaseline, 'V57');\n  assert.equal(pkg.scripts.start, 'node server.js');\n  assert.doesNotMatch(pkg.scripts.start, /apply-|patch/i);\n});\n\ntest('multiplayer client is external and readable', () => {\n  const index = read('public/index.html');\n  const multiplayer = read('public/multiplayer.html');\n  assert.match(index, /${BASELINE_MARKER}/);\n  assert.match(index, /multiplayerTemplatePromise/);\n  assert.doesNotMatch(index, /const encoded='/);\n  assert.doesNotMatch(index, /atob\\(encoded\\)/);\n  assert.match(multiplayer, /${MULTIPLAYER_MARKER}/);\n  assert.match(multiplayer, /SIVEL_SERVER_AUTHORITY_CLIENT_V55/);\n  assert.match(multiplayer, /SIVEL_PUBLIC_SEAT_PROFILE_STABILITY_V56/);\n  assert.match(multiplayer, /SIVEL_V57_SEAT_ROOT_OWNERSHIP_FIX/);\n  assert.ok(multiplayer.includes('!ownedRoots.has(node)'));\n  assert.ok(multiplayer.includes('sivelStableSeatNodes.clear()'));\n  assert.ok(multiplayer.includes('data-player-index=\"\${originalIndex}\"'));\n  assert.match(multiplayer, /<\\/html>\\s*$/i);\n});\n\ntest('inline multiplayer scripts parse', () => {\n  const multiplayer = read('public/multiplayer.html');\n  const scripts = [...multiplayer.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(match => match[1]);\n  assert.ok(scripts.length > 0);\n  for (const [index, source] of scripts.entries()) {\n    assert.doesNotThrow(() => new vm.Script(source, { filename: 'multiplayer-inline-' + index + '.js' }));\n  }\n});\n\ntest('server contains the authoritative V57 baseline', () => {\n  const server = read('server.js');\n  assert.match(server, /clean-baseline-v57|${BASELINE_MARKER}/);\n  assert.match(server, /turnId/);\n  assert.match(server, /server/);\n});\n`;
  fs.mkdirSync(TEST_DIR, { recursive: true });
  writeAtomic(path.join(TEST_DIR, 'v57-baseline.test.js'), test);
}

function writeBaselineNotes() {
  const notes = `# Sivel Poker V57 clean baseline\n\nV57 permanently bakes the confirmed V55 server-authority work and the V56 public-seat profile stability fix into normal source files.\n\n## Structural changes\n\n- \`npm start\` now runs only \`node server.js\`.\n- The multiplayer client is a readable file at \`public/multiplayer.html\`.\n- \`public/index.html\` loads that client template instead of storing a large base64 payload.\n- V55/V56 scripts are retained under \`legacy-patches/\` for audit and rollback only.\n- \`npm test\` includes V57 regression checks.\n\n## Preserved behavior\n\n- Server-owned turn timers, hand IDs and turn IDs.\n- Strict check, call and raise validation.\n- Public-table auto play, top-ups and all-in runouts.\n- Clickable opponent profiles.\n- One stable identity card per occupied live-table seat.\n- Visible local-player profile and chip count.\n- Ghost-seat cleanup.\n- Waiting-table seats cannot survive into active hands as duplicate profiles.\n\n## Next development rule\n\nEdit \`server.js\`, \`public/index.html\` and \`public/multiplayer.html\` directly. Do not add another startup patch script.\n`;
  writeAtomic(path.join(ROOT, 'V57_BASELINE.md'), notes);
}

function updateGitignore() {
  const file = path.join(ROOT, '.gitignore');
  const existing = fs.existsSync(file) ? read(file) : '';
  if (!existing.split(/\r?\n/).includes('.v57-backup/')) {
    writeAtomic(file, existing.replace(/\s*$/, '') + '\n.v57-backup/\n');
  }
}

function verifyOutputs() {
  requireFile(SERVER_PATH);
  requireFile(INDEX_PATH);
  requireFile(MULTIPLAYER_PATH);
  requireFile(PACKAGE_PATH);
  checkJavaScript(SERVER_PATH);
  checkJavaScript(path.join(ROOT, 'account-store.js'));
  checkJavaScript(__filename);
  const result = spawnSync(process.execPath, ['--test', path.join(TEST_DIR, 'v57-baseline.test.js')], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (result.status !== 0) fail(result.stderr || result.stdout || 'V57 regression tests failed.');
  process.stdout.write(result.stdout);
}

function main() {
  requireFile(SERVER_PATH);
  requireFile(INDEX_PATH);
  requireFile(PACKAGE_PATH);

  if (read(INDEX_PATH).includes(BASELINE_MARKER) && fs.existsSync(MULTIPLAYER_PATH)) {
    console.log('V57 clean baseline is already installed; verifying it now.');
    verifyOutputs();
    return;
  }

  requireFile(V55_PATH);
  requireFile(V56_PATH);
  const backup = makeBackup([SERVER_PATH, INDEX_PATH, PACKAGE_PATH, V55_PATH, V56_PATH]);
  console.log(`Backup created at ${path.relative(ROOT, backup)}`);

  const originalServer = read(SERVER_PATH);
  const originalIndex = read(INDEX_PATH);
  const current = applyCurrentRuntimePatches(originalServer, originalIndex);
  const external = externalizeMultiplayer(current.index);
  const packageContent = buildPackage(read(PACKAGE_PATH));

  writeAtomic(SERVER_PATH, cleanServerVersion(current.server));
  writeAtomic(INDEX_PATH, external.index);
  writeAtomic(MULTIPLAYER_PATH, external.multiplayer);
  writeAtomic(PACKAGE_PATH, packageContent);
  writeBaselineTest();
  writeBaselineNotes();
  updateGitignore();
  archiveLegacyPatches();
  verifyOutputs();

  console.log('Sivel Poker V57 clean baseline built successfully.');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`V57 migration failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  extractEmbeddedMultiplayer,
  externalizeMultiplayer,
  nearestContainingFunction,
  buildPackage,
  cleanServerVersion,
  fixMultiplayerSeatOwnership
};
