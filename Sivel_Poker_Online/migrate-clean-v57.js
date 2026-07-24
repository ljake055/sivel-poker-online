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
const PUBLIC_ROSTER_MARKER = 'SIVEL_V57_PUBLIC_ROSTER_DUPLICATE_FIX';
const ACTION_DOCK_MARKER = 'SIVEL_V57_PLAYER_CONSOLE_V60';

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
  const multiplayer = installMultiplayerActionDock(fixMultiplayerSeatOwnership(markedMultiplayer));
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

  source = replaceExactlyOnce(
    source,
    "function renderGame(){showScreen('gameScreen');RoomMusic.start",
    "function renderGame(){showScreen('gameScreen');const sivelGameScreen=document.getElementById('gameScreen');if(sivelGameScreen)sivelGameScreen.classList.toggle('sivel-public-live',!!(state&&state.isPublic));RoomMusic.start",
    'active public-table class initialization'
  );

  source = replaceExactlyOnce(
    source,
    "$('gamePlayers').innerHTML=activePlayerRows+publicSideInviteRows(activeOpenSeats);",
    "/* " + PUBLIC_ROSTER_MARKER + ": public live-table identities exist only at their poker seats. */$('gamePlayers').innerHTML=state.isPublic?'':activePlayerRows+publicSideInviteRows(activeOpenSeats);",
    'active public-table roster rendering'
  );

  return source;
}


function installMultiplayerActionDock(source) {
  const stylePatterns = [
    /\n*<style id="sivel-in-table-action-dock-v58">[\s\S]*?<\/style>/g,
    /\n*<style id="sivel-split-table-controls-v59">[\s\S]*?<\/style>/g,
    /\n*<style id="sivel-player-console-v60">[\s\S]*?<\/style>/g
  ];
  const runtimePatterns = [
    /\n*<script id="sivel-in-table-action-dock-runtime-v58">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-split-table-controls-runtime-v59">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-player-console-runtime-v60">[\s\S]*?<\/script>/g
  ];
  for (const pattern of stylePatterns.concat(runtimePatterns)) source = source.replace(pattern, '');

  if (!source.includes('window.SivelGetTableState=()=>state;')) {
    const stateMatches = [...source.matchAll(/let\s+state\s*=\s*[^;]+;/g)];
    if (stateMatches.length !== 1) fail(`V60 player console expected one multiplayer state declaration, found ${stateMatches.length}.`);
    source = source.replace(/let\s+state\s*=\s*[^;]+;/, match => `${match}\nwindow.SivelGetTableState=()=>state;`);
  }

  const style = `
<style id="sivel-player-console-v60">
/* ${ACTION_DOCK_MARKER} — curved player console keeps the hero identity, board and pot unobstructed. */
#gameScreen.sivel-action-dock-screen{min-height:0}
#gameScreen.sivel-action-dock-screen .table-wrap{position:relative;min-height:0}
.controls.sivel-controls-relocated{display:none!important}
.sivel-table-utility-panel{margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.07)}
.sivel-table-utility-panel .table-tools{margin:0!important}
.sivel-table-utility-panel .host-row{margin-top:9px!important}

/* Restore the original casino-table geometry. Only the board group is reordered so the pot sits beneath it. */
#tableStage.sivel-action-console-active .poker-table.sivel-casino-table{
  left:5.8%!important;right:5.8%!important;top:20.5%!important;bottom:10.5%!important
}
#tableStage.sivel-action-console-active .center{
  top:49%!important;display:flex!important;flex-direction:column!important;align-items:center!important;
  width:57%!important
}
#tableStage.sivel-action-console-active .center:before{
  content:'';display:block;order:0;width:1px;height:32px;flex:0 0 32px;pointer-events:none
}
#tableStage.sivel-action-console-active .center .board{
  order:1;margin:0!important;transform:none!important
}
#tableStage.sivel-action-console-active .center .pot{
  order:2;position:relative!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;
  display:inline-flex!important;margin:7px auto 0!important;transform:scale(.72)!important;transform-origin:top center!important;
  z-index:14!important;white-space:nowrap!important;pointer-events:none!important
}
#tableStage.sivel-action-console-active .center>.sivel-table-status-spacer{
  position:absolute!important;visibility:hidden!important;pointer-events:none!important
}
#tableStage.sivel-action-console-active .seat.self-seat{
  bottom:10px!important;z-index:94!important
}
#tableStage.sivel-action-console-active .seat.slot-lower-left,
#tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:184px!important}

.sivel-player-console{position:absolute;inset:0;z-index:90;pointer-events:none;--console-edge:2.2%;--console-inner:20%}
.sivel-action-orbit{position:absolute;inset:0;pointer-events:none}
.sivel-action-orbit .action-btn{
  position:absolute!important;bottom:14px;z-index:4;min-width:0!important;width:116px!important;height:53px!important;
  padding:7px 10px!important;border-radius:20px!important;font-size:11px!important;font-weight:950!important;
  letter-spacing:.025em!important;pointer-events:auto!important;box-shadow:0 11px 24px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.12)!important;
  transition:transform .15s ease,filter .15s ease,border-color .15s ease!important
}
.sivel-action-orbit #foldBtn{
  left:var(--console-edge);transform:rotate(-6deg);border-radius:28px 15px 21px 30px!important;
  background:linear-gradient(180deg,#4a2029,#241017)!important;border:1px solid #82404d!important;color:#ffd1d6!important
}
.sivel-action-orbit #callBtn{
  left:var(--console-inner);bottom:51px;transform:rotate(-2.5deg);border-radius:25px 22px 14px 28px!important;
  background:linear-gradient(180deg,#1d513d,#0c281e)!important;border:1px solid #3b8a68!important;color:#caffdf!important
}
.sivel-action-orbit #raiseBtn{
  right:var(--console-inner);bottom:51px;width:128px!important;transform:rotate(2.5deg);border-radius:22px 25px 28px 14px!important;
  background:linear-gradient(180deg,#f0d589,#c78e2f 64%,#9c641d)!important;border:1px solid #f0ce78!important;color:#231606!important
}
.sivel-action-orbit .sivel-all-in{
  right:var(--console-edge);transform:rotate(6deg);border-radius:15px 28px 30px 21px!important;
  background:linear-gradient(180deg,#df672e,#831f16 72%,#4c0e0b)!important;border:1px solid #f09b49!important;color:#fff2d9!important
}
.sivel-action-orbit #foldBtn:hover:not(:disabled){transform:rotate(-6deg) translateY(-3px)!important}
.sivel-action-orbit #callBtn:hover:not(:disabled){transform:rotate(-2.5deg) translateY(-3px)!important}
.sivel-action-orbit #raiseBtn:hover:not(:disabled){transform:rotate(2.5deg) translateY(-3px)!important}
.sivel-action-orbit .sivel-all-in:hover:not(:disabled){transform:rotate(6deg) translateY(-3px)!important}
.sivel-action-orbit .action-btn:disabled{opacity:.31!important;filter:saturate(.42)!important;cursor:not-allowed!important}

.sivel-size-chip{
  position:absolute;z-index:3;bottom:102px;width:68px;height:27px;padding:0 5px;border:1px solid rgba(96,132,160,.54);
  clip-path:polygon(11% 0,89% 0,100% 50%,89% 100%,11% 100%,0 50%);
  background:linear-gradient(180deg,rgba(25,43,59,.98),rgba(8,18,27,.98));color:#b9cad7;
  font-size:7px;font-weight:950;letter-spacing:.075em;cursor:pointer;pointer-events:auto;
  box-shadow:0 7px 15px rgba(0,0,0,.37),inset 0 1px 0 rgba(255,255,255,.06)
}
.sivel-size-chip[data-size="min"]{left:4%;bottom:76px;transform:rotate(-7deg)}
.sivel-size-chip[data-size="half"]{left:15%;bottom:112px;transform:rotate(-3deg)}
.sivel-size-chip[data-size="pot"]{right:15%;bottom:112px;transform:rotate(3deg)}
.sivel-size-chip[data-size="max"]{right:4%;bottom:76px;transform:rotate(7deg)}
.sivel-size-chip:hover:not(:disabled){border-color:#e1bf65;color:#ffe5a0;filter:brightness(1.1)}
.sivel-size-chip:disabled{opacity:.27;cursor:not-allowed}

/* The center table column can be narrow even on a wide desktop because of the two side panels. */
.sivel-player-console.sivel-console-narrow{--console-edge:1.4%;--console-inner:13%}
.sivel-player-console.sivel-console-narrow .sivel-action-orbit .action-btn{width:94px!important;height:48px!important;font-size:9px!important}
.sivel-player-console.sivel-console-narrow .sivel-action-orbit #raiseBtn{width:104px!important}
.sivel-player-console.sivel-console-narrow .sivel-action-orbit #callBtn,
.sivel-player-console.sivel-console-narrow .sivel-action-orbit #raiseBtn{bottom:48px}
.sivel-player-console.sivel-console-narrow .sivel-size-chip{width:57px;height:25px;font-size:6px}
.sivel-player-console.sivel-console-narrow .sivel-size-chip[data-size="half"]{left:17%}
.sivel-player-console.sivel-console-narrow .sivel-size-chip[data-size="pot"]{right:17%}

.sivel-size-toggle{
  position:absolute;left:50%;bottom:163px;z-index:5;transform:translateX(-50%);width:154px;height:34px;
  display:flex;align-items:center;justify-content:center;gap:8px;padding:0 12px;border-radius:999px;
  border:1px solid rgba(224,188,98,.58);background:linear-gradient(180deg,rgba(27,38,48,.98),rgba(7,14,21,.985));
  color:#d8e4ec;box-shadow:0 10px 23px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.08);
  pointer-events:auto;cursor:pointer
}
.sivel-size-toggle small{font-size:6px;font-weight:950;letter-spacing:.14em;color:#7e94a6}
.sivel-size-toggle strong{font-size:13px;color:#f2d27d;font-variant-numeric:tabular-nums}
.sivel-size-toggle span{font-size:10px;color:#8fa3b4;transition:transform .15s ease}
.sivel-size-toggle[aria-expanded="true"] span{transform:rotate(180deg)}
.sivel-size-toggle:disabled{opacity:.35;cursor:not-allowed}

.sivel-sizing-popover{
  position:absolute;left:50%;bottom:202px;z-index:8;transform:translateX(-50%) translateY(8px) scale(.97);
  width:min(340px,calc(100% - 28px));padding:8px;border-radius:15px;border:1px solid rgba(90,126,154,.58);
  background:linear-gradient(180deg,rgba(15,28,40,.985),rgba(5,12,18,.99));
  box-shadow:0 18px 42px rgba(0,0,0,.58),inset 0 1px 0 rgba(255,255,255,.06);
  opacity:0;visibility:hidden;pointer-events:none;transition:opacity .14s ease,transform .14s ease,visibility .14s ease
}
.sivel-sizing-popover.sivel-open{opacity:1;visibility:visible;pointer-events:auto;transform:translateX(-50%) translateY(0) scale(1)}
.sivel-sizing-popover .raise-box{
  display:grid!important;grid-template-columns:minmax(0,1fr) 76px!important;gap:7px!important;width:100%!important;
  min-height:38px!important;padding:5px 7px!important;margin:0!important;border:0!important;border-radius:10px!important;
  background:rgba(3,10,16,.56)!important;box-shadow:none!important
}
.sivel-sizing-popover .raise-box input[type="range"]{width:100%;margin:0!important;align-self:center}
.sivel-sizing-popover .raise-total{min-width:0!important;display:flex!important;flex-direction:column!important;align-items:flex-end!important;justify-content:center!important;line-height:1!important}
.sivel-sizing-popover .raise-total small{font-size:6px!important;color:#72899a!important}
.sivel-sizing-popover .raise-total strong{font-size:14px!important;color:#f2d17b!important}

.sivel-table-status-panel{
  margin-top:10px;padding:9px 10px;border-radius:12px;border:1px solid rgba(77,111,138,.42);
  background:linear-gradient(180deg,rgba(11,24,35,.96),rgba(5,13,20,.98));box-shadow:inset 0 1px 0 rgba(255,255,255,.04)
}
.sivel-table-status-panel small{display:block;font-size:7px;font-weight:950;letter-spacing:.16em;color:#71899c;margin-bottom:4px}
.sivel-table-status-panel strong{display:block;color:#c7d6e0;font-size:10px;line-height:1.35}
.sivel-player-console #gameStatus{display:none!important}
.sivel-player-console.sivel-console-waiting .sivel-action-orbit,
.sivel-player-console.sivel-console-waiting .sivel-size-toggle,
.sivel-player-console.sivel-console-waiting .sivel-sizing-popover{display:none!important}
.sivel-player-console.sivel-console-waiting #gameStatus{
  display:flex!important;position:absolute!important;left:50%!important;top:50%!important;right:auto!important;bottom:auto!important;
  transform:translate(-50%,-50%)!important;width:min(520px,calc(100% - 30px))!important;min-height:42px!important;
  align-items:center!important;justify-content:center!important;margin:0!important;padding:9px 13px!important;border-radius:13px!important;
  background:rgba(4,9,14,.82)!important;border:1px solid rgba(255,255,255,.08)!important;color:#d7e1e9!important;
  font-size:12px!important;line-height:1.4!important;text-align:center!important;pointer-events:none!important
}

@media(min-width:1181px){
  #gameScreen.sivel-action-dock-screen{height:100vh;overflow:hidden}
  #gameScreen.sivel-action-dock-screen>.shell{height:100%;display:flex;flex-direction:column;padding-top:10px;padding-bottom:12px}
  #gameScreen.sivel-action-dock-screen .topbar{flex:0 0 auto}
  #gameScreen.sivel-action-dock-screen .game-layout{flex:1;min-height:0;margin-top:10px;align-items:stretch}
  #gameScreen.sivel-action-dock-screen .table-wrap{height:100%;display:flex;min-height:0}
  #gameScreen.sivel-action-dock-screen #tableStage{height:100%!important;min-height:590px;flex:1 1 auto;width:100%}
  #gameScreen.sivel-action-dock-screen .side-panel{height:100%;min-height:0!important;overflow:auto}
}
@media(max-width:900px) and (min-width:761px){
  .sivel-player-console{--console-edge:1.5%;--console-inner:18%}
  .sivel-action-orbit .action-btn{width:108px!important;height:49px!important;font-size:10px!important}
  .sivel-action-orbit #raiseBtn{width:118px!important}
  .sivel-size-toggle{bottom:158px}
  .sivel-sizing-popover{bottom:197px}
  #tableStage.sivel-action-console-active .seat.slot-lower-left,
  #tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:126px!important}
}
@media(max-width:760px){
  #tableStage.sivel-action-console-active .center{top:49%!important;width:88%!important}
  #tableStage.sivel-action-console-active .center:before{height:28px;flex-basis:28px}
  #tableStage.sivel-action-console-active .center .pot{margin-top:5px!important;transform:scale(.68)!important}
  #tableStage.sivel-action-console-active .seat.self-seat{bottom:142px!important}
  #tableStage.sivel-action-console-active .seat.slot-lower-left,
  #tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:214px!important}
  .sivel-action-orbit{left:7px;right:7px;bottom:7px;top:auto;height:55px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}
  .sivel-action-orbit .action-btn,
  .sivel-action-orbit #foldBtn,.sivel-action-orbit #callBtn,.sivel-action-orbit #raiseBtn,.sivel-action-orbit .sivel-all-in{
    position:relative!important;inset:auto!important;bottom:auto!important;right:auto!important;left:auto!important;transform:none!important;
    width:auto!important;height:47px!important;border-radius:13px!important;font-size:9px!important
  }
  .sivel-size-chip{display:none!important}
  .sivel-size-toggle{bottom:69px;width:145px;height:31px}
  .sivel-sizing-popover{bottom:104px}
}
@media(max-width:620px){
  #tableStage.sivel-action-console-active .seat.self-seat{bottom:188px!important}
  #tableStage.sivel-action-console-active .seat.slot-lower-left,
  #tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:252px!important}
  .sivel-action-orbit{height:94px;grid-template-columns:repeat(2,1fr);grid-template-rows:repeat(2,42px)}
  .sivel-action-orbit .action-btn,
  .sivel-action-orbit #foldBtn,.sivel-action-orbit #callBtn,.sivel-action-orbit #raiseBtn,.sivel-action-orbit .sivel-all-in{height:42px!important}
  .sivel-size-toggle{bottom:107px}
  .sivel-sizing-popover{bottom:142px}
}
</style>`;

  const runtime = `
<script id="sivel-player-console-runtime-v60">
(function(){
  'use strict';
  function initSivelActionDock(){
    const screen=document.getElementById('gameScreen');
    const stage=document.getElementById('tableStage');
    const controls=screen&&screen.querySelector('.controls');
    const actionRow=controls&&controls.querySelector('.action-row');
    const status=document.getElementById('gameStatus');
    const slider=document.getElementById('raiseSlider');
    const raiseTotal=document.getElementById('raiseTotal');
    const raiseBox=actionRow&&actionRow.querySelector('.raise-box');
    const foldBtn=document.getElementById('foldBtn');
    const callBtn=document.getElementById('callBtn');
    const raiseBtn=document.getElementById('raiseBtn');
    if(!screen||!stage||!controls||!actionRow||!status||!slider||!raiseTotal||!raiseBox||!foldBtn||!callBtn||!raiseBtn)return;
    if(document.getElementById('sivelActionDock'))return;

    const consoleRoot=document.createElement('section');
    consoleRoot.id='sivelActionDock';
    consoleRoot.className='sivel-player-console sivel-console-waiting';
    consoleRoot.setAttribute('aria-label','Poker action controls');
    consoleRoot.innerHTML='<div class="sivel-action-orbit"></div><button type="button" class="sivel-size-toggle" id="sivelSizeToggle" aria-expanded="false"><small>BET SIZE</small><strong id="sivelSizeAmount">—</strong><span>⌃</span></button><div class="sivel-sizing-popover" id="sivelSizingPopover"></div>';
    consoleRoot.appendChild(status);

    const orbit=consoleRoot.querySelector('.sivel-action-orbit');
    orbit.appendChild(foldBtn);
    orbit.appendChild(callBtn);
    orbit.appendChild(raiseBtn);

    const allIn=document.createElement('button');
    allIn.type='button';
    allIn.id='sivelAllInBtn';
    allIn.className='action-btn sivel-all-in';
    allIn.textContent='All-In';
    orbit.appendChild(allIn);

    const quick=document.createElement('div');
    quick.className='sivel-quick-orbit';
    quick.innerHTML='<button type="button" class="sivel-size-chip" data-size="min">MIN</button><button type="button" class="sivel-size-chip" data-size="half">½ POT</button><button type="button" class="sivel-size-chip" data-size="pot">POT</button><button type="button" class="sivel-size-chip" data-size="max">MAX</button>';
    Array.from(quick.children).forEach(function(button){orbit.appendChild(button)});

    const popover=consoleRoot.querySelector('#sivelSizingPopover');
    popover.appendChild(raiseBox);
    const sizeToggle=consoleRoot.querySelector('#sivelSizeToggle');
    const sizeAmount=consoleRoot.querySelector('#sivelSizeAmount');

    const utilityHost=document.createElement('div');
    utilityHost.className='sivel-table-utility-panel';
    const tableTools=document.getElementById('tableTools');
    const hostRow=controls.querySelector('.host-row');
    if(tableTools)utilityHost.appendChild(tableTools);
    if(hostRow)utilityHost.appendChild(hostRow);
    const rightPanel=screen.querySelector('.game-right');
    if(rightPanel&&(tableTools||hostRow))rightPanel.appendChild(utilityHost);

    let statusMirror=null;
    if(rightPanel){
      const statusPanel=document.createElement('div');
      statusPanel.className='sivel-table-status-panel';
      statusPanel.innerHTML='<small>TABLE ACTION</small><strong id="sivelStatusMirror">Waiting for the table.</strong>';
      const chat=rightPanel.querySelector('.chat-shell');
      if(chat)rightPanel.insertBefore(statusPanel,chat);else rightPanel.appendChild(statusPanel);
      statusMirror=statusPanel.querySelector('#sivelStatusMirror');
    }

    controls.classList.add('sivel-controls-relocated');
    stage.appendChild(consoleRoot);

    const quickButtons=Array.from(orbit.querySelectorAll('[data-size]'));
    let syncQueued=false;

    function tableState(){
      try{return typeof window.SivelGetTableState==='function'?window.SivelGetTableState():null}
      catch(_error){return null}
    }
    function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0}
    function format(value){return Math.max(0,Math.round(number(value))).toLocaleString()}
    function limits(data){
      const legal=data&&data.legal||{};
      return{min:number(legal.minRaiseTotal||slider.min),max:number(legal.maxRaiseTotal||slider.max)};
    }
    function setRaiseTarget(value){
      const data=tableState(),range=limits(data);
      if(!(range.max>0))return;
      const step=Math.max(1,number(data&&data.options&&data.options.smallBlind)||number(slider.step)||1);
      let target=Math.round(number(value)/step)*step;
      target=Math.max(range.min,Math.min(range.max,target));
      slider.value=String(target);
      slider.dispatchEvent(new Event('input',{bubbles:true}));
      scheduleSync();
    }
    function sizingTarget(kind){
      const data=tableState(),game=data&&data.game||{},legal=data&&data.legal||{},range=limits(data);
      const self=(data&&Array.isArray(data.players)?data.players:[]).find(function(player){return player&&player.isSelf})||{};
      const streetBet=number(self.streetBet),toCall=number(legal.toCall),pot=number(game.pot);
      if(kind==='min')return range.min;
      if(kind==='max')return range.max;
      return streetBet+toCall+(pot+toCall)*(kind==='half'?.5:1);
    }
    function setPopover(open){
      const allowed=!sizeToggle.disabled;
      const next=!!open&&allowed;
      popover.classList.toggle('sivel-open',next);
      sizeToggle.setAttribute('aria-expanded',next?'true':'false');
    }
    function sync(){
      syncQueued=false;
      const data=tableState(),game=data&&data.game,legal=data&&data.legal||{};
      const playing=!!(data&&data.stage==='playing'&&game);
      screen.classList.toggle('sivel-action-dock-screen',playing);
      stage.classList.toggle('sivel-action-console-active',playing);
      document.body.classList.toggle('sivel-table-play-mode',playing);
      consoleRoot.classList.toggle('sivel-console-waiting',!playing);
      consoleRoot.classList.toggle('sivel-console-narrow',playing&&stage.getBoundingClientRect().width<760&&window.innerWidth>760);
      const range=limits(data),current=number(slider.value);
      const canRaise=playing&&!!legal.canAct&&!!legal.canRaise&&range.max>=range.min&&range.max>0;
      quickButtons.forEach(function(button){button.disabled=!canRaise});
      allIn.disabled=!canRaise;
      sizeToggle.disabled=!canRaise;
      if(!canRaise)setPopover(false);
      if(sizeAmount)sizeAmount.textContent=current?format(current):'—';
      if(statusMirror)statusMirror.textContent=status.textContent||'Waiting for the table.';
    }
    function scheduleSync(){
      if(syncQueued)return;
      syncQueued=true;
      (window.requestAnimationFrame||setTimeout)(sync);
    }

    orbit.addEventListener('click',function(event){
      const button=event.target&&event.target.closest?event.target.closest('[data-size]'):null;
      if(!button||button.disabled)return;
      setRaiseTarget(sizingTarget(button.dataset.size));
    });
    sizeToggle.addEventListener('click',function(event){event.stopPropagation();setPopover(!popover.classList.contains('sivel-open'))});
    popover.addEventListener('click',function(event){event.stopPropagation()});
    document.addEventListener('click',function(){setPopover(false)});
    document.addEventListener('keydown',function(event){if(event.key==='Escape')setPopover(false)});
    allIn.addEventListener('click',function(){
      if(allIn.disabled)return;
      const data=tableState(),range=limits(data);
      setRaiseTarget(range.max);
      requestAnimationFrame(function(){if(!raiseBtn.disabled)raiseBtn.click()});
    });
    slider.addEventListener('input',scheduleSync);
    const observer=new MutationObserver(scheduleSync);
    observer.observe(screen,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','class','value']});
    window.addEventListener('resize',scheduleSync);
    setInterval(scheduleSync,350);
    sync();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initSivelActionDock,{once:true});
  else initSivelActionDock();
})();
</script>`;

  if (!source.includes('</head>') || !source.includes('</body>')) {
    fail('V60 player console could not find the multiplayer document boundaries.');
  }
  source = source.replace('</head>', style + '\n</head>');
  source = source.replace('</body>', runtime + '\n</body>');
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
  pkg.version = '2.2.2';
  pkg.description = 'Sivel Poker clean V57 baseline with a curved professional player console.';
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
  const test = `'use strict';\n\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst vm = require('node:vm');\n\nconst ROOT = path.resolve(__dirname, '..');\nconst read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');\n\ntest('V57 starts the server without runtime patch scripts', () => {\n  const pkg = JSON.parse(read('package.json'));\n  assert.equal(pkg.sivelBaseline, 'V57');\n  assert.equal(pkg.scripts.start, 'node server.js');\n  assert.doesNotMatch(pkg.scripts.start, /apply-|patch/i);\n});\n\ntest('multiplayer client is external and readable', () => {\n  const index = read('public/index.html');\n  const multiplayer = read('public/multiplayer.html');\n  assert.match(index, /${BASELINE_MARKER}/);\n  assert.match(index, /multiplayerTemplatePromise/);\n  assert.doesNotMatch(index, /const encoded='/);\n  assert.doesNotMatch(index, /atob\\(encoded\\)/);\n  assert.match(multiplayer, /${MULTIPLAYER_MARKER}/);\n  assert.match(multiplayer, /SIVEL_SERVER_AUTHORITY_CLIENT_V55/);\n  assert.match(multiplayer, /SIVEL_PUBLIC_SEAT_PROFILE_STABILITY_V56/);\n  assert.match(multiplayer, /SIVEL_V57_SEAT_ROOT_OWNERSHIP_FIX/);\n  assert.ok(multiplayer.includes('!ownedRoots.has(node)'));\n  assert.ok(multiplayer.includes('sivelStableSeatNodes.clear()'));\n  assert.ok(multiplayer.includes('data-player-index=\"\${originalIndex}\"'));
  assert.match(multiplayer, /SIVEL_V57_PUBLIC_ROSTER_DUPLICATE_FIX/);
  assert.ok(multiplayer.includes("$('gamePlayers').innerHTML=state.isPublic?'':activePlayerRows+publicSideInviteRows(activeOpenSeats)"));
  assert.ok(multiplayer.includes("classList.toggle('sivel-public-live',!!(state&&state.isPublic))"));\n  assert.match(multiplayer, /${ACTION_DOCK_MARKER}/);\n  assert.ok(multiplayer.includes("consoleRoot.id='sivelActionDock'"));\n  assert.ok(multiplayer.includes('sivelAllInBtn'));\n  assert.ok(multiplayer.includes('data-size=\"half\"'));\n  assert.ok(multiplayer.includes('sivel-player-console'));\n  assert.ok(multiplayer.includes('sivel-size-toggle'));\n  assert.ok(multiplayer.includes('order:2;position:relative!important'));\n  assert.doesNotMatch(multiplayer, /sivel-split-table-controls-v59/);\n  assert.match(multiplayer, /<\\/html>\\s*$/i);\n});\n\ntest('inline multiplayer scripts parse', () => {\n  const multiplayer = read('public/multiplayer.html');\n  const scripts = [...multiplayer.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(match => match[1]);\n  assert.ok(scripts.length > 0);\n  for (const [index, source] of scripts.entries()) {\n    assert.doesNotThrow(() => new vm.Script(source, { filename: 'multiplayer-inline-' + index + '.js' }));\n  }\n});\n\ntest('server contains the authoritative V57 baseline', () => {\n  const server = read('server.js');\n  assert.match(server, /clean-baseline-v57|${BASELINE_MARKER}/);\n  assert.match(server, /turnId/);\n  assert.match(server, /server/);\n});\n`;
  fs.mkdirSync(TEST_DIR, { recursive: true });
  writeAtomic(path.join(TEST_DIR, 'v57-baseline.test.js'), test);
}

function writeBaselineNotes() {
  const notes = `# Sivel Poker V57 clean baseline\n\nV57 permanently bakes the confirmed V55 server-authority work and the V56 public-seat profile stability fix into normal source files.\n\n## Structural changes\n\n- \`npm start\` now runs only \`node server.js\`.\n- The multiplayer client is a readable file at \`public/multiplayer.html\`.\n- \`public/index.html\` loads that client template instead of storing a large base64 payload.\n- V55/V56 scripts are retained under \`legacy-patches/\` for audit and rollback only.\n- \`npm test\` includes V57 regression checks.\n\n## Preserved behavior\n\n- Server-owned turn timers, hand IDs and turn IDs.\n- Strict check, call and raise validation.\n- Public-table auto play, top-ups and all-in runouts.\n- Clickable opponent profiles.\n- One stable identity card per occupied live-table seat.\n- Visible local-player profile and chip count.\n- Ghost-seat cleanup.\n- Waiting-table seats cannot survive into active hands as duplicate profiles.
- Public live tables do not render a second player roster beside the table.\n- Fold, check/call, raise and all-in form a curved player console around the local identity without covering it.\n- Bet sizing uses compact orbit shortcuts and an expandable slider rather than a large permanent box.\n- The table, center logo and community board retain their original positions.\n- The pot sits directly beneath the community cards at a reduced scale.\n\n## Next development rule\n\nEdit \`server.js\`, \`public/index.html\` and \`public/multiplayer.html\` directly. Do not add another startup patch script.\n`;
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
    console.log('V57 clean baseline is already installed; applying the V60 curved player console and verifying it now.');
    const existingMultiplayer = read(MULTIPLAYER_PATH);
    const upgradedMultiplayer = installMultiplayerActionDock(existingMultiplayer);
    if (upgradedMultiplayer !== existingMultiplayer) writeAtomic(MULTIPLAYER_PATH, upgradedMultiplayer);
    writeAtomic(PACKAGE_PATH, buildPackage(read(PACKAGE_PATH)));
    writeBaselineTest();
    writeBaselineNotes();
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
  fixMultiplayerSeatOwnership,
  installMultiplayerActionDock
};
