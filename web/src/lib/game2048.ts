export const GAME2048_BOARD_SIZE = 5;
export const GAME2048_WIN_TILE = 2048;
export const GAME2048_WIN_SCORE = 20_000;
export const GAME2048_MAX_MOVES = 8000;

export type Game2048Direction = 'up' | 'down' | 'left' | 'right';
export type Game2048Grid = number[][];

export interface Game2048MoveResult {
  grid: Game2048Grid;
  scoreDelta: number;
  moved: boolean;
}

export interface Game2048SimulationResult {
  grid: Game2048Grid;
  score: number;
  highestTile: number;
  movesSubmitted: number;
  movesApplied: number;
  won: boolean;
  gameOver: boolean;
}

export type Game2048Simulation =
  | ({ ok: true } & Game2048SimulationResult)
  | { ok: false; message: string };

const DIRECTION_SET = new Set<Game2048Direction>(['up', 'down', 'left', 'right']);
const MAX_TILE_VALUE = 1_073_741_824;

function cloneGrid(grid: Game2048Grid): Game2048Grid {
  return grid.map((row) => [...row]);
}

function makeEmptyGrid(): Game2048Grid {
  return Array.from({ length: GAME2048_BOARD_SIZE }, () =>
    Array.from({ length: GAME2048_BOARD_SIZE }, () => 0),
  );
}

function hashToUnit(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

function getEmptyCells(grid: Game2048Grid): Array<{ row: number; col: number }> {
  const cells: Array<{ row: number; col: number }> = [];
  for (let row = 0; row < GAME2048_BOARD_SIZE; row += 1) {
    for (let col = 0; col < GAME2048_BOARD_SIZE; col += 1) {
      if (grid[row][col] === 0) {
        cells.push({ row, col });
      }
    }
  }
  return cells;
}

export function isGame2048Direction(value: unknown): value is Game2048Direction {
  return typeof value === 'string' && DIRECTION_SET.has(value as Game2048Direction);
}

export function normalizeGame2048Moves(
  moves: unknown,
  maxMoves = GAME2048_MAX_MOVES,
): { ok: true; moves: Game2048Direction[] } | { ok: false; message: string } {
  if (!Array.isArray(moves)) {
    return { ok: false, message: '无效的操作序列' };
  }

  if (moves.length > maxMoves) {
    return { ok: false, message: '操作步数过多' };
  }

  const normalized: Game2048Direction[] = [];
  for (const move of moves) {
    if (!isGame2048Direction(move)) {
      return { ok: false, message: '操作方向无效' };
    }
    normalized.push(move);
  }

  return { ok: true, moves: normalized };
}

export function isValidGame2048Tile(value: unknown): value is number {
  if (typeof value !== 'number') return false;
  if (!Number.isSafeInteger(value)) return false;
  if (value === 0) return true;
  return value >= 2
    && value <= MAX_TILE_VALUE
    && Number.isInteger(Math.log2(value));
}

export function isValidGame2048Grid(grid: unknown): grid is Game2048Grid {
  return Array.isArray(grid)
    && grid.length === GAME2048_BOARD_SIZE
    && grid.every((row) =>
      Array.isArray(row)
      && row.length === GAME2048_BOARD_SIZE
      && row.every(isValidGame2048Tile),
    );
}

export function spawnGame2048Tile(
  sourceGrid: Game2048Grid,
  seed: string,
  spawnIndex: number,
): Game2048Grid {
  const grid = cloneGrid(sourceGrid);
  const emptyCells = getEmptyCells(grid);
  if (emptyCells.length === 0) {
    return grid;
  }

  const cellRandom = hashToUnit(`${seed}:2048:spawn:${spawnIndex}:cell`);
  const valueRandom = hashToUnit(`${seed}:2048:spawn:${spawnIndex}:value`);
  const cellIndex = Math.min(emptyCells.length - 1, Math.floor(cellRandom * emptyCells.length));
  const { row, col } = emptyCells[cellIndex];
  grid[row][col] = valueRandom < 0.9 ? 2 : 4;
  return grid;
}

export function createInitialGame2048Grid(seed: string): Game2048Grid {
  const first = spawnGame2048Tile(makeEmptyGrid(), seed, 0);
  return spawnGame2048Tile(first, seed, 1);
}

function mergeLine(line: number[]): { line: number[]; scoreDelta: number } {
  const values = line.filter((value) => value > 0);
  const merged: number[] = [];
  let scoreDelta = 0;

  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === values[i + 1]) {
      const next = values[i] * 2;
      merged.push(next);
      scoreDelta += next;
      i += 1;
    } else {
      merged.push(values[i]);
    }
  }

  while (merged.length < GAME2048_BOARD_SIZE) {
    merged.push(0);
  }

  return { line: merged, scoreDelta };
}

function getLine(grid: Game2048Grid, index: number, direction: Game2048Direction): number[] {
  if (direction === 'left') {
    return [...grid[index]];
  }
  if (direction === 'right') {
    return [...grid[index]].reverse();
  }
  if (direction === 'up') {
    return Array.from({ length: GAME2048_BOARD_SIZE }, (_, row) => grid[row][index]);
  }
  return Array.from({ length: GAME2048_BOARD_SIZE }, (_, row) => grid[row][index]).reverse();
}

function setLine(
  grid: Game2048Grid,
  index: number,
  direction: Game2048Direction,
  line: number[],
): void {
  const values = direction === 'right' || direction === 'down'
    ? [...line].reverse()
    : line;

  if (direction === 'left' || direction === 'right') {
    grid[index] = [...values];
    return;
  }

  for (let row = 0; row < GAME2048_BOARD_SIZE; row += 1) {
    grid[row][index] = values[row];
  }
}

function areGridsEqual(a: Game2048Grid, b: Game2048Grid): boolean {
  for (let row = 0; row < GAME2048_BOARD_SIZE; row += 1) {
    for (let col = 0; col < GAME2048_BOARD_SIZE; col += 1) {
      if (a[row][col] !== b[row][col]) return false;
    }
  }
  return true;
}

export function moveGame2048Grid(
  grid: Game2048Grid,
  direction: Game2048Direction,
): Game2048MoveResult {
  const next = makeEmptyGrid();
  let scoreDelta = 0;

  for (let index = 0; index < GAME2048_BOARD_SIZE; index += 1) {
    const merged = mergeLine(getLine(grid, index, direction));
    setLine(next, index, direction, merged.line);
    scoreDelta += merged.scoreDelta;
  }

  return {
    grid: next,
    scoreDelta,
    moved: !areGridsEqual(grid, next),
  };
}

export function getGame2048HighestTile(grid: Game2048Grid): number {
  return grid.reduce(
    (max, row) => row.reduce((rowMax, value) => Math.max(rowMax, value), max),
    0,
  );
}

export function isGame2048Over(grid: Game2048Grid): boolean {
  if (getEmptyCells(grid).length > 0) return false;

  for (let row = 0; row < GAME2048_BOARD_SIZE; row += 1) {
    for (let col = 0; col < GAME2048_BOARD_SIZE; col += 1) {
      const value = grid[row][col];
      if (row + 1 < GAME2048_BOARD_SIZE && grid[row + 1][col] === value) {
        return false;
      }
      if (col + 1 < GAME2048_BOARD_SIZE && grid[row][col + 1] === value) {
        return false;
      }
    }
  }

  return true;
}

export function isGame2048WinningScore(score: number): boolean {
  return Number.isFinite(score) && Math.floor(score) >= GAME2048_WIN_SCORE;
}

export function simulateGame2048(
  seed: string,
  rawMoves: unknown,
  options: { maxMoves?: number } = {},
): Game2048Simulation {
  if (typeof seed !== 'string' || seed.trim() === '') {
    return { ok: false, message: '无效的游戏种子' };
  }

  const normalized = normalizeGame2048Moves(rawMoves, options.maxMoves ?? GAME2048_MAX_MOVES);
  if (!normalized.ok) {
    return normalized;
  }

  let grid = createInitialGame2048Grid(seed);
  let score = 0;
  let movesApplied = 0;

  for (const direction of normalized.moves) {
    const moved = moveGame2048Grid(grid, direction);
    if (!moved.moved) {
      continue;
    }

    score += moved.scoreDelta;
    grid = spawnGame2048Tile(moved.grid, seed, movesApplied + 2);
    movesApplied += 1;
  }

  const highestTile = getGame2048HighestTile(grid);
  return {
    ok: true,
    grid,
    score,
    highestTile,
    movesSubmitted: normalized.moves.length,
    movesApplied,
    won: isGame2048WinningScore(score),
    gameOver: isGame2048Over(grid),
  };
}
