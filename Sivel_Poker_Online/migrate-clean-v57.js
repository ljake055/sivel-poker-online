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
const ACTION_DOCK_MARKER = 'SIVEL_V57_PRO_PLAYER_CONTROLS_V65';

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
    /\n*<style id="sivel-pro-player-controls-v61">[\s\S]*?<\/style>/g,
    /\n*<style id="sivel-pro-player-controls-v62">[\s\S]*?<\/style>/g,
    /\n*<style id="sivel-pro-player-controls-v63">[\s\S]*?<\/style>/g,
    /\n*<style id="sivel-pro-player-controls-v64">[\s\S]*?<\/style>/g,
    /\n*<style id="sivel-pro-player-controls-v65">[\s\S]*?<\/style>/g
  ];
  const runtimePatterns = [
    /\n*<script id="sivel-in-table-action-dock-runtime-v58">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-split-table-controls-runtime-v59">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-player-console-runtime-v60">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-pro-player-controls-runtime-v61">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-pro-player-controls-runtime-v62">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-pro-player-controls-runtime-v63">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-pro-player-controls-runtime-v64">[\s\S]*?<\/script>/g,
    /\n*<script id="sivel-pro-player-controls-runtime-v65">[\s\S]*?<\/script>/g
  ];
  for (const pattern of stylePatterns.concat(runtimePatterns)) source = source.replace(pattern, '');
  source = source.replace(/\s*<\/head>/i, '\n</head>');
  source = source.replace(/\s*<\/body>/i, '\n</body>');

  if (!source.includes('window.SivelGetTableState=()=>state;')) {
    const stateMatches = [...source.matchAll(/let\s+state\s*=\s*[^;]+;/g)];
    if (stateMatches.length !== 1) fail(`V65 professional controls expected one multiplayer state declaration, found ${stateMatches.length}.`);
    source = source.replace(/let\s+state\s*=\s*[^;]+;/, match => `${match}\nwindow.SivelGetTableState=()=>state;`);
  }

  const style = `
<style id="sivel-pro-player-controls-v65">
/* ${ACTION_DOCK_MARKER} — chat-first right sidebar, top-header table metadata, bottom-right raise controls, and opponent bets beside their cards. */
#gameScreen.sivel-action-dock-screen{min-height:0}
#gameScreen.sivel-action-dock-screen .table-wrap{position:relative;min-height:0}
.controls.sivel-controls-relocated{display:none!important}

/* Preserve the approved table, board, logo, pot and local action geometry. */
#tableStage.sivel-action-console-active .poker-table.sivel-casino-table{left:5.8%!important;right:5.8%!important;top:20.5%!important;bottom:10.5%!important}
#tableStage.sivel-action-console-active .center{top:49%!important;display:flex!important;flex-direction:column!important;align-items:center!important;width:57%!important}
#tableStage.sivel-action-console-active .center:before{content:'';display:block;order:0;width:1px;height:32px;flex:0 0 32px;pointer-events:none}
#tableStage.sivel-action-console-active .center .board{order:1;margin:0!important;transform:none!important}
#tableStage.sivel-action-console-active .center .pot{order:2;position:relative!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;display:inline-flex!important;margin:34px auto 0!important;transform:scale(.62)!important;transform-origin:top center!important;z-index:14!important;white-space:nowrap!important;pointer-events:none!important}
#tableStage.sivel-action-console-active .center>.sivel-table-status-spacer{position:absolute!important;visibility:hidden!important;pointer-events:none!important}
#tableStage.sivel-action-console-active .seat.self-seat{bottom:8px!important;z-index:96!important}
#tableStage.sivel-action-console-active .seat.slot-lower-left,
#tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:158px!important}

/* The middle lane remains protected for the local cards, wager chip and identity. */
.sivel-action-zone{position:absolute;inset:0;z-index:90;pointer-events:none}
.sivel-action-zone .action-btn{position:absolute!important;z-index:4;min-width:0!important;padding:6px 10px!important;pointer-events:auto!important;font-size:10px!important;font-weight:950!important;letter-spacing:.025em!important;box-shadow:0 9px 20px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.13)!important;transition:transform .14s ease,filter .14s ease,border-color .14s ease!important}
.sivel-action-zone #foldBtn{left:max(14px,calc(50% - 410px));bottom:22px;width:106px!important;height:42px!important;border-radius:20px 11px 24px 24px!important;background:linear-gradient(180deg,#51232d,#281017)!important;border:1px solid #884452!important;color:#ffd0d6!important}
.sivel-action-zone #callBtn{left:max(126px,calc(50% - 292px));bottom:46px;width:122px!important;height:47px!important;border-radius:26px 16px 16px 26px!important;background:linear-gradient(180deg,#205840,#0c2a1f)!important;border:1px solid #3d936b!important;color:#cbffe0!important}
.sivel-action-zone #raiseBtn{right:max(126px,calc(50% - 292px));bottom:46px;width:136px!important;height:47px!important;border-radius:16px 26px 26px 16px!important;background:linear-gradient(180deg,#f1d88d,#c58a2d 65%,#965f1b)!important;border:1px solid #f0ce77!important;color:#221503!important}
.sivel-action-zone .sivel-all-in{right:max(14px,calc(50% - 410px));bottom:22px;width:106px!important;height:42px!important;border-radius:11px 20px 24px 24px!important;background:linear-gradient(180deg,#dc622e,#761911 72%,#470d09)!important;border:1px solid #ee9548!important;color:#fff1da!important}
.sivel-action-zone #foldBtn:hover:not(:disabled),.sivel-action-zone #callBtn:hover:not(:disabled),.sivel-action-zone #raiseBtn:hover:not(:disabled),.sivel-action-zone .sivel-all-in:hover:not(:disabled){transform:translateY(-3px)!important;filter:brightness(1.08)!important}
.sivel-action-zone .action-btn:disabled{opacity:.31!important;filter:saturate(.42)!important;cursor:not-allowed!important}

/* Buy-in, blinds, street and seat move into the unused header space. */
.sivel-top-table-meta{display:grid;grid-template-columns:repeat(4,minmax(88px,1fr));gap:6px;align-items:center;flex:1 1 430px;max-width:520px;min-width:350px}
.sivel-top-table-meta .tip{height:42px;min-width:0;margin:0!important;padding:0 9px!important;display:flex;align-items:center;justify-content:center;gap:4px;border-radius:12px!important;background:linear-gradient(180deg,#111f2d,#09141e)!important;border:1px solid #263c50!important;color:#9eb2c3!important;font-size:9px!important;line-height:1!important;white-space:nowrap;overflow:hidden}
.sivel-top-table-meta .tip strong{color:#dce7ef!important;font-size:8px!important}
.sivel-top-table-meta .tip span{color:#f0cf7d;font-weight:900;overflow:hidden;text-overflow:ellipsis}

/* Table utilities remain ordinary content directly below Hand History. */
.sivel-sidebar-utilities{margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08)}
.sivel-sidebar-utilities h3{margin:0 0 10px!important}
.sivel-sidebar-utilities .table-tools{display:grid!important;grid-template-columns:1fr!important;gap:7px!important;margin:0!important;padding:0!important;border:0!important;width:100%!important}
.sivel-sidebar-utilities .table-tools-label{display:none!important}
.sivel-sidebar-utilities .table-tool,.sivel-sidebar-utilities .host-row button{width:100%!important;min-width:0!important;height:39px!important;padding:0 10px!important;border-radius:11px!important;font-size:9px!important;white-space:nowrap!important}
.sivel-sidebar-utilities .host-row{display:grid!important;grid-template-columns:1fr!important;gap:7px!important;margin:7px 0 0!important;width:100%!important}

/* Chat owns the upper/right panel and its input remains visible. */
.game-right.sivel-chat-priority{display:flex!important;flex-direction:column!important;min-height:0!important;overflow:hidden!important;padding:14px!important}
.game-right.sivel-chat-priority>.sivel-current-table-heading{display:none!important}
.game-right.sivel-chat-priority .chat-shell{order:1;display:flex!important;flex-direction:column!important;flex:1 1 auto!important;min-height:0!important;margin:0!important}
.game-right.sivel-chat-priority .chat-head,.game-right.sivel-chat-priority .chat-quick,.game-right.sivel-chat-priority .chat-compose,.game-right.sivel-chat-priority .chat-foot{flex:0 0 auto!important}
.game-right.sivel-chat-priority .chat-messages{height:auto!important;max-height:none!important;min-height:250px!important;flex:1 1 auto!important}

/* Raise sizing stays at the bottom of the right sidebar, below chat and outside the table. */
.sivel-sidebar-bet-control{order:2;flex:0 0 auto;margin:12px 0 0;padding:10px;border-radius:14px;border:1px solid rgba(78,109,134,.5);background:linear-gradient(180deg,rgba(13,27,39,.97),rgba(5,13,20,.99));box-shadow:inset 0 1px 0 rgba(255,255,255,.045)}
.sivel-sidebar-bet-control .sivel-bet-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.sivel-sidebar-bet-control .sivel-bet-head span{font-size:7px;font-weight:950;letter-spacing:.16em;color:#7690a4}
.sivel-sidebar-bet-control .sivel-bet-head strong{font-size:16px;line-height:1;color:#f1d17d;font-variant-numeric:tabular-nums}
.sivel-sidebar-bet-control .sivel-quick-bets{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:7px}
.sivel-sidebar-bet-control .sivel-quick-bet{height:26px;min-width:0;padding:0 3px;border-radius:8px;border:1px solid rgba(83,111,131,.55);background:linear-gradient(180deg,#172a38,#0b1822);color:#bdccd6;font-size:7px;font-weight:950;letter-spacing:.06em;cursor:pointer}
.sivel-sidebar-bet-control .sivel-quick-bet:hover:not(:disabled){border-color:#dfbd62;color:#ffe4a0;filter:brightness(1.09)}
.sivel-sidebar-bet-control .sivel-quick-bet:disabled{opacity:.28;cursor:not-allowed}
.sivel-bet-stepper{display:grid;grid-template-columns:38px minmax(0,1fr) 38px;gap:6px;align-items:center}
.sivel-bet-stepper button{height:36px;border-radius:10px;border:1px solid #365068;background:linear-gradient(180deg,#1a3043,#0c1a26);color:#e6eef4;font-size:20px;font-weight:900;cursor:pointer}
.sivel-bet-stepper button:hover:not(:disabled){border-color:#d9b75f;color:#ffe29a;filter:brightness(1.08)}
.sivel-bet-stepper button:disabled{opacity:.3;cursor:not-allowed}
.sivel-bet-stepper .sivel-bet-value{height:36px;display:flex;align-items:center;justify-content:center;border-radius:10px;border:1px solid rgba(231,196,112,.35);background:rgba(5,13,20,.76);color:#f3d383;font-size:14px;font-weight:950;font-variant-numeric:tabular-nums}
.sivel-bet-help{display:block;margin-top:7px;text-align:center;color:#71879a;font-size:7px;line-height:1.3}
.sivel-sidebar-bet-control .raise-box{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;clip-path:inset(50%)!important;white-space:nowrap!important}
.sivel-sidebar-bet-control #raiseSlider{display:none!important}
.sivel-sidebar-status{margin:8px 0 0;padding:8px 9px;border-radius:10px;border:1px solid rgba(75,104,128,.4);background:rgba(5,13,20,.72);color:#b9cad6;font-size:9px;line-height:1.35;text-align:center}

/* Opponent wager/blind chips sit directly left of their cards. */
#tableStage .seat:not(.self-seat):not(.open-seat) .bet-chip.sivel-opponent-bet-left{position:absolute!important;margin:0!important;z-index:18!important;pointer-events:none!important;white-space:nowrap!important}

/* Hand outcomes sit in the clear lane immediately above the community cards. */
#tableStage .result.sivel-hand-result-banner{position:absolute!important;inset:auto!important;right:auto!important;bottom:auto!important;margin:0!important;transform:translateX(-50%)!important;z-index:97!important;max-width:min(480px,calc(100% - 40px))!important;pointer-events:none!important}

.sivel-action-zone #gameStatus{display:none!important}
.sivel-action-zone.sivel-console-waiting .action-btn{display:none!important}
.sivel-action-zone.sivel-console-waiting #gameStatus{display:flex!important;position:absolute!important;left:50%!important;top:50%!important;right:auto!important;bottom:auto!important;transform:translate(-50%,-50%)!important;width:min(520px,calc(100% - 30px))!important;min-height:42px!important;align-items:center!important;justify-content:center!important;margin:0!important;padding:9px 13px!important;border-radius:13px!important;background:rgba(4,9,14,.82)!important;border:1px solid rgba(255,255,255,.08)!important;color:#d7e1e9!important;font-size:12px!important;line-height:1.4!important;text-align:center!important;pointer-events:none!important}

@media(min-width:1181px){
  #gameScreen.sivel-action-dock-screen{height:100vh;overflow:hidden}
  #gameScreen.sivel-action-dock-screen>.shell{height:100%;display:flex;flex-direction:column;padding-top:10px;padding-bottom:12px}
  #gameScreen.sivel-action-dock-screen .topbar{flex:0 0 auto}
  #gameScreen.sivel-action-dock-screen .game-layout{flex:1;min-height:0;margin-top:10px;align-items:stretch}
  #gameScreen.sivel-action-dock-screen .table-wrap{height:100%;display:flex;min-height:0}
  #gameScreen.sivel-action-dock-screen #tableStage{height:100%!important;min-height:590px;flex:1 1 auto;width:100%}
  #gameScreen.sivel-action-dock-screen .side-panel{height:100%;min-height:0!important}
}
@media(max-width:1380px) and (min-width:1181px){
  .sivel-top-table-meta{grid-template-columns:repeat(2,minmax(105px,1fr));max-width:280px;min-width:250px}
  .sivel-top-table-meta .tip{height:31px}
}
@media(max-width:1180px){
  .sivel-top-table-meta{order:3;flex-basis:100%;max-width:none;min-width:0;width:100%;grid-template-columns:repeat(4,1fr)}
  .game-right.sivel-chat-priority .chat-messages{min-height:300px!important}
}
@media(max-width:900px) and (min-width:761px){
  #tableStage.sivel-action-console-active .seat.self-seat{bottom:126px!important}
  #tableStage.sivel-action-console-active .seat.slot-lower-left,#tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:205px!important}
  .sivel-action-zone #foldBtn{left:8px}.sivel-action-zone #callBtn{left:119px}.sivel-action-zone #raiseBtn{right:119px}.sivel-action-zone .sivel-all-in{right:8px}
}
@media(max-width:760px){
  .sivel-top-table-meta{grid-template-columns:repeat(2,1fr)}
  #tableStage.sivel-action-console-active .center{top:49%!important;width:88%!important}
  #tableStage.sivel-action-console-active .center:before{height:28px;flex-basis:28px}
  #tableStage.sivel-action-console-active .center .pot{margin-top:19px!important;transform:scale(.6)!important}
  #tableStage.sivel-action-console-active .seat.self-seat{bottom:112px!important}
  #tableStage.sivel-action-console-active .seat.slot-lower-left,#tableStage.sivel-action-console-active .seat.slot-lower-right{bottom:190px!important}
  .sivel-action-zone{left:7px;right:7px;bottom:7px;top:auto;height:88px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,40px);gap:5px}
  .sivel-action-zone .action-btn,.sivel-action-zone #foldBtn,.sivel-action-zone #callBtn,.sivel-action-zone #raiseBtn,.sivel-action-zone .sivel-all-in{position:relative!important;inset:auto!important;bottom:auto!important;right:auto!important;left:auto!important;transform:none!important;width:auto!important;height:40px!important;border-radius:12px!important;font-size:8px!important}
}
</style>`;

  const runtime = `
<script id="sivel-pro-player-controls-runtime-v65">
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
    const board=document.getElementById('board');
    const resultBox=document.getElementById('resultBox');
    if(!screen||!stage||!controls||!actionRow||!status||!slider||!raiseTotal||!raiseBox||!foldBtn||!callBtn||!raiseBtn)return;
    if(document.getElementById('sivelActionDock'))return;

    const actionZone=document.createElement('section');
    actionZone.id='sivelActionDock';
    actionZone.className='sivel-action-zone sivel-console-waiting';
    actionZone.setAttribute('aria-label','Poker action controls');
    actionZone.appendChild(status);
    actionZone.appendChild(foldBtn);
    actionZone.appendChild(callBtn);
    actionZone.appendChild(raiseBtn);

    const allIn=document.createElement('button');
    allIn.type='button';
    allIn.id='sivelAllInBtn';
    allIn.className='action-btn sivel-all-in';
    allIn.textContent='All-In';
    actionZone.appendChild(allIn);

    const leftPanel=screen.querySelector('.game-layout > .side-panel:first-child');
    if(leftPanel){
      const utilityPanel=document.createElement('section');
      utilityPanel.className='sivel-sidebar-utilities';
      utilityPanel.innerHTML='<h3>Table controls</h3><div class="sivel-sidebar-utility-body"></div>';
      const body=utilityPanel.querySelector('.sivel-sidebar-utility-body');
      const tableTools=document.getElementById('tableTools');
      const hostRow=controls.querySelector('.host-row');
      if(tableTools)body.appendChild(tableTools);
      if(hostRow)body.appendChild(hostRow);
      const history=document.getElementById('gameLog');
      if(history&&history.parentElement===leftPanel)history.insertAdjacentElement('afterend',utilityPanel);else leftPanel.appendChild(utilityPanel);
      if(!tableTools&&!hostRow)utilityPanel.remove();
    }

    const rightPanel=screen.querySelector('.game-right');
    let betPanel=null,betValue=null,statusMirror=null,quickButtons=[],stepButtons=[];
    if(rightPanel){
      rightPanel.classList.add('sivel-chat-priority');
      const heading=Array.from(rightPanel.children||[]).find(function(node){return node.tagName==='H3'});
      if(heading)heading.classList.add('sivel-current-table-heading');

      const topbar=screen.querySelector('.topbar');
      const topActions=topbar&&topbar.querySelector('.top-actions');
      const details=Array.from(rightPanel.children||[]).filter(function(node){return node.classList&&node.classList.contains('tip')}).slice(0,4);
      if(topbar&&details.length){
        const meta=document.createElement('div');
        meta.className='sivel-top-table-meta';
        meta.setAttribute('aria-label','Current table details');
        details.forEach(function(item){meta.appendChild(item)});
        topbar.insertBefore(meta,topActions||null);
      }

      const chat=rightPanel.querySelector('.chat-shell');
      if(chat)rightPanel.insertBefore(chat,rightPanel.firstChild);

      betPanel=document.createElement('section');
      betPanel.className='sivel-sidebar-bet-control';
      betPanel.innerHTML='<div class="sivel-bet-head"><span>RAISE TO</span><strong id="sivelSidebarBetValue">—</strong></div><div class="sivel-quick-bets"><button type="button" class="sivel-quick-bet" data-size="min">MIN</button><button type="button" class="sivel-quick-bet" data-size="half">½ POT</button><button type="button" class="sivel-quick-bet" data-size="pot">POT</button><button type="button" class="sivel-quick-bet" data-size="max">MAX</button></div><div class="sivel-bet-stepper"><button type="button" data-step="-1" aria-label="Decrease raise">−</button><div class="sivel-bet-value" id="sivelSidebarBetStepValue">—</div><button type="button" data-step="1" aria-label="Increase raise">+</button></div><small class="sivel-bet-help">Use presets or fine-tune with − / +</small><div class="sivel-sidebar-status" id="sivelStatusMirror">Waiting for the table.</div>';
      betPanel.appendChild(raiseBox);
      rightPanel.appendChild(betPanel);
      betValue=betPanel.querySelector('#sivelSidebarBetValue');
      statusMirror=betPanel.querySelector('#sivelStatusMirror');
      quickButtons=Array.from(betPanel.querySelectorAll('[data-size]'));
      stepButtons=Array.from(betPanel.querySelectorAll('[data-step]'));
    }

    controls.classList.add('sivel-controls-relocated');
    stage.appendChild(actionZone);
    if(resultBox){
      resultBox.classList.add('sivel-hand-result-banner');
      stage.appendChild(resultBox);
    }
    let syncQueued=false;

    function tableState(){try{return typeof window.SivelGetTableState==='function'?window.SivelGetTableState():null}catch(_error){return null}}
    function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0}
    function format(value){return Math.max(0,Math.round(number(value))).toLocaleString()}
    function limits(data){const legal=data&&data.legal||{};return{min:number(legal.minRaiseTotal||slider.min),max:number(legal.maxRaiseTotal||slider.max)}}
    function stepSize(data){return Math.max(1,number(data&&data.options&&data.options.smallBlind)||number(slider.step)||1)}
    function setRaiseTarget(value){const data=tableState(),range=limits(data);if(!(range.max>0))return;const step=stepSize(data);let target=Math.round(number(value)/step)*step;target=Math.max(range.min,Math.min(range.max,target));slider.value=String(target);slider.dispatchEvent(new Event('input',{bubbles:true}));scheduleSync()}
    function sizingTarget(kind){const data=tableState(),game=data&&data.game||{},legal=data&&data.legal||{},range=limits(data);const self=(data&&Array.isArray(data.players)?data.players:[]).find(function(player){return player&&player.isSelf})||{};const streetBet=number(self.streetBet),toCall=number(legal.toCall),pot=number(game.pot);if(kind==='min')return range.min;if(kind==='max')return range.max;return streetBet+toCall+(pot+toCall)*(kind==='half'?.5:1)}

    function positionOpponentBets(){
      const seats=Array.from(stage.querySelectorAll('#seats > .seat:not(.self-seat):not(.open-seat)'));
      seats.forEach(function(seat){
        const cards=seat.querySelector('.seat-cards');
        const bet=seat.querySelector('.bet-chip');
        if(!cards||!bet)return;
        const seatRect=seat.getBoundingClientRect(),cardsRect=cards.getBoundingClientRect(),betRect=bet.getBoundingClientRect();
        if(!seatRect.width||!cardsRect.width)return;
        const width=Math.max(38,betRect.width||0),height=Math.max(20,betRect.height||0);
        const gap=3;
        const left=Math.round(cardsRect.left-seatRect.left-width-gap);
        const top=Math.round(cardsRect.top-seatRect.top+(cardsRect.height-height)/2);
        bet.classList.add('sivel-opponent-bet-left');
        bet.style.left=left+'px';
        bet.style.top=top+'px';
      });
    }

    function positionHandResult(){
      if(!resultBox||!board||resultBox.classList.contains('hidden'))return;
      const stageRect=stage.getBoundingClientRect(),boardRect=board.getBoundingClientRect(),resultRect=resultBox.getBoundingClientRect();
      if(!stageRect.width||!boardRect.width||!resultRect.width)return;
      const left=Math.round(boardRect.left-stageRect.left+boardRect.width/2);
      const top=Math.max(72,Math.round(boardRect.top-stageRect.top-resultRect.height-12));
      resultBox.style.setProperty('left',left+'px','important');
      resultBox.style.setProperty('top',top+'px','important');
    }

    function sync(){
      syncQueued=false;
      const data=tableState(),game=data&&data.game,legal=data&&data.legal||{};
      const playing=!!(data&&data.stage==='playing'&&game);
      screen.classList.toggle('sivel-action-dock-screen',playing);
      stage.classList.toggle('sivel-action-console-active',playing);
      document.body.classList.toggle('sivel-table-play-mode',playing);
      actionZone.classList.toggle('sivel-console-waiting',!playing);
      const range=limits(data),canRaise=playing&&!!legal.canAct&&!!legal.canRaise&&range.max>=range.min&&range.max>0,current=number(slider.value);
      quickButtons.forEach(function(button){button.disabled=!canRaise});
      stepButtons.forEach(function(button){button.disabled=!canRaise});
      allIn.disabled=!canRaise;
      if(betValue)betValue.textContent=current?format(current):'—';
      const stepValue=betPanel&&betPanel.querySelector('#sivelSidebarBetStepValue');
      if(stepValue)stepValue.textContent=current?format(current):'—';
      if(statusMirror)statusMirror.textContent=status.textContent||'Waiting for the table.';
      requestAnimationFrame(function(){positionOpponentBets();positionHandResult()});
    }
    function scheduleSync(){if(syncQueued)return;syncQueued=true;(window.requestAnimationFrame||setTimeout)(sync)}

    if(betPanel){
      betPanel.addEventListener('click',function(event){
        const sizeButton=event.target&&event.target.closest?event.target.closest('[data-size]'):null;
        if(sizeButton){if(!sizeButton.disabled)setRaiseTarget(sizingTarget(sizeButton.dataset.size));return}
        const stepButton=event.target&&event.target.closest?event.target.closest('[data-step]'):null;
        if(stepButton&&!stepButton.disabled){const data=tableState();setRaiseTarget(number(slider.value)+number(stepButton.dataset.step)*stepSize(data))}
      });
    }
    allIn.addEventListener('click',function(){if(allIn.disabled)return;const data=tableState(),range=limits(data);setRaiseTarget(range.max);requestAnimationFrame(function(){if(!raiseBtn.disabled)raiseBtn.click()})});
    slider.addEventListener('input',scheduleSync);
    const observer=new MutationObserver(scheduleSync);
    observer.observe(screen,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','class','value']});
    window.addEventListener('resize',scheduleSync);
    setInterval(scheduleSync,350);
    sync();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initSivelActionDock,{once:true});else initSivelActionDock();
})();
</script>`;

  if (!source.includes('</head>') || !source.includes('</body>')) fail('V64 professional controls could not find the multiplayer document boundaries.');
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
  pkg.version = '2.2.7';
  pkg.description = 'Sivel Poker clean V57 baseline with chat-first interface, closer opponent wagers and protected hand-result placement.';
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
  assert.ok(multiplayer.includes("classList.toggle('sivel-public-live',!!(state&&state.isPublic))"));\n  assert.match(multiplayer, /${ACTION_DOCK_MARKER}/);\n  assert.ok(multiplayer.includes("actionZone.id='sivelActionDock'"));\n  assert.ok(multiplayer.includes('sivelAllInBtn'));\n  assert.ok(multiplayer.includes('data-size=\"half\"'));\n  assert.ok(multiplayer.includes('sivel-action-zone'));\n  assert.ok(multiplayer.includes('sivel-sidebar-bet-control'));\n  assert.ok(multiplayer.includes('sivel-sidebar-utilities'));\n  assert.ok(multiplayer.includes('margin:34px auto 0!important'));
  assert.ok(multiplayer.includes('data-step=\"-1\"'));
  assert.ok(multiplayer.includes('#raiseSlider{display:none!important}'));
  assert.ok(multiplayer.includes("history.insertAdjacentElement('afterend',utilityPanel)"));
  assert.ok(multiplayer.includes('sivel-top-table-meta'));
  assert.ok(multiplayer.includes('sivel-chat-priority'));
  assert.ok(multiplayer.includes('sivel-opponent-bet-left'));
  assert.ok(multiplayer.includes('const gap=3'));
  assert.ok(multiplayer.includes('sivel-hand-result-banner'));
  assert.ok(multiplayer.includes('positionHandResult'));
  assert.ok(multiplayer.includes('boardRect.top-stageRect.top-resultRect.height-12'));
  assert.ok(multiplayer.includes('rightPanel.appendChild(betPanel)'));
  assert.ok(multiplayer.includes("stage.querySelectorAll('#seats > .seat:not(.self-seat):not(.open-seat)')"));\n  assert.doesNotMatch(multiplayer, /sivel-player-console-v60/);
  assert.doesNotMatch(multiplayer, /sivel-pro-player-controls-runtime-v63/);\n  assert.match(multiplayer, /<\\/html>\\s*$/i);\n});\n\ntest('inline multiplayer scripts parse', () => {\n  const multiplayer = read('public/multiplayer.html');\n  const scripts = [...multiplayer.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(match => match[1]);\n  assert.ok(scripts.length > 0);\n  for (const [index, source] of scripts.entries()) {\n    assert.doesNotThrow(() => new vm.Script(source, { filename: 'multiplayer-inline-' + index + '.js' }));\n  }\n});\n\ntest('server contains the authoritative V57 baseline', () => {\n  const server = read('server.js');\n  assert.match(server, /clean-baseline-v57|${BASELINE_MARKER}/);\n  assert.match(server, /turnId/);\n  assert.match(server, /server/);\n});\n`;
  fs.mkdirSync(TEST_DIR, { recursive: true });
  writeAtomic(path.join(TEST_DIR, 'v57-baseline.test.js'), test);
}

function writeBaselineNotes() {
  const notes = `# Sivel Poker V57 clean baseline\n\nV57 permanently bakes the confirmed V55 server-authority work and the V56 public-seat profile stability fix into normal source files.\n\n## Structural changes\n\n- \`npm start\` now runs only \`node server.js\`.\n- The multiplayer client is a readable file at \`public/multiplayer.html\`.\n- \`public/index.html\` loads that client template instead of storing a large base64 payload.\n- V55/V56 scripts are retained under \`legacy-patches/\` for audit and rollback only.\n- \`npm test\` includes V57 regression checks.\n\n## Preserved behavior\n\n- Server-owned turn timers, hand IDs and turn IDs.\n- Strict check, call and raise validation.\n- Public-table auto play, top-ups and all-in runouts.\n- Clickable opponent profiles.\n- One stable identity card per occupied live-table seat.\n- Visible local-player profile and chip count.\n- Ghost-seat cleanup.\n- Waiting-table seats cannot survive into active hands as duplicate profiles.
- Public live tables do not render a second player roster beside the table.\n- Fold, check/call, raise and all-in reserve a protected center lane around the local cards, chips and profile.\n- Sit out, leave-after-hand, top-up and host controls are stacked directly beneath Hand History in the left sidebar.\n- Raise sizing is fully redesigned as presets plus minus/plus stepping in the right sidebar; the range slider is hidden.\n- The table, center logo and community board retain their approved positions.\n- The pot sits beneath the community cards with enough clearance to leave the table branding readable.\n- Opponent wager and blind chips sit three pixels from the left edge of their cards without overlapping them.\n- Hand winners and fold results appear in the protected lane immediately above the community cards.\n\n## Next development rule\n\nEdit \`server.js\`, \`public/index.html\` and \`public/multiplayer.html\` directly. Do not add another startup patch script.\n`;
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
    console.log('V57 clean baseline is already installed; applying the V65 hand-result and wager-spacing polish and verifying them now.');
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
