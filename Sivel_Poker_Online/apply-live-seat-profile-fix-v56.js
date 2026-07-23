'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const MARKER = 'SIVEL_PUBLIC_SEAT_PROFILE_STABILITY_V56';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`V56 patch could not find ${label}.`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`V56 patch found more than one ${label}; refusing an ambiguous change.`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function patchMultiplayerHtml(source) {
  if (source.includes(MARKER)) return source;

  const css = `<style id="sivel-public-seat-profile-stability-v56">
/* ${MARKER} — exactly one visible identity card per occupied public-table seat. */
#gameScreen.sivel-public-table-profile-cleanup #seats > .seat.self-seat > .seat-core,
#gameScreen #seats > .seat.self-seat[data-sivel-public-self="1"] > .seat-core,
#gameScreen #seats > .seat.self-seat > .seat-core{
  display:flex!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important
}
#gameScreen #seats > .seat.sivel-public-ghost-seat{display:none!important}
#gameScreen #seats > .seat:not(.self-seat):not(.open-seat)[data-stack]::before,
#gameScreen #seats > .seat:not(.self-seat):not(.open-seat)[data-stack]::after{
  display:none!important;content:none!important;background:none!important;border:0!important;box-shadow:none!important
}
</style>`;
  source = replaceOnce(source, '</head>', css + '\n</head>', 'multiplayer closing head tag');

  const runtime = `
/* ${MARKER} runtime */
(function(){
  let sivelSeatProfilesQueued=false;

  function sivelSeatPlayer(seat,order){
    if(!seat||!state||!Array.isArray(state.players))return null;
    const raw=seat.dataset&&seat.dataset.playerIndex;
    const index=raw==null?NaN:Number(raw);
    if(Number.isFinite(index)&&state.players[index])return state.players[index];
    try{
      const assignments=typeof visualSeatAssignments==='function'?visualSeatAssignments(state.players,state.players.length):[];
      return assignments[order]&&assignments[order].p||state.players[order]||null;
    }catch(_err){return state.players[order]||null}
  }

  function sivelBuildSeatCore(self){
    const core=document.createElement('div');
    core.className=self?'seat-core':'seat-core sivel-profile-trigger';
    core.innerHTML='<div class="avatar"></div><div class="seat-name"><strong></strong><span></span><span class="seat-status-tag hidden"></span></div>';
    return core;
  }

  function sivelNormalizeSeatProfile(seat,player){
    if(!seat||!player||seat.classList.contains('open-seat'))return;
    const self=!!player.isSelf;
    const direct=Array.from(seat.children||[]).filter(function(node){return node.classList&&node.classList.contains('seat-core')});
    let core=self?direct.find(function(node){return !node.classList.contains('sivel-profile-trigger')})
      :direct.find(function(node){return node.classList.contains('sivel-profile-trigger')});
    if(!core)core=direct[0]||null;
    if(!core){
      core=sivelBuildSeatCore(self);
      const badges=Array.from(seat.children||[]).find(function(node){return node.classList&&node.classList.contains('position-badges')});
      if(badges)seat.insertBefore(core,badges);else seat.appendChild(core);
    }

    Array.from(seat.querySelectorAll('.seat-core')).forEach(function(node){if(node!==core)node.remove()});
    core.className=self?'seat-core':'seat-core sivel-profile-trigger';
    core.removeAttribute('hidden');
    core.removeAttribute('aria-hidden');
    core.style.removeProperty('display');
    core.style.removeProperty('visibility');
    core.style.removeProperty('opacity');
    core.style.removeProperty('pointer-events');

    if(self){
      core.removeAttribute('role');core.removeAttribute('tabindex');
      if(seat.dataset)delete seat.dataset.sivelPublicSelf;
    }else{
      core.setAttribute('role','button');core.setAttribute('tabindex','0');
    }

    let avatar=core.querySelector('.avatar');
    let name=core.querySelector('.seat-name');
    if(!avatar||!name){
      core.innerHTML='<div class="avatar"></div><div class="seat-name"><strong></strong><span></span><span class="seat-status-tag hidden"></span></div>';
      avatar=core.querySelector('.avatar');name=core.querySelector('.seat-name');
    }
    let strong=name.querySelector('strong');
    let stack=Array.from(name.children||[]).find(function(node){return node.tagName==='SPAN'&&!node.classList.contains('seat-status-tag')});
    if(!strong){strong=document.createElement('strong');name.prepend(strong)}
    if(!stack){stack=document.createElement('span');name.appendChild(stack)}

    const avatarText=typeof avatarFor==='function'?String(avatarFor(player)||'♠'):String(player.avatar||'♠');
    const nameText=String(player.name||'Player')+(self?' · YOU':'');
    const chips=Math.max(0,Number(player.chips)||0).toLocaleString();
    if(avatar.textContent!==avatarText)avatar.textContent=avatarText;
    if(strong.textContent!==nameText)strong.textContent=nameText;
    if(stack.textContent!==chips)stack.textContent=chips;
  }

  function sivelNormalizePublicSeatProfiles(){
    sivelSeatProfilesQueued=false;
    if(!(state&&state.isPublic))return;
    const seats=Array.from(document.querySelectorAll('#seats > .seat'));
    seats.forEach(function(seat,order){
      const player=sivelSeatPlayer(seat,order);
      if(player)sivelNormalizeSeatProfile(seat,player);
    });
  }

  function sivelQueuePublicSeatProfiles(){
    if(sivelSeatProfilesQueued)return;
    sivelSeatProfilesQueued=true;
    const schedule=window.requestAnimationFrame||function(callback){return setTimeout(callback,0)};
    schedule(sivelNormalizePublicSeatProfiles);
  }

  sivelEnforcePublicSelfIdentity=function(root,player){
    if(!root)return;
    if(root.dataset)delete root.dataset.sivelPublicSelf;
    Array.from(root.children||[]).filter(function(node){return node.classList&&node.classList.contains('seat-core')}).forEach(function(core){
      core.removeAttribute('hidden');core.removeAttribute('aria-hidden');
      core.style.removeProperty('display');core.style.removeProperty('visibility');core.style.removeProperty('opacity');core.style.removeProperty('pointer-events');
    });
  };

  sivelFinalizePublicSeatNode=function(root,player){
    if(!root)return;
    const chips=Math.max(0,Number(player&&player.chips)||0);
    const hasHole=!!(player&&Array.isArray(player.hole)&&player.hole.some(function(card){return !!card}));
    const ghost=!!(state&&state.isPublic&&player&&(player.cashedOut||(chips<=0&&!player.inHand&&!hasHole)));
    root.classList.toggle('sivel-public-ghost-seat',ghost);
    if(ghost){root.setAttribute('hidden','');root.setAttribute('aria-hidden','true')}
    else{root.removeAttribute('hidden');root.removeAttribute('aria-hidden')}
    if(!ghost)sivelQueuePublicSeatProfiles();
  };

  const sivelStableProfileBaseRenderGame=renderGame;
  renderGame=function(){const value=sivelStableProfileBaseRenderGame.apply(this,arguments);sivelQueuePublicSeatProfiles();return value};
  const sivelStableProfileBaseWaiting=renderPublicWaitingTable;
  renderPublicWaitingTable=function(){const value=sivelStableProfileBaseWaiting.apply(this,arguments);sivelQueuePublicSeatProfiles();return value};

  const host=document.getElementById('seats');
  if(host&&window.MutationObserver){
    new MutationObserver(sivelQueuePublicSeatProfiles).observe(host,{childList:true,subtree:true});
  }
})();
`;

  return replaceOnce(source, 'async function api(path,body={}){', runtime + '\nasync function api(path,body={}){', 'multiplayer API function');
}

function patchIndex(source) {
  if (source.includes(MARKER)) return source;
  const match = source.match(/const encoded='([A-Za-z0-9+/=]+)';/);
  if (!match) throw new Error('V56 patch could not locate the embedded multiplayer client.');
  const multiplayer = Buffer.from(match[1], 'base64').toString('utf8');
  const patched = patchMultiplayerHtml(multiplayer);
  const encoded = Buffer.from(patched, 'utf8').toString('base64');
  return source.slice(0, match.index) + `const encoded='${encoded}';` + source.slice(match.index + match[0].length);
}

function main() {
  if (!fs.existsSync(INDEX_PATH)) throw new Error(`Missing ${INDEX_PATH}`);
  const original = fs.readFileSync(INDEX_PATH, 'utf8');
  const patched = patchIndex(original);
  if (patched !== original) {
    fs.writeFileSync(INDEX_PATH, patched, 'utf8');
    console.log('Applied V56 public live-table seat profile stability fix.');
  }
}

if (require.main === module) {
  try { main(); }
  catch (err) { console.error(`Sivel Poker V56 patch failed: ${err.message}`); process.exit(1); }
}

module.exports = { patchMultiplayerHtml, patchIndex };
