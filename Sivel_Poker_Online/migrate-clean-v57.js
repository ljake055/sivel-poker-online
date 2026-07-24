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
const ACTION_DOCK_MARKER = 'SIVEL_V57_PRO_PLAYER_CONTROLS_V62';

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
    /\n*<style id="sivel-player-console-v60">[\s\S]*?<\/style>/g,
    /\n*<style id="sivel-pro-player-controls-v62">[\s\S]*?<\/style>/g
  ];
  const runtimePatterns = [
    /\n*<script id="sivel-in-table-action-dock-runtime-v58">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-split-table-controls-runtime-v59">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-player-console-runtime-v60">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-pro-player-controls-runtime-v62">[\s\S]*?<\/script>/g
  ];
  for (const pattern of stylePatterns.concat(runtimePatterns)) source = source.replace(pattern, '');

  if (!source.includes('window.SivelGetTableState=()=>state;')) {
    const stateMatches = [...source.matchAll(/let\s+state\s*=\s*[^;]+;/g)];
    if (stateMatches.length !== 1) fail(`V62 professional controls expected one multiplayer state declaration, found ${stateMatches.length}.`);
    source = source.replace(/let\s+state\s*=\s*[^;]+;/, match => `${match}\nwindow.SivelGetTableState=()=>state;`);
  }

  const style = `
<style id="sivel-pro-player-controls-v62">
/* ${ACTION_DOCK_MARKER} — refined professional controls keep utilities off the table, tighten action spacing, and move raise controls into a compact center pod. */
#gameScreen.sivel-action-dock-screen{min-height:0}
#gameScreen.sivel-action-dock-screen .table-wrap{position:relative;min-height:0}
.controls.sivel-controls-relocated{display:none!important}

#tableStage.sivel-action-console-active .poker-table.sivel-casino-table{
  left:5.8%!important;right:5.8%!important;top:20.5%!important;bottom:10.5%!important
}
#tableStage.sivel-action-console-active .center{
  top:49%!important;display:flex!important;flex-direction:column!important;align-items:center!important;width:57%!important
}
#tableStage.sivel-action-console-active .center:before{
  content:'';display:block;order:0;width:1px;height:32px;flex:0 0 32px;pointer-events:none
}
#tableStage.sivel-action-console-active .center .board{order:1;margin:0!important;transform:none!important}
#tableStage.sivel-action-console-active .center .pot{
  order:2;position:relative!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;
  display:inline-flex!important;margin:34px auto 0!important;transform:scale(.62)!important;transform-origin:top center!important;
  z-index:14!important;white-space:nowrap!important;pointer-events:none!important
}
#tableStage.sivel-action-console-active .center>.sivel-table-status-spacer{position:absolute!important;visibility:hidden!important;pointer-events:none!important}
#tableStage.sivel-action-console-active .seat.self-seat{bottom:8px!important;z-index:96!important}
#tableStage.sivel-action-console-active .seat.slot-lower-left,
#tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:162px!important}

.sivel-player-console{position:absolute;inset:0;z-index:90;pointer-events:none;--sivel-left-near:calc(50% - 228px);--sivel-left-far:calc(50% - 332px);--sivel-right-near:calc(50% + 84px);--sivel-right-far:calc(50% + 228px)}
.sivel-action-orbit{position:absolute;inset:0;pointer-events:none}
.sivel-action-orbit .action-btn{
  position:absolute!important;z-index:4;min-width:0!important;padding:6px 10px!important;pointer-events:auto!important;
  font-size:10px!important;font-weight:950!important;letter-spacing:.025em!important;
  box-shadow:0 9px 20px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.13)!important;
  transition:transform .14s ease,filter .14s ease,border-color .14s ease!important
}
.sivel-action-orbit #foldBtn{
  left:var(--sivel-left-far);bottom:24px;width:108px!important;height:42px!important;border-radius:20px 11px 24px 24px!important;
  background:linear-gradient(180deg,#51232d,#281017)!important;border:1px solid #884452!important;color:#ffd0d6!important
}
.sivel-action-orbit #callBtn{
  left:var(--sivel-left-near);bottom:52px;width:124px!important;height:47px!important;border-radius:26px 16px 16px 26px!important;
  background:linear-gradient(180deg,#205840,#0c2a1f)!important;border:1px solid #3d936b!important;color:#cbffe0!important
}
.sivel-action-orbit #raiseBtn{
  left:var(--sivel-right-near);bottom:52px;width:138px!important;height:47px!important;border-radius:16px 26px 26px 16px!important;
  background:linear-gradient(180deg,#f1d88d,#c58a2d 65%,#965f1b)!important;border:1px solid #f0ce77!important;color:#221503!important
}
.sivel-action-orbit .sivel-all-in{
  left:var(--sivel-right-far);bottom:24px;width:108px!important;height:42px!important;border-radius:11px 20px 24px 24px!important;
  background:linear-gradient(180deg,#dc622e,#761911 72%,#470d09)!important;border:1px solid #ee9548!important;color:#fff1da!important
}
.sivel-action-orbit #foldBtn:hover:not(:disabled),
.sivel-action-orbit #callBtn:hover:not(:disabled),
.sivel-action-orbit #raiseBtn:hover:not(:disabled),
.sivel-action-orbit .sivel-all-in:hover:not(:disabled){transform:translateY(-3px)!important;filter:brightness(1.08)!important}
.sivel-action-orbit .action-btn:disabled{opacity:.31!important;filter:saturate(.42)!important;cursor:not-allowed!important}

.sivel-bet-pod{
  position:absolute;left:50%;bottom:118px;transform:translateX(-50%);z-index:6;width:292px;padding:6px 8px;border-radius:17px;
  border:1px solid rgba(83,113,135,.58);background:linear-gradient(180deg,rgba(14,27,38,.98),rgba(5,12,18,.99));
  box-shadow:0 12px 28px rgba(0,0,0,.54),inset 0 1px 0 rgba(255,255,255,.065);pointer-events:auto
}
.sivel-quick-bets{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:5px}
.sivel-quick-bet{height:21px;min-width:0;padding:0 4px;border-radius:999px;border:1px solid rgba(83,111,131,.55);background:linear-gradient(180deg,#172a38,#0b1822);color:#bdccd6;font-size:7px;font-weight:950;letter-spacing:.07em;cursor:pointer}
.sivel-quick-bet:hover:not(:disabled){border-color:#dfbd62;color:#ffe4a0;filter:brightness(1.09)}
.sivel-quick-bet:disabled{opacity:.28;cursor:not-allowed}
.sivel-bet-pod .raise-box{display:grid!important;grid-template-columns:minmax(0,1fr) 68px!important;gap:8px!important;align-items:center!important;width:100%!important;min-height:27px!important;padding:3px 6px!important;margin:0!important;border:0!important;border-radius:9px!important;background:rgba(3,10,16,.48)!important;box-shadow:none!important}
.sivel-bet-pod .raise-box input[type="range"]{width:100%;margin:0!important;align-self:center}
.sivel-bet-pod .raise-total{min-width:0!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;line-height:1!important}
.sivel-bet-pod .raise-total small{font-size:6px!important;color:#788d9d!important}
.sivel-bet-pod .raise-total strong{font-size:13px!important;color:#f2d17c!important}

.sivel-table-utility-rail{
  position:absolute;left:12px;top:108px;z-index:93;display:grid;grid-template-columns:1fr;gap:6px;width:158px;padding:7px;border-radius:14px;
  border:1px solid rgba(72,98,117,.58);background:linear-gradient(180deg,rgba(15,29,41,.97),rgba(5,13,20,.98));
  box-shadow:0 10px 24px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.06);pointer-events:auto
}
.sivel-table-utility-rail .table-tools{display:grid!important;grid-template-columns:1fr!important;gap:6px!important;margin:0!important;padding:0!important;border:0!important;width:100%!important}
.sivel-table-utility-rail .table-tools-label{display:none!important}
.sivel-table-utility-rail .table-tool,.sivel-table-utility-rail .host-row button{width:100%!important;min-width:0!important;height:34px!important;padding:0 10px!important;border-radius:10px!important;font-size:8px!important;white-space:nowrap!important}
.sivel-table-utility-rail .host-row{display:grid!important;grid-template-columns:1fr!important;gap:6px!important;margin:0!important;width:100%!important}

.sivel-table-status-panel{margin-top:10px;padding:9px 10px;border-radius:12px;border:1px solid rgba(77,111,138,.42);background:linear-gradient(180deg,rgba(11,24,35,.96),rgba(5,13,20,.98));box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.sivel-table-status-panel small{display:block;font-size:7px;font-weight:950;letter-spacing:.16em;color:#71899c;margin-bottom:4px}
.sivel-table-status-panel strong{display:block;color:#c7d6e0;font-size:10px;line-height:1.35}
.sivel-player-console #gameStatus{display:none!important}
.sivel-player-console.sivel-console-waiting .sivel-action-orbit,.sivel-player-console.sivel-console-waiting .sivel-bet-pod{display:none!important}
.sivel-player-console.sivel-console-waiting #gameStatus{
  display:flex!important;position:absolute!important;left:50%!important;top:50%!important;right:auto!important;bottom:auto!important;
  transform:translate(-50%,-50%)!important;width:min(520px,calc(100% - 30px))!important;min-height:42px!important;
  align-items:center!important;justify-content:center!important;margin:0!important;padding:9px 13px!important;border-radius:13px!important;
  background:rgba(4,9,14,.82)!important;border:1px solid rgba(255,255,255,.08)!important;color:#d7e1e9!important;
  font-size:12px!important;line-height:1.4!important;text-align:center!important;pointer-events:none!important
}

.sivel-player-console.sivel-console-narrow{--sivel-left-near:calc(50% - 208px);--sivel-left-far:calc(50% - 304px);--sivel-right-near:calc(50% + 74px);--sivel-right-far:calc(50% + 206px)}
.sivel-player-console.sivel-console-narrow .sivel-action-orbit .action-btn{font-size:9px!important}
.sivel-player-console.sivel-console-narrow .sivel-action-orbit #foldBtn,.sivel-player-console.sivel-console-narrow .sivel-all-in{width:96px!important}
.sivel-player-console.sivel-console-narrow .sivel-action-orbit #callBtn{width:116px!important}
.sivel-player-console.sivel-console-narrow .sivel-action-orbit #raiseBtn{width:128px!important}
.sivel-player-console.sivel-console-narrow .sivel-bet-pod{width:274px}

@media(min-width:1181px){
  #gameScreen.sivel-action-dock-screen{height:100vh;overflow:hidden}
  #gameScreen.sivel-action-dock-screen>.shell{height:100%;display:flex;flex-direction:column;padding-top:10px;padding-bottom:12px}
  #gameScreen.sivel-action-dock-screen .topbar{flex:0 0 auto}
  #gameScreen.sivel-action-dock-screen .game-layout{flex:1;min-height:0;margin-top:10px;align-items:stretch}
  #gameScreen.sivel-action-dock-screen .table-wrap{height:100%;display:flex;min-height:0}
  #gameScreen.sivel-action-dock-screen #tableStage{height:100%!important;min-height:590px;flex:1 1 auto;width:100%}
  #gameScreen.sivel-action-dock-screen .side-panel{height:100%;min-height:0!important}
}
@media(max-width:1120px) and (min-width:761px){
  .sivel-table-utility-rail{left:8px;top:104px;width:144px}
  .sivel-bet-pod{width:270px;bottom:122px}
  #tableStage.sivel-action-console-active .seat.slot-lower-left,
  #tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:150px!important}
}
@media(max-width:900px) and (min-width:761px){
  .sivel-player-console{--sivel-left-near:calc(50% - 188px);--sivel-left-far:calc(50% - 280px);--sivel-right-near:calc(50% + 66px);--sivel-right-far:calc(50% + 188px)}
  .sivel-bet-pod{width:252px;bottom:125px}
  #tableStage.sivel-action-console-active .seat.self-seat{bottom:132px!important}
  #tableStage.sivel-action-console-active .seat.slot-lower-left,
  #tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:210px!important}
}
@media(max-width:760px){
  #tableStage.sivel-action-console-active .center{top:49%!important;width:88%!important}
  #tableStage.sivel-action-console-active .center:before{height:28px;flex-basis:28px}
  #tableStage.sivel-action-console-active .center .pot{margin-top:19px!important;transform:scale(.6)!important}
  #tableStage.sivel-action-console-active .seat.self-seat{bottom:176px!important}
  #tableStage.sivel-action-console-active .seat.slot-lower-left,
  #tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:240px!important}
  .sivel-action-orbit{left:8px;right:8px;bottom:8px;top:auto;height:88px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,40px);gap:5px}
  .sivel-action-orbit .action-btn,
  .sivel-action-orbit #foldBtn,.sivel-action-orbit #callBtn,.sivel-action-orbit #raiseBtn,.sivel-action-orbit .sivel-all-in{
    position:relative!important;inset:auto!important;bottom:auto!important;right:auto!important;left:auto!important;transform:none!important;
    width:auto!important;height:40px!important;border-radius:12px!important;font-size:8px!important
  }
  .sivel-bet-pod{left:8px;right:8px;bottom:100px;transform:none;width:auto}
  .sivel-table-utility-rail{display:none!important}
}
@media(max-width:620px){
  #tableStage.sivel-action-console-active .seat.self-seat{bottom:204px!important}
  #tableStage.sivel-action-console-active .seat.slot-lower-left,
  #tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:268px!important}
  .sivel-bet-pod{bottom:114px}
}
</style>
`;

  const runtime = `
<script id="sivel-pro-player-controls-runtime-v62">
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
    consoleRoot.innerHTML='<div class="sivel-action-orbit"></div><div class="sivel-bet-pod"><div class="sivel-quick-bets"><button type="button" class="sivel-quick-bet" data-size="min">MIN</button><button type="button" class="sivel-quick-bet" data-size="half">½ POT</button><button type="button" class="sivel-quick-bet" data-size="pot">POT</button><button type="button" class="sivel-quick-bet" data-size="max">MAX</button></div></div><div class="sivel-table-utility-rail"></div>';
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

    const betPod=consoleRoot.querySelector('.sivel-bet-pod');
    betPod.appendChild(raiseBox);
    const quickButtons=Array.from(betPod.querySelectorAll('[data-size]'));

    const utilityRail=consoleRoot.querySelector('.sivel-table-utility-rail');
    const tableTools=document.getElementById('tableTools');
    const hostRow=controls.querySelector('.host-row');
    if(tableTools)utilityRail.appendChild(tableTools);
    if(hostRow)utilityRail.appendChild(hostRow);
    if(!tableTools&&!hostRow)utilityRail.remove();

    const rightPanel=screen.querySelector('.game-right');
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
    let syncQueued=false;

    function tableState(){
      try{return typeof window.SivelGetTableState==='function'?window.SivelGetTableState():null}
      catch(_error){return null}
    }
    function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0}
    function limits(data){
      const legal=data&&data.legal||{};
      return {min:number(legal.minRaiseTotal||slider.min),max:number(legal.maxRaiseTotal||slider.max)};
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
    function sync(){
      syncQueued=false;
      const data=tableState(),game=data&&data.game,legal=data&&data.legal||{};
      const playing=!!(data&&data.stage==='playing'&&game);
      screen.classList.toggle('sivel-action-dock-screen',playing);
      stage.classList.toggle('sivel-action-console-active',playing);
      document.body.classList.toggle('sivel-table-play-mode',playing);
      consoleRoot.classList.toggle('sivel-console-waiting',!playing);
      consoleRoot.classList.toggle('sivel-console-narrow',playing&&stage.getBoundingClientRect().width<1040&&window.innerWidth>760);
      const range=limits(data);
      const canRaise=playing&&!!legal.canAct&&!!legal.canRaise&&range.max>=range.min&&range.max>0;
      quickButtons.forEach(function(button){button.disabled=!canRaise});
      allIn.disabled=!canRaise;
      if(statusMirror)statusMirror.textContent=status.textContent||'Waiting for the table.';
    }
    function scheduleSync(){
      if(syncQueued)return;
      syncQueued=true;
      (window.requestAnimationFrame||setTimeout)(sync);
    }

    betPod.addEventListener('click',function(event){
      const button=event.target&&event.target.closest?event.target.closest('[data-size]'):null;
      if(!button||button.disabled)return;
      setRaiseTarget(sizingTarget(button.dataset.size));
    });
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
</script>
`;

  if (!source.includes('</head>') || !source.includes('</body>')) {
    fail('V62 professional controls could not find the multiplayer document boundaries.');
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
  pkg.version = '2.2.4';
  pkg.description = 'Sivel Poker clean V57 baseline with compact professional player controls.';
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
  assert.ok(multiplayer.includes("classList.toggle('sivel-public-live',!!(state&&state.isPublic))"));\n  assert.match(multiplayer, /${ACTION_DOCK_MARKER}/);\n  assert.ok(multiplayer.includes("consoleRoot.id='sivelActionDock'"));\n  assert.ok(multiplayer.includes('sivelAllInBtn'));\n  assert.ok(multiplayer.includes('data-size=\"half\"'));\n  assert.ok(multiplayer.includes('sivel-player-console'));\n  assert.ok(multiplayer.includes('sivel-bet-pod'));\n  assert.ok(multiplayer.includes('sivel-table-utility-rail'));\n  assert.ok(multiplayer.includes('margin:34px auto 0!important'));\n  assert.doesNotMatch(multiplayer, /sivel-player-console-v60/);\n  assert.match(multiplayer, /<\\/html>\\s*$/i);\n});\n\ntest('inline multiplayer scripts parse', () => {\n  const multiplayer = read('public/multiplayer.html');\n  const scripts = [...multiplayer.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(match => match[1]);\n  assert.ok(scripts.length > 0);\n  for (const [index, source] of scripts.entries()) {\n    assert.doesNotThrow(() => new vm.Script(source, { filename: 'multiplayer-inline-' + index + '.js' }));\n  }\n});\n\ntest('server contains the authoritative V57 baseline', () => {\n  const server = read('server.js');\n  assert.match(server, /clean-baseline-v57|${BASELINE_MARKER}/);\n  assert.match(server, /turnId/);\n  assert.match(server, /server/);\n});\n`;
  fs.mkdirSync(TEST_DIR, { recursive: true });
  writeAtomic(path.join(TEST_DIR, 'v57-baseline.test.js'), test);
}

function writeBaselineNotes() {
  const notes = `# Sivel Poker V57 clean baseline\n\nV57 permanently bakes the confirmed V55 server-authority work and the V56 public-seat profile stability fix into normal source files.\n\n## Structural changes\n\n- \`npm start\` now runs only \`node server.js\`.\n- The multiplayer client is a readable file at \`public/multiplayer.html\`.\n- \`public/index.html\` loads that client template instead of storing a large base64 payload.\n- V55/V56 scripts are retained under \`legacy-patches/\` for audit and rollback only.\n- \`npm test\` includes V57 regression checks.\n\n## Preserved behavior\n\n- Server-owned turn timers, hand IDs and turn IDs.\n- Strict check, call and raise validation.\n- Public-table auto play, top-ups and all-in runouts.\n- Clickable opponent profiles.\n- One stable identity card per occupied live-table seat.\n- Visible local-player profile and chip count.\n- Ghost-seat cleanup.\n- Waiting-table seats cannot survive into active hands as duplicate profiles.
- Public live tables do not render a second player roster beside the table.\n- Fold, check/call, raise and all-in use compact balanced controls around the protected local profile column.\n- Bet sizing uses a standard compact rail on the lower right, outside the cards and player identity.\n- Table controls occupy unused top-left room space rather than the chat panel or any scrolling region.\n- The table, center logo and community board retain their original positions.\n- The pot sits beneath the community cards with enough clearance to leave the table branding readable.\n\n## Next development rule\n\nEdit \`server.js\`, \`public/index.html\` and \`public/multiplayer.html\` directly. Do not add another startup patch script.\n`;
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
    console.log('V57 clean baseline is already installed; applying the V62 professional player controls and verifying them now.');
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
