# Sivel Poker V57 clean baseline

V57 permanently bakes the confirmed V55 server-authority work and the V56 public-seat profile stability fix into normal source files.

## Structural changes

- `npm start` now runs only `node server.js`.
- The multiplayer client is a readable file at `public/multiplayer.html`.
- `public/index.html` loads that client template instead of storing a large base64 payload.
- V55/V56 scripts are retained under `legacy-patches/` for audit and rollback only.
- `npm test` includes V57 regression checks.

## Preserved behavior

- Server-owned turn timers, hand IDs and turn IDs.
- Strict check, call and raise validation.
- Public-table auto play, top-ups and all-in runouts.
- Clickable opponent profiles.
- One stable identity card per occupied live-table seat.
- Visible local-player profile and chip count.
- Ghost-seat cleanup.
- Waiting-table seats cannot survive into active hands as duplicate profiles.
- Public live tables do not render a second player roster beside the table.
- Fold, check/call, raise and all-in reserve a protected center lane around the local cards, chips and profile.
- Sit out, leave-after-hand, top-up and host controls are stacked directly beneath Hand History in the left sidebar.
- Raise sizing is fully redesigned as presets plus minus/plus stepping in the right sidebar; the range slider is hidden.
- The table, center logo and community board retain their approved positions.
- The pot sits beneath the community cards with enough clearance to leave the table branding readable.
- Opponent wager and blind chips are anchored three pixels from the first rendered card, without overlap.
- Hand winners and fold results appear in the protected lane immediately above the community cards at the final approved reduced size.
- The local player profile displays the normal player name without an added YOU suffix.
- Solo tables use the same approved compact action layout, protected center lane, board/pot spacing and exact winner/fold banner as public tables.
- Solo opponent wagers are re-parented into the card rack and anchored three pixels from the first visible card, so rerenders cannot restore the old offset.
- Solo raise sizing uses presets plus minus/plus stepping at the bottom of the right sidebar, while Next Hand remains available there.
- The duplicate lower-left difficulty tile and obsolete game-header level tile are continuously hidden after every solo rerender without removing their backing state nodes.
- The solo raise button dynamically reserves space for the local dealer badge and cannot overlap it.
- Online-only chat, room codes, sit-out, leave-after-hand and top-up controls are not added to solo play.
- Public top-up sliders use one-chip precision so the exact table maximum is always reachable.
- Public Fold/Call spacing mirrors Raise/All-In around the protected card lane.
- Private multiplayer tables hide the manual Next Hand control and deal automatically after the result display.

## Next development rule

Edit `server.js`, `public/index.html` and `public/multiplayer.html` directly. Do not add another startup patch script.
