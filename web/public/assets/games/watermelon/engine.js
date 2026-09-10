/* watermelon-v1: the shipped browser half of service/gamewatermelon.
 * Physics uses a literal ring, ordered contacts, integer time and floor(q+.5)
 * quantization. Changing authoritative arithmetic requires new shared fixtures.
 * Renderers may inspect float nodes; only snapshot() is a persistence format. */
const MelonMelt = (() => {
  'use strict';
  const VERSION = 'watermelon-v1', TICK_RATE = 120, STEP = 1 / TICK_RATE;
  const NODES = 16, ITERATIONS = 9, GRAVITY = 760, CONTACT_SKIN = .45;
  const SCALE = 100000, MAX_BODIES = 64, MAX_SEGMENT_TICKS = 600, MAX_DROPS = 32;
  const MAX_TICK = 100000000, MAX_COORD = 4096 * SCALE;
  const COOLDOWN_TICKS = 58, MERGE_AGE_TICKS = 16, OVERFLOW_AGE_TICKS = 204, OVERFLOW_TICKS = 300;
  const OVERFLOW_GRACE = OVERFLOW_TICKS / TICK_RATE;
  const RING = Object.freeze([
    [1, 0], [.9238795325112867, .3826834323650898], [.7071067811865476, .7071067811865476], [.3826834323650898, .9238795325112867],
    [0, 1], [-.3826834323650898, .9238795325112867], [-.7071067811865476, .7071067811865476], [-.9238795325112867, .3826834323650898],
    [-1, 0], [-.9238795325112867, -.3826834323650898], [-.7071067811865476, -.7071067811865476], [-.3826834323650898, -.9238795325112867],
    [0, -1], [.3826834323650898, -.9238795325112867], [.7071067811865476, -.7071067811865476], [.9238795325112867, -.3826834323650898]
  ]);
  const AREA_UNIT = 3.0614674589207183, EDGE_UNIT = .39018064403225655;
  const LEVELS = Object.freeze([
    { id: 'grape', name: '葡萄', radius: 14, color: '#9b65c4', light: '#ebc2fc', dark: '#703b9b', points: 0 },
    { id: 'cherry', name: '樱桃', radius: 18, color: '#ee617c', light: '#ffbec6', dark: '#b62f50', points: 2 },
    { id: 'mandarin', name: '橘子', radius: 23, color: '#f4a238', light: '#ffe3a0', dark: '#d57824', points: 4 },
    { id: 'lemon', name: '柠檬', radius: 29, color: '#e8d94f', light: '#ffffc1', dark: '#c2aa29', points: 8 },
    { id: 'kiwi', name: '猕猴桃', radius: 37, color: '#acc95c', light: '#e9f4b5', dark: '#799746', points: 16 },
    { id: 'peach', name: '桃子', radius: 46, color: '#eea49d', light: '#ffe8d2', dark: '#cd7b88', points: 32 },
    { id: 'persimmon', name: '柿子', radius: 58, color: '#f0a13c', light: '#ffe1a2', dark: '#ca7033', points: 64 },
    { id: 'melon', name: '蜜瓜', radius: 73, color: '#b8d18c', light: '#edf6bf', dark: '#83a765', points: 128 },
    { id: 'watermelon', name: '西瓜', radius: 92, color: '#82b76e', light: '#d9edb0', dark: '#45875d', points: 256 }
  ]);
  const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
  const quant = x => Math.floor(x * SCALE + .5) / SCALE;
  const integer = (x, low, high) => Number.isSafeInteger(x) && x >= low && x <= high;
  const validSeed = seed => typeof seed === 'string' && /^[\x20-\x7e]{1,128}$/.test(seed);
  function spawnLevel(seed, index) {
    let hash = 2166136261;
    const input = seed + ':watermelon:spawn:' + index;
    for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 16777619) >>> 0;
    // FNV alone leaves neighbouring decimal indices in the same high-bit
    // bucket. Murmur3 fmix32 avalanches those bits before the three-way draw.
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return Math.floor((hash >>> 0) / 4294967296 * 3);
  }
  function area(nodes) {
    let result = 0;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i], b = nodes[(i + 1) % nodes.length];
      result += a.x * b.y - b.x * a.y;
    }
    return result / 2;
  }
  function measure(body) {
    let x = 0, y = 0, left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const p of body.nodes) {
      x += p.x; y += p.y;
      left = Math.min(left, p.x); right = Math.max(right, p.x);
      top = Math.min(top, p.y); bottom = Math.max(bottom, p.y);
    }
    body.x = x / NODES; body.y = y / NODES;
    Object.assign(body.bounds, { left, right, top, bottom });
    return body.bounds;
  }
  function quantize(body, previous = false) {
    for (const p of body.nodes) {
      p.x = quant(p.x); p.y = quant(p.y);
      if (previous) { p.px = quant(p.px); p.py = quant(p.py); }
    }
    measure(body);
  }
  function createFruit(id, level, x, y, vy = 0) {
    const radius = LEVELS[level].radius;
    const nodes = RING.map(([cx, cy]) => {
      const rx = cx * radius, ry = cy * radius;
      return { x: quant(x + rx), y: quant(y + ry), px: quant(x + rx), py: quant(y + ry - vy * STEP), rx, ry, gx: 0, gy: 0, sx: 0, sy: 0 };
    });
    const body = { id, level, radius, nodes, targetArea: radius * radius * AREA_UNIT, edge: radius * EDGE_UNIT,
      invMass: 1 / (radius * radius), x, y, age_ticks: 0, touched: false, contact: false, rotation: 0, bounds: {} };
    Object.defineProperty(body, 'age', { enumerable: true, get() { return this.age_ticks * STEP; }, set(value) { this.age_ticks = Math.max(0, Math.round(value * TICK_RATE)); } });
    measure(body);
    return body;
  }
  function createWorld(options = {}) {
    return { left: options.left ?? 28, right: options.right ?? 332, bottom: options.bottom ?? 518,
      bodies: [], contacts: [], tickCount: 0, get time() { return this.tickCount * STEP; } };
  }
  function shapeConstraints(body) {
    const nodes = body.nodes, radius = body.radius;
    measure(body);
    let cross = 0, dot = 0;
    for (const p of nodes) {
      const dx = p.x - body.x, dy = p.y - body.y;
      cross += p.rx * dy - p.ry * dx; dot += p.rx * dx + p.ry * dy;
    }
    const norm = Math.sqrt(dot * dot + cross * cross);
    const co = norm > .000001 ? dot / norm : 1, si = norm > .000001 ? cross / norm : 0;
    body.rotation = Math.atan2(si, co); // Display only; never read by physics.
    for (const p of nodes) {
      const tx = body.x + p.rx * co - p.ry * si, ty = body.y + p.rx * si + p.ry * co;
      p.x += (tx - p.x) * .0016; p.y += (ty - p.y) * .0016;
      const dx = p.x - body.x, dy = p.y - body.y, distance = Math.sqrt(dx * dx + dy * dy);
      const safe = clamp(distance, radius * .48, radius * 1.6);
      if (distance > .001 && safe !== distance) {
        p.x += dx * (safe / distance - 1) * .65; p.y += dy * (safe / distance - 1) * .65;
      }
      p.sx = 0; p.sy = 0;
    }
    // Jacobi membrane forces avoid directional drift and preserve soft contacts.
    for (let i = 0; i < NODES; i++) {
      const a = nodes[i], b = nodes[(i + 1) % NODES];
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.sqrt(dx * dx + dy * dy);
      if (length < .001) continue;
      const stiffness = length > body.edge * 1.55 || length < body.edge * .5 ? .35 : .035;
      const scale = (length - body.edge) / length * stiffness * .5;
      a.sx += dx * scale; a.sy += dy * scale; b.sx -= dx * scale; b.sy -= dy * scale;
    }
    for (const p of nodes) { p.x += p.sx; p.y += p.sy; p.sx = 0; p.sy = 0; }
    for (let i = 0; i < NODES; i++) {
      const a = nodes[(i + NODES - 1) % NODES], p = nodes[i], b = nodes[(i + 1) % NODES];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy);
      if (len < .001) continue;
      const side = ((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
      if (side < .04) { const push = (.04 - side) * .8; p.sx = dy / len * push; p.sy = -dx / len * push; }
    }
    for (const p of nodes) { p.x += p.sx; p.y += p.sy; }
    const error = body.targetArea - area(nodes);
    let denominator = 0;
    for (let i = 0; i < NODES; i++) {
      const a = nodes[(i + NODES - 1) % NODES], b = nodes[(i + 1) % NODES], p = nodes[i];
      p.gx = (b.y - a.y) * .5; p.gy = (a.x - b.x) * .5;
      denominator += p.gx * p.gx + p.gy * p.gy;
    }
    const lambda = clamp(error / Math.max(denominator, .001) * .98, -.18, .18);
    for (const p of nodes) { p.x += p.gx * lambda; p.y += p.gy * lambda; }
    measure(body);
  }
  function pointContact(point, body) {
    const nodes = body.nodes;
    let inside = false, distance2 = Infinity, edge = 0, fraction = 0, qx = 0, qy = 0;
    for (let i = 0, j = NODES - 1; i < NODES; j = i++) {
      const a = nodes[j], b = nodes[i];
      if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / Math.max(dx * dx + dy * dy, .001), 0, 1);
      const x = a.x + dx * t, y = a.y + dy * t, ex = point.x - x, ey = point.y - y;
      const d2 = ex * ex + ey * ey;
      if (d2 < distance2) { distance2 = d2; edge = j; fraction = t; qx = x; qy = y; }
    }
    if (!inside && distance2 > CONTACT_SKIN * CONTACT_SKIN) return null;
    const distance = Math.sqrt(distance2);
    let nx, ny;
    if (distance > .0001) { nx = (qx - point.x) / distance; ny = (qy - point.y) / distance; if (!inside) { nx = -nx; ny = -ny; } }
    else {
      const a = nodes[edge], b = nodes[(edge + 1) % NODES], dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.sqrt(dx * dx + dy * dy) || 1; nx = dy / length; ny = -dx / length;
    }
    return { edge, fraction, nx, ny, depth: inside ? distance + CONTACT_SKIN : CONTACT_SKIN - distance };
  }
  function separate(a, b) {
    let touching = false;
    for (const p of a.nodes) {
      if (p.x < b.bounds.left - CONTACT_SKIN || p.x > b.bounds.right + CONTACT_SKIN || p.y < b.bounds.top - CONTACT_SKIN || p.y > b.bounds.bottom + CONTACT_SKIN) continue;
      const hit = pointContact(p, b);
      if (!hit) continue;
      touching = true;
      const q = b.nodes[hit.edge], r = b.nodes[(hit.edge + 1) % NODES], u = 1 - hit.fraction, v = hit.fraction;
      const denominator = a.invMass + b.invMass * (u * u + v * v);
      const correction = Math.min(hit.depth, Math.min(a.radius, b.radius) * .35) * .92 / denominator;
      p.x += hit.nx * correction * a.invMass; p.y += hit.ny * correction * a.invMass;
      q.x -= hit.nx * correction * b.invMass * u; q.y -= hit.ny * correction * b.invMass * u;
      r.x -= hit.nx * correction * b.invMass * v; r.y -= hit.ny * correction * b.invMass * v;
    }
    return touching;
  }
  function keepInside(body, world) {
    for (const p of body.nodes) {
      p.x = clamp(p.x, world.left, world.right);
      if (p.y >= world.bottom) { p.y = world.bottom; body.contact = true; body.touched = true; }
    }
    measure(body);
  }
  function stepWorld(world) {
    const bodies = world.bodies, contacts = new Map();
    world.tickCount++;
    for (const body of bodies) {
      body.age_ticks++; body.contact = false;
      let vx = 0, vy = 0;
      for (const p of body.nodes) { vx += p.x - p.px; vy += p.y - p.py; }
      vx /= NODES; vy /= NODES;
      for (const p of body.nodes) {
        const dx = clamp((p.x - p.px) * .78 + vx * .215, -3.5, 3.5);
        const dy = clamp((p.y - p.py) * .78 + vy * .215, -3.5, 3.5);
        p.px = p.x; p.py = p.y; p.x += dx; p.y += dy + GRAVITY * STEP * STEP;
      }
    }
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      for (const body of bodies) { shapeConstraints(body); keepInside(body, world); }
      for (let ii = 0; ii < bodies.length; ii++) {
        const i = iteration % 2 ? bodies.length - 1 - ii : ii, a = bodies[i];
        for (let jj = ii + 1; jj < bodies.length; jj++) {
          const j = iteration % 2 ? bodies.length - 1 - jj : jj, b = bodies[j];
          if (a.bounds.right + CONTACT_SKIN < b.bounds.left || b.bounds.right + CONTACT_SKIN < a.bounds.left || a.bounds.bottom + CONTACT_SKIN < b.bounds.top || b.bounds.bottom + CONTACT_SKIN < a.bounds.top) continue;
          const ab = separate(a, b), ba = separate(b, a);
          if (ab || ba) {
            a.contact = b.contact = a.touched = b.touched = true;
            contacts.set(Math.min(a.id, b.id) + ':' + Math.max(a.id, b.id), [a, b]);
            measure(a); measure(b);
          }
        }
      }
      for (const body of bodies) { keepInside(body, world); quantize(body); }
    }
    for (const body of bodies) {
      for (const p of body.nodes) {
        if (p.y >= world.bottom - .05) { p.px += (p.x - p.px) * .12; p.py = p.y; }
        if (p.x <= world.left + .05 || p.x >= world.right - .05) p.px = p.x;
      }
      quantize(body, true);
    }
    world.contacts = Array.from(contacts.values());
  }
  function choose(state, index) {
    return state.random ? Math.min(2, Math.floor(clamp(state.random(), 0, .999999) * 3)) : spawnLevel(state.seed, index);
  }
  function createGame(options = {}) {
    const seed = options.seed ?? 'practice-' + Math.floor(Math.random() * 4294967296).toString(16);
    if (!validSeed(seed)) throw new Error('Invalid watermelon seed');
    const state = { seed, random: options.random, best: Math.max(0, Number(options.best) || 0),
      get cooldown() { return this.cooldownTicks * STEP; }, set cooldown(value) { this.cooldownTicks = Math.max(0, Math.round(value * TICK_RATE)); },
      get overflow() { return this.overflowTicks * STEP; }, set overflow(value) { this.overflowTicks = Math.max(0, Math.round(value * TICK_RATE)); } };
    reset(state);
    return state;
  }
  function reset(state) {
    Object.assign(state, { world: createWorld(), phase: 'ready', score: 0, highest: -1,
      held: choose(state, 0), next: choose(state, 1), aim: 180, cooldownTicks: 0, overflowTicks: 0,
      warningY: 137, accumulator: 0, nextId: 1, events: [], drops: 0, tickCount: 0 });
  }
  function start(state) { reset(state); state.phase = 'playing'; }
  function pause(state) { if (state.phase !== 'playing') return false; state.phase = 'paused'; state.accumulator = 0; return true; }
  function resume(state) { if (state.phase !== 'paused') return false; state.phase = 'playing'; return true; }
  function aim(state, x) {
    const radius = LEVELS[state.held].radius;
    state.aim = clamp(Number.isFinite(x) ? Math.round(x) : 180, state.world.left + radius + 2, state.world.right - radius - 2);
    return state.aim;
  }
  function drop(state, x = state.aim) {
    if (state.phase !== 'playing' || state.cooldownTicks > 0 || state.world.bodies.length >= MAX_BODIES) return false;
    aim(state, x);
    const radius = LEVELS[state.held].radius;
    if (state.world.bodies.some(b => b.bounds.top < 87 + radius && b.bounds.bottom > 87 - radius && b.bounds.left < state.aim + radius && b.bounds.right > state.aim - radius)) return false;
    const body = createFruit(state.nextId++, state.held, state.aim, 87, 25);
    state.world.bodies.push(body);
    state.drops++; state.held = state.next; state.next = choose(state, state.drops + 1); state.cooldownTicks = COOLDOWN_TICKS;
    aim(state, state.aim);
    state.events.push({ type: 'drop', x: body.x, y: body.y, level: body.level, tick: state.tickCount });
    if (state.world.bodies.length >= MAX_BODIES) end(state);
    return true;
  }
  function mergeContacts(state) {
    const consumed = new Set(), born = [];
    for (const [a, b] of state.world.contacts) {
      if (a.level !== b.level || a.level === LEVELS.length - 1 || consumed.has(a.id) || consumed.has(b.id) || a.age_ticks < MERGE_AGE_TICKS || b.age_ticks < MERGE_AGE_TICKS) continue;
      consumed.add(a.id); consumed.add(b.id);
      const level = a.level + 1, radius = LEVELS[level].radius, x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
      const fruit = createFruit(state.nextId++, level, x, y);
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.sqrt(dx * dx + dy * dy);
      const co = distance > .000001 ? dx / distance : 1, si = distance > .000001 ? dy / distance : 0;
      const stretch = clamp((distance * .5 + a.radius) / radius, 1, 1.42);
      let vx = 0, vy = 0;
      for (const parent of [a, b]) for (const p of parent.nodes) { vx += p.x - p.px; vy += p.y - p.py; }
      vx = clamp(vx / (NODES * 2), -1.5, 1.5); vy = clamp(vy / (NODES * 2), -1.5, 1.5);
      for (const p of fruit.nodes) {
        const along = p.rx * co + p.ry * si, across = -p.rx * si + p.ry * co;
        p.x = x + along * stretch * co - across / stretch * si;
        p.y = y + along * stretch * si + across / stretch * co;
      }
      measure(fruit);
      const moveX = Math.max(0, state.world.left - fruit.bounds.left) - Math.max(0, fruit.bounds.right - state.world.right);
      const moveY = -Math.max(0, fruit.bounds.bottom - state.world.bottom);
      for (const p of fruit.nodes) { p.x += moveX; p.y += moveY; p.px = p.x - vx; p.py = p.y - vy; }
      quantize(fruit, true);
      fruit.touched = a.touched || b.touched; born.push(fruit);
      state.score += LEVELS[level].points; state.best = Math.max(state.best, state.score); state.highest = Math.max(state.highest, level);
      state.events.push({ type: 'merge', x: fruit.x, y: fruit.y, level, points: LEVELS[level].points });
    }
    if (consumed.size) state.world.bodies = state.world.bodies.filter(body => !consumed.has(body.id)).concat(born);
  }
  function end(state) { state.phase = 'over'; state.accumulator = 0; state.events.push({ type: 'over', score: state.score }); }
  function tick(state) {
    if (state.phase !== 'playing') return false;
    state.cooldownTicks = Math.max(0, state.cooldownTicks - 1);
    stepWorld(state.world); state.tickCount++;
    mergeContacts(state);
    const overflowing = state.world.bodies.some(body => body.age_ticks > OVERFLOW_AGE_TICKS && body.touched && body.bounds.top < state.warningY);
    state.overflowTicks = overflowing ? state.overflowTicks + 1 : Math.max(0, state.overflowTicks - 2);
    if (state.overflowTicks >= OVERFLOW_TICKS || state.world.bodies.length >= MAX_BODIES) end(state);
    return true;
  }
  function step(state, seconds) {
    if (state.phase !== 'playing' || !Number.isFinite(seconds) || seconds <= 0) return;
    state.accumulator += Math.min(seconds, .0667);
    while (state.accumulator + 1e-9 >= STEP && state.phase === 'playing') { state.accumulator -= STEP; tick(state); }
  }
  function snapshot(state) {
    return { version: VERSION, tick: state.tickCount, drops: state.drops, score: state.score, highest: state.highest,
      next_id: state.nextId, cooldown_ticks: state.cooldownTicks, overflow_ticks: state.overflowTicks,
      phase: state.phase === 'over' ? 'over' : 'playing',
      bodies: state.world.bodies.map(body => ({ id: body.id, level: body.level, age_ticks: body.age_ticks, touched: body.touched,
        nodes: body.nodes.map(p => [p.x, p.y, p.px, p.py].map(x => Math.floor(x * SCALE + .5))) })) };
  }
  function validSnapshot(cp) {
    if (!cp || cp.version !== VERSION || !integer(cp.tick, 0, MAX_TICK) || !integer(cp.drops, 0, MAX_TICK) || !integer(cp.score, 0, 2147483647)
      || !integer(cp.highest, -1, LEVELS.length - 1) || cp.highest === 0 || !integer(cp.next_id, 1, MAX_TICK * 2 + 1)
      || !integer(cp.cooldown_ticks, 0, COOLDOWN_TICKS) || !integer(cp.overflow_ticks, 0, OVERFLOW_TICKS)
      || !['playing', 'over'].includes(cp.phase) || !Array.isArray(cp.bodies) || cp.bodies.length > MAX_BODIES) return false;
    const ids = new Set();
    return cp.bodies.every(b => {
      if (!b || !integer(b.id, 1, cp.next_id - 1) || ids.has(b.id) || !integer(b.level, 0, LEVELS.length - 1)
        || !integer(b.age_ticks, 0, MAX_TICK) || typeof b.touched !== 'boolean' || !Array.isArray(b.nodes) || b.nodes.length !== NODES) return false;
      ids.add(b.id);
      return b.nodes.every(p => Array.isArray(p) && p.length === 4 && p.every(v => integer(v, -MAX_COORD, MAX_COORD)));
    });
  }
  function restore(seed, cp, options = {}) {
    if (!validSeed(seed) || !validSnapshot(cp)) throw new Error('Invalid watermelon snapshot');
    const state = createGame({ seed, best: options.best });
    Object.assign(state, { tickCount: cp.tick, drops: cp.drops, score: cp.score, highest: cp.highest, nextId: cp.next_id,
      cooldownTicks: cp.cooldown_ticks, overflowTicks: cp.overflow_ticks, phase: cp.phase,
      held: spawnLevel(seed, cp.drops), next: spawnLevel(seed, cp.drops + 1) });
    state.world.tickCount = cp.tick;
    state.best = Math.max(state.best, state.score);
    state.world.bodies = cp.bodies.map(b => {
      const body = createFruit(b.id, b.level, 0, 0);
      body.age_ticks = b.age_ticks; body.touched = b.touched;
      b.nodes.forEach((p, i) => Object.assign(body.nodes[i], { x: p[0] / SCALE, y: p[1] / SCALE, px: p[2] / SCALE, py: p[3] / SCALE }));
      measure(body);
      return body;
    });
    return state;
  }
  function initial(seed) { const state = createGame({ seed }); start(state); return snapshot(state); }
  function replay(seed, cp, toTick, drops = []) {
    if (!validSnapshot(cp) || !integer(toTick, cp.tick, MAX_TICK) || toTick - cp.tick > MAX_SEGMENT_TICKS || !Array.isArray(drops) || drops.length > MAX_DROPS) throw new Error('Invalid watermelon segment');
    let last = cp.tick;
    for (const event of drops) {
      if (!event || !integer(event.tick, last, toTick) || !integer(event.x, 0, 360)) throw new Error('Invalid watermelon drop');
      last = event.tick;
    }
    const state = restore(seed, cp);
    const advance = target => { while (state.tickCount < target) if (!tick(state)) throw new Error('Watermelon round already ended'); };
    for (const event of drops) { advance(event.tick); if (!drop(state, event.x)) throw new Error('Watermelon drop rejected'); }
    advance(toTick);
    return snapshot(state);
  }
  return { VERSION, TICK_RATE, SCALE, NODES, STEP, LEVELS, OVERFLOW_GRACE, MAX_BODIES, MAX_SEGMENT_TICKS, MAX_DROPS,
    spawnLevel, createFruit, createWorld, stepWorld, area, measure, createGame, reset, start, pause, resume, aim, drop, step, tick,
    snapshot, restore, initial, replay };
})();
