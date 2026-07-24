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
const ACTION_DOCK_MARKER = 'SIVEL_V57_SPLIT_ACTION_CONTROLS';

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
  const legacyStylePattern = /\n?<style id="sivel-in-table-action-dock-v58">[\s\S]*?<\/style>/g;
  const legacyRuntimePattern = /\n?<script id="sivel-in-table-action-dock-runtime-v58">[\s\S]*?<\/script>/g;
  const currentStylePattern = /\n?<style id="sivel-split-table-controls-v59">[\s\S]*?<\/style>/g;
  const currentRuntimePattern = /\n?<script id="sivel-split-table-controls-runtime-v59">[\s\S]*?<\/script>/g;
  source = source.replace(legacyStylePattern, '').replace(legacyRuntimePattern, '');
  source = source.replace(currentStylePattern, '').replace(currentRuntimePattern, '');

  if (!source.includes('window.SivelGetTableState=()=>state;')) {
    const stateMatches = [...source.matchAll(/let\s+state\s*=\s*[^;]+;/g)];
    if (stateMatches.length !== 1) fail(`V59 split controls expected one multiplayer state declaration, found ${stateMatches.length}.`);
    source = source.replace(/let\s+state\s*=\s*[^;]+;/, match => `${match}\nwindow.SivelGetTableState=()=>state;`);
  }

  const style = `
<style id="sivel-split-table-controls-v59">
/* ${ACTION_DOCK_MARKER} — compact split controls preserve the player seat and keep the board unobstructed. */
#gameScreen.sivel-action-dock-screen{min-height:0}
#gameScreen.sivel-action-dock-screen .table-wrap{position:relative;min-height:0}
.controls.sivel-controls-relocated{display:none!important}
.sivel-table-utility-panel{margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.07)}
.sivel-table-utility-panel .table-tools{margin:0!important}
.sivel-table-utility-panel .host-row{margin-top:9px!important}
#tableStage.sivel-action-dock-active .poker-table{bottom:15%!important}
#tableStage.sivel-action-dock-active .center{top:44%!important}
#tableStage.sivel-action-dock-active .center .board{margin:0 auto 26px!important}
#tableStage.sivel-action-dock-active .center .pot{
  position:absolute!important;left:50%!important;right:auto!important;top:-48px!important;bottom:auto!important;
  margin:0!important;transform:translateX(-50%)!important;transform-origin:center!important;z-index:14!important;
  white-space:nowrap!important;pointer-events:none!important
}
#tableStage.sivel-action-dock-active .seat.self-seat{bottom:10px!important}
#tableStage.sivel-action-dock-active .seat.slot-lower-left,
#tableStage.sivel-action-dock-active .seat.slot-lower-right{bottom:132px!important}
.sivel-split-controls{position:absolute;inset:0;z-index:90;pointer-events:none}
.sivel-dock-status-slot{
  position:absolute;right:12px;bottom:73px;width:min(400px,43%);pointer-events:none
}
.sivel-split-controls #gameStatus.sivel-dock-status{
  display:flex!important;align-items:center!important;justify-content:center!important;
  width:100%!important;min-width:0!important;min-height:29px!important;margin:0!important;padding:5px 10px!important;
  position:relative!important;inset:auto!important;transform:none!important;border-radius:10px!important;
  border:1px solid rgba(79,111,138,.46)!important;background:rgba(5,13,20,.92)!important;
  box-shadow:0 8px 20px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.04)!important;
  color:#b9cbd8!important;font-size:9px!important;font-weight:850!important;letter-spacing:.035em!important;
  line-height:1.2!important;text-align:center!important;z-index:1!important;pointer-events:none!important
}
.sivel-split-controls #gameStatus.sivel-result-placeholder{visibility:hidden!important}
.sivel-bet-panel,
.sivel-action-panel{
  position:absolute;bottom:12px;pointer-events:auto;border:1px solid rgba(85,116,141,.5);
  background:linear-gradient(180deg,rgba(13,24,35,.95),rgba(5,11,17,.965));
  box-shadow:0 12px 27px rgba(0,0,0,.46),inset 0 1px 0 rgba(255,255,255,.055);
  backdrop-filter:blur(13px)
}
.sivel-bet-panel{left:12px;width:min(270px,29%);padding:6px;border-radius:13px}
.sivel-action-panel{
  right:12px;width:min(400px,43%);padding:6px;border-radius:13px;
  display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px
}
.sivel-bet-panel .raise-box{
  display:grid!important;grid-template-columns:minmax(0,1fr) 70px!important;grid-template-rows:22px 25px!important;
  gap:4px 7px!important;width:100%!important;min-height:55px!important;padding:4px 7px!important;margin:0!important;
  border:0!important;border-radius:9px!important;background:rgba(4,11,17,.58)!important;box-shadow:none!important
}
.sivel-quick-bets{grid-column:1/-1;display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
.sivel-quick-bet{
  min-width:0;height:22px;padding:0 4px;border-radius:6px;border:1px solid rgba(92,125,151,.42);
  background:linear-gradient(180deg,#162635,#0a141e);color:#adbfcc;font-size:7px;font-weight:950;letter-spacing:.07em;cursor:pointer
}
.sivel-quick-bet:hover:not(:disabled){border-color:#dfbd61;color:#ffe39a;filter:brightness(1.08)}
.sivel-quick-bet:disabled{opacity:.28;cursor:not-allowed}
.sivel-bet-panel .raise-box input[type="range"]{grid-column:1;grid-row:2;width:100%;margin:0!important;align-self:center}
.sivel-bet-panel .raise-total{
  grid-column:2;grid-row:2;min-width:0!important;display:flex!important;flex-direction:column!important;
  align-items:flex-end!important;justify-content:center!important;line-height:1!important
}
.sivel-bet-panel .raise-total small{font-size:6px!important;color:#708699!important}
.sivel-bet-panel .raise-total strong{font-size:12px!important;color:#f0cf7a!important}
.sivel-action-panel .action-btn{
  min-width:0!important;height:48px!important;padding:5px 6px!important;border-radius:9px!important;
  font-size:10px!important;font-weight:950!important;letter-spacing:.02em!important
}
.sivel-action-panel .sivel-all-in{
  border:1px solid #d98c2d!important;background:linear-gradient(180deg,#c95127,#6f1b13)!important;
  color:#fff0d3!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.13),0 5px 12px rgba(0,0,0,.28)!important
}
.sivel-action-panel .action-btn:disabled{opacity:.32!important;filter:saturate(.45)!important;cursor:not-allowed!important}
.sivel-split-controls.sivel-dock-waiting .sivel-bet-panel,
.sivel-split-controls.sivel-dock-waiting .sivel-action-panel{display:none!important}
.sivel-split-controls.sivel-dock-waiting .sivel-dock-status-slot{
  left:50%;right:auto;top:50%;bottom:auto;width:min(520px,calc(100% - 30px));transform:translate(-50%,-50%)
}
@media(min-width:1181px){
  #gameScreen.sivel-action-dock-screen{height:100vh;overflow:hidden}
  #gameScreen.sivel-action-dock-screen>.shell{height:100%;display:flex;flex-direction:column;padding-top:10px;padding-bottom:12px}
  #gameScreen.sivel-action-dock-screen .topbar{flex:0 0 auto}
  #gameScreen.sivel-action-dock-screen .game-layout{flex:1;min-height:0;margin-top:10px;align-items:stretch}
  #gameScreen.sivel-action-dock-screen .table-wrap{height:100%;display:flex;min-height:0}
  #gameScreen.sivel-action-dock-screen #tableStage{height:100%!important;min-height:570px;flex:1 1 auto;width:100%}
  #gameScreen.sivel-action-dock-screen .side-panel{height:100%;min-height:0!important;overflow:auto}
}
@media(max-width:1380px) and (min-width:901px){
  #tableStage.sivel-action-dock-active .seat.self-seat{bottom:92px!important}
  #tableStage.sivel-action-dock-active .seat.slot-lower-left,
  #tableStage.sivel-action-dock-active .seat.slot-lower-right{bottom:160px!important}
  .sivel-dock-status-slot{bottom:82px}
  .sivel-bet-panel{width:min(245px,35%)}
  .sivel-action-panel{width:min(355px,51%)}
}
@media(max-width:900px){
  #tableStage.sivel-action-dock-active .seat.self-seat{bottom:166px!important}
  #tableStage.sivel-action-dock-active .seat.slot-lower-left,
  #tableStage.sivel-action-dock-active .seat.slot-lower-right{bottom:238px!important}
  .sivel-bet-panel{left:7px;right:7px;bottom:64px;width:auto;padding:5px}
  .sivel-action-panel{left:7px;right:7px;bottom:7px;width:auto;padding:5px}
  .sivel-dock-status-slot{left:7px;right:7px;bottom:125px;width:auto}
  .sivel-bet-panel .raise-box{grid-template-columns:minmax(0,1fr) 74px!important}
}
@media(max-width:620px){
  #tableStage.sivel-action-dock-active .seat.self-seat{bottom:220px!important}
  #tableStage.sivel-action-dock-active .seat.slot-lower-left,
  #tableStage.sivel-action-dock-active .seat.slot-lower-right{bottom:286px!important}
  .sivel-action-panel{grid-template-columns:repeat(2,1fr);bottom:7px}
  .sivel-action-panel .action-btn{height:39px!important;font-size:9px!important}
  .sivel-bet-panel{bottom:94px}
  .sivel-dock-status-slot{display:none}
}
</style>`;

  const runtime = `
<script id="sivel-split-table-controls-runtime-v59">
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

    const dock=document.createElement('section');
    dock.id='sivelActionDock';
    dock.className='sivel-split-controls sivel-dock-waiting';
    dock.setAttribute('aria-label','Poker action controls');
    dock.innerHTML='<div class="sivel-dock-status-slot"></div><div class="sivel-bet-panel"></div><div class="sivel-action-panel"></div>';
    dock.querySelector('.sivel-dock-status-slot').appendChild(status);
    status.classList.add('sivel-dock-status');
    dock.querySelector('.sivel-bet-panel').appendChild(raiseBox);

    const quick=document.createElement('div');
    quick.className='sivel-quick-bets';
    quick.innerHTML='<button type="button" class="sivel-quick-bet" data-size="min">MIN</button><button type="button" class="sivel-quick-bet" data-size="half">½ POT</button><button type="button" class="sivel-quick-bet" data-size="pot">POT</button><button type="button" class="sivel-quick-bet" data-size="max">MAX</button>';
    raiseBox.insertBefore(quick,raiseBox.firstChild);

    const actionPanel=dock.querySelector('.sivel-action-panel');
    actionPanel.appendChild(foldBtn);
    actionPanel.appendChild(callBtn);
    actionPanel.appendChild(raiseBtn);
    const allIn=document.createElement('button');
    allIn.type='button';
    allIn.id='sivelAllInBtn';
    allIn.className='action-btn sivel-all-in';
    allIn.textContent='All-In';
    actionPanel.appendChild(allIn);

    const utilityHost=document.createElement('div');
    utilityHost.className='sivel-table-utility-panel';
    const tableTools=document.getElementById('tableTools');
    const hostRow=controls.querySelector('.host-row');
    if(tableTools)utilityHost.appendChild(tableTools);
    if(hostRow)utilityHost.appendChild(hostRow);
    const rightPanel=screen.querySelector('.game-right');
    if(rightPanel&&(tableTools||hostRow))rightPanel.appendChild(utilityHost);
    controls.classList.add('sivel-controls-relocated');
    stage.appendChild(dock);

    const quickButtons=Array.from(quick.querySelectorAll('button'));
    let syncQueued=false;

    function tableState(){
      try{return typeof window.SivelGetTableState==='function'?window.SivelGetTableState():null}
      catch(_error){return null}
    }
    function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0}
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
      const streetBet=number(self.streetBet);
      const toCall=number(legal.toCall);
      const pot=number(game.pot);
      if(kind==='min')return range.min;
      if(kind==='max')return range.max;
      const afterCall=streetBet+toCall;
      const callablePot=pot+toCall;
      return afterCall+callablePot*(kind==='half'?.5:1);
    }
    function sync(){
      syncQueued=false;
      const data=tableState(),game=data&&data.game,legal=data&&data.legal||{};
      const playing=!!(data&&data.stage==='playing'&&game);
      screen.classList.toggle('sivel-action-dock-screen',playing);
      stage.classList.toggle('sivel-action-dock-active',playing);
      document.body.classList.toggle('sivel-table-play-mode',playing);
      dock.classList.toggle('sivel-dock-waiting',!playing);
      const range=limits(data);
      const canRaise=playing&&!!legal.canAct&&!!legal.canRaise&&range.max>=range.min&&range.max>0;
      quickButtons.forEach(function(button){button.disabled=!canRaise});
      allIn.disabled=!canRaise;
    }
    function scheduleSync(){
      if(syncQueued)return;
      syncQueued=true;
      (window.requestAnimationFrame||setTimeout)(sync);
    }

    quick.addEventListener('click',function(event){
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
</script>`;

  if (!source.includes('</head>') || !source.includes('</body>')) {
    fail('V59 split controls could not find the multiplayer document boundaries.');
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
  pkg.version = '2.2.1';
  pkg.description = 'Sivel Poker clean V57 baseline with compact split table controls.';
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
  assert.ok(multiplayer.includes("classList.toggle('sivel-public-live',!!(state&&state.isPublic))"));\n  assert.match(multiplayer, /${ACTION_DOCK_MARKER}/);\n  assert.ok(multiplayer.includes("dock.id='sivelActionDock'"));\n  assert.ok(multiplayer.includes('sivelAllInBtn'));\n  assert.ok(multiplayer.includes('data-size=\"half\"'));\n  assert.match(multiplayer, /<\\/html>\\s*$/i);\n});\n\ntest('inline multiplayer scripts parse', () => {\n  const multiplayer = read('public/multiplayer.html');\n  const scripts = [...multiplayer.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)].map(match => match[1]);\n  assert.ok(scripts.length > 0);\n  for (const [index, source] of scripts.entries()) {\n    assert.doesNotThrow(() => new vm.Script(source, { filename: 'multiplayer-inline-' + index + '.js' }));\n  }\n});\n\ntest('server contains the authoritative V57 baseline', () => {\n  const server = read('server.js');\n  assert.match(server, /clean-baseline-v57|${BASELINE_MARKER}/);\n  assert.match(server, /turnId/);\n  assert.match(server, /server/);\n});\n`;
  fs.mkdirSync(TEST_DIR, { recursive: true });
  writeAtomic(path.join(TEST_DIR, 'v57-baseline.test.js'), test);
}

function writeBaselineNotes() {
  const notes = `# Sivel Poker V57 clean baseline\n\nV57 permanently bakes the confirmed V55 server-authority work and the V56 public-seat profile stability fix into normal source files.\n\n## Structural changes\n\n- \`npm start\` now runs only \`node server.js\`.\n- The multiplayer client is a readable file at \`public/multiplayer.html\`.\n- \`public/index.html\` loads that client template instead of storing a large base64 payload.\n- V55/V56 scripts are retained under \`legacy-patches/\` for audit and rollback only.\n- \`npm test\` includes V57 regression checks.\n\n## Preserved behavior\n\n- Server-owned turn timers, hand IDs and turn IDs.\n- Strict check, call and raise validation.\n- Public-table auto play, top-ups and all-in runouts.\n- Clickable opponent profiles.\n- One stable identity card per occupied live-table seat.\n- Visible local-player profile and chip count.\n- Ghost-seat cleanup.\n- Waiting-table seats cannot survive into active hands as duplicate profiles.
- Public live tables do not render a second player roster beside the table.\n- Fold, check/call, raise, all-in and bet sizing remain inside the visible table viewport without covering the local player identity.\n- The pot is anchored above the community board and cannot overlap the cards.\n\n## Next development rule\n\nEdit \`server.js\`, \`public/index.html\` and \`public/multiplayer.html\` directly. Do not add another startup patch script.\n`;
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
    console.log('V57 clean baseline is already installed; applying the V59 split table controls and verifying them now.');
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
