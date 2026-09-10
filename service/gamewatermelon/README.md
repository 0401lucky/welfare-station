# Watermelon replay contract

`engine.go` and `web/public/assets/games/watermelon/engine.js` simulate the same
16-particle soft membrane. Collision uses the deformed polygon, surface-distance
constraints and signed-area preservation. Radius-only collisions or cosmetic
squash cannot replace these mechanics without changing the game contract.

## Time, input and persistence

- Version: `watermelon-v1`. Simulation runs at 120 Hz; the browser animation-frame
  accumulator, pause state, preview, audio and best score are not authoritative.
- A drop is `{tick, x}`: advance to the absolute completed tick, then drop at the
  integer logical x in `[0, 360]`. The engine clamps x for the selected fruit.
  Only successful drops count; cooldown is 58 ticks. A boundary drop may change
  `drops` without changing `tick`, and time-only segments change `tick` without a
  drop. The service therefore validates **both** `base_tick` and `base_moves`.
- Held/next fruit come from ASCII seed + spawn index. Only levels 0–2 spawn.
  FNV-1a hashes the seed/index string, then Murmur3 `fmix32` avalanches its bits
  before uniform three-way bucketing. Mapping raw FNV high bits directly caused
  neighbouring decimal indices to yield long fixed fruit blocks. Both engines
  must use the same unsigned shifts and wrapping 32-bit multiplications; reward
  mode never uses `Math.random()` for individual drops.
  Stage radii are `[14,18,23,29,37,46,58,73,92]`; IDs correspond to grape, cherry,
  mandarin, lemon, kiwi, peach, persimmon, melon and watermelon.
- Request caps: 600 ticks, 32 drops and 16 KiB. Clients checkpoint about every
  300 ticks and drain a longer unsaved tail in sequential bounded chunks.
- The cumulative simulated tick may lead session `started_at` wall time by at
  most 240 ticks (2 seconds). Checkpoint renewal does not reset that allowance.
- At 64 active bodies the successful capacity-reaching drop immediately ends
  play, allowing ordinary settlement. Sustained eligible overflow ends at 300
  warning ticks. Replay rejects events or extra ticks after that exact end.
- `highest=-1` means no synthesis, even if a spawned fruit would match a configured
  tier. Reward tile is `2^(highest+1)` only after an actual merge. Shared service
  settlement pays one highest eligible tier, with existing claims/caps/budgets.

`Snapshot` is the only persistence and recovery format. It carries
`version,tick,drops,score,highest,next_id,cooldown_ticks,overflow_ticks,phase,bodies`.
Each body has `id,level,age_ticks,touched,nodes`; nodes are integer
`[x,y,px,py]` tuples at scale 100000. Node coordinates are quantized after every
constraint iteration and after friction/merging using `floor(value*100000+.5)`
(including negative values). Rebuild rest vectors, material area, bounds and
scratch state on restore. Never serialize contacts/world references.

Canonical snapshots are capped at 60 KiB; the structurally worst permitted
64-body snapshot is 50,040 bytes, fitting the existing MySQL `TEXT` payload.
Invalid versions, oversized saves and malformed particles are rejected rather
than replaced by a client-provided state.

## Browser API

The classic script exposes `MelonMelt` with existing `createGame/start/reset`,
`pause/resume`, `aim/drop/step`, and `createWorld/createFruit/stepWorld/measure/area`.

- `tick(game)` advances exactly one simulation tick; returns false after end/pause.
- `initial(seed)` returns a canonical initial snapshot.
- `snapshot(game)` returns canonical state, normalizing browser pause to playing.
- `restore(seed, snapshot, {best?})` returns a new game from the server particles.
- `replay(seed, snapshot, toTick, drops)` returns a new snapshot or throws; it
  never mutates its input snapshot and uses the same segment caps as the server.

The parent page owns authenticated requests. The browser cannot send seed,
score, fruit levels, particle state, merge claims or reward metrics as inputs.
On a lost response/409, reload server state, trim confirmed drops, then replay
only the remaining inputs. Updating tokens without rebuilding the game is unsafe.

## Verification and maintenance

```sh
go test ./service/gamewatermelon ./service ./controller
go test ./service/gamewatermelon -run '^$' -bench . -benchtime=1x -benchmem
cd web
npm test -- src/lib/__tests__/watermelonParity.test.ts
```

`testdata/fixtures.json` is one shared fixture file consumed by Go and Vitest.
Its expected particles come from uninterrupted real browser-engine play; tests
restore snapshots at odd boundaries and assert exact state equality. Coverage
includes 24,000-tick play, pressured walls, simultaneous merges, watermelon
synthesis and the exact top-out tick. The explicit maintenance generator is
`node service/gamewatermelon/testdata/generate.cjs`; do not regenerate fixtures
to hide a one-sided mismatch. Review gameplay and both engines first.

`testdata/spawn-vectors.json` independently locks seed/index draws in both
languages, including decimal boundaries and distant random-access indices.
Spawn tests also check the reported all-small-fruit seed's opening, all three
allowed stages, repeatability and a 65,536-draw sample with an adjacent-change
rate near 2/3. The test rejects both index-induced runs and a forced-no-repeat
workaround. Verify these vectors in Go and JS before intentionally regenerating
particle fixtures for any RNG change.

Use literal ring vectors and equivalent ordered arithmetic; physics must not
depend on trig or `hypot`. Go's explicit `float64` conversions prevent fused
arithmetic from changing JS rounding on ARM64. The native pair-membership table
is a scratch optimization only: preserve first-contact order and the last pair
orientation used by JS `Map` before merging.

Local Windows amd64 i7-12650H single-sample measurements after scratch reuse:
64 colliding bodies × 600 steps ~0.99 s, 100 KiB / 81 allocations; legal crowded
19-body 577-tick segment ~0.38 s; ordinary 4-body segment ~20–40 ms. These are
local capacity measurements, not deployment or mobile performance guarantees.
