'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('V57 starts the server without runtime patch scripts', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.sivelBaseline, 'V57');
  assert.equal(pkg.scripts.start, 'node server.js');
  assert.doesNotMatch(pkg.scripts.start, /apply-|patch/i);
});

test('multiplayer client is external and readable', () => {
  const index = read('public/index.html');
  const multiplayer = read('public/multiplayer.html');
  assert.match(index, /SIVEL_CLEAN_BASELINE_V57/);
  assert.match(index, /multiplayerTemplatePromise/);
  assert.doesNotMatch(index, /const encoded='/);
  assert.doesNotMatch(index, /atob\(encoded\)/);
  assert.match(multiplayer, /SIVEL_CLEAN_MULTIPLAYER_V57/);
  assert.match(multiplayer, /SIVEL_SERVER_AUTHORITY_CLIENT_V55/);
  assert.match(multiplayer, /SIVEL_PUBLIC_SEAT_PROFILE_STABILITY_V56/);
  assert.match(multiplayer, /SIVEL_V57_SEAT_ROOT_OWNERSHIP_FIX/);
  assert.ok(multiplayer.includes('!ownedRoots.has(node)'));
  assert.ok(multiplayer.includes('sivelStableSeatNodes.clear()'));
  assert.ok(multiplayer.includes('data-player-index="${originalIndex}"'));
  assert.match(multiplayer, /SIVEL_V57_PUBLIC_ROSTER_DUPLICATE_FIX/);
  assert.ok(multiplayer.includes("$('gamePlayers').innerHTML=state.isPublic?'':activePlayerRows+publicSideInviteRows(activeOpenSeats)"));
  assert.ok(multiplayer.includes("classList.toggle('sivel-public-live',!!(state&&state.isPublic))"));
  assert.match(multiplayer, /SIVEL_V57_PRO_PLAYER_CONTROLS_V67/);
  assert.match(multiplayer, /SIVEL_V57_PUBLIC_FINAL_POLISH_V71/);
  assert.ok(multiplayer.includes('slider.step=1;slider.value=max;'));
  assert.ok(multiplayer.includes("$('nextHandBtn').classList.add('hidden')"));
  assert.ok(multiplayer.includes('#nextHandBtn{display:none!important}'));
  assert.ok(multiplayer.includes('#callBtn{left:max(126px,calc(50% - 292px));bottom:46px;width:136px!important'));
  assert.ok(multiplayer.includes("actionZone.id='sivelActionDock'"));
  assert.ok(multiplayer.includes('sivelAllInBtn'));
  assert.ok(multiplayer.includes('data-size="half"'));
  assert.ok(multiplayer.includes('sivel-action-zone'));
  assert.ok(multiplayer.includes('sivel-sidebar-bet-control'));
  assert.ok(multiplayer.includes('sivel-sidebar-utilities'));
  assert.ok(multiplayer.includes('margin:34px auto 0!important'));
  assert.ok(multiplayer.includes('data-step="-1"'));
  assert.ok(multiplayer.includes('#raiseSlider{display:none!important}'));
  assert.ok(multiplayer.includes("history.insertAdjacentElement('afterend',utilityPanel)"));
  assert.ok(multiplayer.includes('sivel-top-table-meta'));
  assert.ok(multiplayer.includes('sivel-chat-priority'));
  assert.ok(multiplayer.includes('sivel-opponent-bet-left'));
  assert.ok(multiplayer.includes('const gap=3'));
  assert.ok(multiplayer.includes('betRect.width||bet.offsetWidth||30'));
  assert.ok(multiplayer.includes('sivel-hand-result-banner'));
  assert.ok(multiplayer.includes('positionHandResult'));
  assert.ok(multiplayer.includes('boardRect.top-stageRect.top-resultRect.height-12'));
  assert.ok(multiplayer.includes("cards.querySelector('.seat-card')"));
  assert.ok(multiplayer.includes('scale(.875)'));
  assert.ok(!multiplayer.includes(' · YOU'), 'Local profile must not append a YOU suffix.');
  assert.ok(multiplayer.includes('rightPanel.appendChild(betPanel)'));
  assert.ok(multiplayer.includes("stage.querySelectorAll('#seats > .seat:not(.self-seat):not(.open-seat)')"));
  assert.doesNotMatch(multiplayer, /sivel-player-console-v60/);
  assert.doesNotMatch(multiplayer, /sivel-pro-player-controls-runtime-v63/);
  assert.match(multiplayer, /<\/html>\s*$/i);
});

test('solo tables use the approved professional interface', () => {
  const index = read('public/index.html');
  assert.match(index, /SIVEL_V57_SOLO_PRO_TABLE_V70/);
  assert.ok(index.includes('sivelSoloActionZone'));
  assert.ok(index.includes('sivel-solo-action-zone'));
  assert.ok(index.includes('sivel-solo-sidebar-bet'));
  assert.ok(index.includes('data-solo-size="half"'));
  assert.ok(index.includes('data-solo-step="-1"'));
  assert.ok(index.includes('sivel-solo-opponent-bet-left'));
  assert.ok(index.includes('sivel-solo-hand-result'));
  assert.ok(index.includes('sivel-hand-result-banner'));
  assert.ok(index.includes('width:min(440px,calc(100% - 30px))!important'));
  assert.ok(index.includes("stage.appendChild(resultBox)"));
  assert.ok(index.includes('sivel-solo-stats-panel'));
  assert.ok(index.includes('enforceSoloMetadataVisibility'));
  assert.ok(index.includes('syncQueued=false;placeSoloStats();enforceSoloMetadataVisibility();'));
  assert.ok(!index.includes(",> *"));
  assert.ok(index.includes("labelText==='DIFFICULTY'"));
  assert.ok(index.includes("label.textContent.trim().toUpperCase()==='LEVEL'"));
  assert.ok(index.includes('data-sivel-solo-hidden'));
  assert.ok(index.includes('placeSoloStats'));
  assert.ok(index.includes("history.insertAdjacentElement('afterend',panel)"));
  assert.ok(index.includes('margin:34px auto 0!important'));
  assert.ok(index.includes("stage.querySelectorAll('.seat')"));
  assert.ok(index.includes('isSoloSelfSeat'));
  assert.ok(index.includes('firstVisibleCard'));
  assert.ok(index.includes("cards.appendChild(bet)"));
  assert.ok(index.includes('const gap=3'));
  assert.ok(index.includes("setImportant(bet,'left',left+'px')"));
  assert.ok(index.includes('protectLocalDealerBadge'));
  assert.ok(index.includes("safeLeft=Math.ceil(badgeRect.right-stageRect.left+12)"));
  assert.ok(index.includes("rightPanel.appendChild(betPanel)"));
  assert.ok(index.includes('margin-top:auto!important'));
  assert.ok(index.includes('scale(.875)'));
  assert.ok(index.includes('sivelSoloAllInBtn'));
  assert.ok(index.includes('sivel-solo-next-hand'));
  assert.ok(!index.includes(' · YOU'), 'Solo profile must not append a YOU suffix.');
  const runtime = index.match(/<script id="sivel-solo-professional-table-runtime-v70">([\s\S]*?)<\/script>/);
  assert.ok(runtime, 'Solo professional runtime is missing.');
  assert.doesNotThrow(() => new vm.Script(runtime[1], { filename: 'solo-professional-v70.js' }));
});

test('inline multiplayer scripts parse', () => {
  const multiplayer = read('public/multiplayer.html');
  const scripts = [...multiplayer.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const [index, source] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(source, { filename: 'multiplayer-inline-' + index + '.js' }));
  }
});

test('server contains the authoritative V57 baseline', () => {
  const server = read('server.js');
  assert.match(server, /clean-baseline-v57|SIVEL_CLEAN_BASELINE_V57/);
  assert.match(server, /turnId/);
  assert.match(server, /server/);
  assert.match(server, /SIVEL_V57_PUBLIC_FINAL_POLISH_V71/);
  assert.match(server, /function schedulePrivatePlay/);
  assert.match(server, /Next hand deals automatically/);
  assert.match(server, /scheduleRoomPlay\(room, PUBLIC_NEXT_HAND_MS\)/);
});
