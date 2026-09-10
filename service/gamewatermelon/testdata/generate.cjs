// Explicit fixture maintenance only: node service/gamewatermelon/testdata/generate.cjs
// Go and Vitest independently verify this ONE file against the shipped engines.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const E = new Function(fs.readFileSync(path.join(root, 'web/public/assets/games/watermelon/engine.js'), 'utf8') + ';return MelonMelt;')();
const fixtures = [];
function scenario(name, seed, duration, spacing, position, setup) {
  const game = E.createGame({ seed }); E.start(game);
  if (setup) setup(game);
  const initial_state = setup ? E.snapshot(game) : undefined;
  const segments = [], events = [];
  let pending = [], boundary = 311;
  for (;;) {
    if (spacing && game.tickCount % spacing === 0 && game.phase === 'playing') {
      const x = position(game, events.length);
      if (E.drop(game, x)) {
        const event = { tick: game.tickCount, x };
        events.push(event); pending.push(event);
      }
    }
    if (game.tickCount === boundary || game.tickCount === duration || game.phase === 'over') {
      segments.push({ to_tick: game.tickCount, drops: pending, expected: E.snapshot(game) });
      pending = []; boundary += 577;
    }
    if (game.tickCount >= duration || game.phase === 'over') break;
    E.tick(game); game.events.length = 0;
  }
  fixtures.push({ name, seed, ...(initial_state ? { initial_state } : {}), segments });
  console.log(name, 'ticks', game.tickCount, 'drops', game.drops, 'highest', game.highest, 'score', game.score, 'bodies', game.world.bodies.length, 'phase', game.phase);
}
scenario('clock-only-and-empty-checkpoints', '0123456789abcdef0123456789abcdef', 2000, 0);
scenario('long-seeded-center-merge-chains', '0123456789abcdef0123456789abcdef', 18000, 91, () => 180);
scenario('walls-and-pressed-piles', 'ffffffffffffffffffffffffffffffff', 12000, 73, (_, i) => [0, 360, 125, 235, 180][i % 5]);
scenario('alternating-aims-long-replay', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 24000, 95, (_, i) => 52 + (i * 83 % 257));
scenario('simultaneous-contacts-single-consumption', '00000000000000000000000000000000', 600, 0, null, game => {
  game.world.bodies = [0, 0, 0, 0, 1].map((level, i) => E.createFruit(i + 1, level, 102 + i * 26, 350));
  for (const body of game.world.bodies) body.age = 1;
  game.nextId = 6;
});
scenario('watermelon-synthesis-material-bridge', '11111111111111111111111111111111', 700, 0, null, game => {
  game.world.bodies = [E.createFruit(1, 7, 107, 380), E.createFruit(2, 7, 252, 380)];
  for (const body of game.world.bodies) body.age = 1;
  game.nextId = 3;
});
scenario('sustained-overflow-ends-on-exact-tick', '22222222222222222222222222222222', 1600, 0, null, game => {
  game.world.bodies = Array.from({ length: 5 }, (_, i) => E.createFruit(i + 1, 8, 175 + i % 2 * 12, 430 - i * 170));
  for (const body of game.world.bodies) { body.age = 2; body.touched = true; }
  game.nextId = 6;
});
fs.writeFileSync(path.join(__dirname, 'fixtures.json'), JSON.stringify({ version: E.VERSION, fixtures }) + '\n');
