package game2048

import (
	"math"
	"strings"
)

func NormalizeMoves(moves []Direction, maxMoves int) ([]Direction, bool, string) {
	if moves == nil {
		return nil, false, "无效的操作序列"
	}
	if maxMoves <= 0 {
		maxMoves = MaxMoves
	}
	if len(moves) > maxMoves {
		return nil, false, "操作步数过多"
	}
	normalized := make([]Direction, 0, len(moves))
	for _, move := range moves {
		if !IsDirection(move) {
			return nil, false, "操作方向无效"
		}
		normalized = append(normalized, move)
	}
	return normalized, true, ""
}

func IsDirection(value Direction) bool {
	switch value {
	case DirectionUp, DirectionDown, DirectionLeft, DirectionRight:
		return true
	default:
		return false
	}
}

func IsValidTile(value int) bool {
	if value == 0 {
		return true
	}
	return value >= 2 && value <= MaxTileValue && value&(value-1) == 0
}

func IsValidGrid(grid Grid) bool {
	if len(grid) != BoardSize {
		return false
	}
	for _, row := range grid {
		if len(row) != BoardSize {
			return false
		}
		for _, value := range row {
			if !IsValidTile(value) {
				return false
			}
		}
	}
	return true
}

func CreateInitialGrid(seed string) Grid {
	first := SpawnTile(emptyGrid(), seed, 0)
	return SpawnTile(first, seed, 1)
}

func SpawnTile(source Grid, seed string, spawnIndex int) Grid {
	grid := cloneGrid(source)
	emptyCells := getEmptyCells(grid)
	if len(emptyCells) == 0 {
		return grid
	}

	cellRandom := hashToUnit(seed + ":2048:spawn:" + itoa(spawnIndex) + ":cell")
	valueRandom := hashToUnit(seed + ":2048:spawn:" + itoa(spawnIndex) + ":value")
	cellIndex := int(math.Floor(cellRandom * float64(len(emptyCells))))
	if cellIndex >= len(emptyCells) {
		cellIndex = len(emptyCells) - 1
	}
	cell := emptyCells[cellIndex]
	if valueRandom < 0.9 {
		grid[cell.row][cell.col] = 2
	} else {
		grid[cell.row][cell.col] = 4
	}
	return grid
}

func MoveGrid(grid Grid, direction Direction) MoveResult {
	next := emptyGrid()
	var scoreDelta int64
	for index := 0; index < BoardSize; index++ {
		line, delta := mergeLine(getLine(grid, index, direction))
		setLine(next, index, direction, line)
		scoreDelta += delta
	}
	return MoveResult{
		Grid:       next,
		ScoreDelta: scoreDelta,
		Moved:      !gridsEqual(grid, next),
	}
}

func Simulate(seed string, moves []Direction, maxMoves int) SimulationResult {
	if strings.TrimSpace(seed) == "" {
		return SimulationResult{OK: false, Message: "无效的游戏种子"}
	}
	normalized, ok, message := NormalizeMoves(moves, maxMoves)
	if !ok {
		return SimulationResult{OK: false, Message: message}
	}

	grid := CreateInitialGrid(seed)
	var score int64
	movesApplied := 0
	for _, direction := range normalized {
		moved := MoveGrid(grid, direction)
		if !moved.Moved {
			continue
		}
		score += moved.ScoreDelta
		grid = SpawnTile(moved.Grid, seed, movesApplied+2)
		movesApplied++
	}

	highestTile := HighestTile(grid)
	return SimulationResult{
		OK:             true,
		Grid:           grid,
		Score:          score,
		HighestTile:    highestTile,
		MovesSubmitted: len(normalized),
		MovesApplied:   movesApplied,
		Won:            IsWinningScore(score),
		GameOver:       IsGameOver(grid),
	}
}

func HighestTile(grid Grid) int {
	highest := 0
	for _, row := range grid {
		for _, value := range row {
			if value > highest {
				highest = value
			}
		}
	}
	return highest
}

func IsGameOver(grid Grid) bool {
	if len(getEmptyCells(grid)) > 0 {
		return false
	}
	for row := 0; row < BoardSize; row++ {
		for col := 0; col < BoardSize; col++ {
			value := grid[row][col]
			if row+1 < BoardSize && grid[row+1][col] == value {
				return false
			}
			if col+1 < BoardSize && grid[row][col+1] == value {
				return false
			}
		}
	}
	return true
}

func IsWinningScore(score int64) bool {
	return score >= WinScore
}

type cell struct {
	row int
	col int
}

func emptyGrid() Grid {
	grid := make(Grid, BoardSize)
	for row := range grid {
		grid[row] = make([]int, BoardSize)
	}
	return grid
}

func cloneGrid(source Grid) Grid {
	grid := make(Grid, len(source))
	for row := range source {
		grid[row] = append([]int(nil), source[row]...)
	}
	return grid
}

func getEmptyCells(grid Grid) []cell {
	cells := []cell{}
	for row := 0; row < BoardSize; row++ {
		for col := 0; col < BoardSize; col++ {
			if grid[row][col] == 0 {
				cells = append(cells, cell{row: row, col: col})
			}
		}
	}
	return cells
}

func mergeLine(line []int) ([]int, int64) {
	values := make([]int, 0, len(line))
	for _, value := range line {
		if value > 0 {
			values = append(values, value)
		}
	}
	merged := make([]int, 0, BoardSize)
	var scoreDelta int64
	for i := 0; i < len(values); i++ {
		if i+1 < len(values) && values[i] == values[i+1] {
			next := values[i] * 2
			merged = append(merged, next)
			scoreDelta += int64(next)
			i++
		} else {
			merged = append(merged, values[i])
		}
	}
	for len(merged) < BoardSize {
		merged = append(merged, 0)
	}
	return merged, scoreDelta
}

func getLine(grid Grid, index int, direction Direction) []int {
	line := make([]int, BoardSize)
	switch direction {
	case DirectionLeft:
		copy(line, grid[index])
	case DirectionRight:
		for col := 0; col < BoardSize; col++ {
			line[col] = grid[index][BoardSize-1-col]
		}
	case DirectionUp:
		for row := 0; row < BoardSize; row++ {
			line[row] = grid[row][index]
		}
	case DirectionDown:
		for row := 0; row < BoardSize; row++ {
			line[row] = grid[BoardSize-1-row][index]
		}
	}
	return line
}

func setLine(grid Grid, index int, direction Direction, line []int) {
	values := line
	if direction == DirectionRight || direction == DirectionDown {
		values = reverse(line)
	}
	if direction == DirectionLeft || direction == DirectionRight {
		grid[index] = append([]int(nil), values...)
		return
	}
	for row := 0; row < BoardSize; row++ {
		grid[row][index] = values[row]
	}
}

func reverse(values []int) []int {
	result := make([]int, len(values))
	for i := range values {
		result[i] = values[len(values)-1-i]
	}
	return result
}

func gridsEqual(left Grid, right Grid) bool {
	if len(left) != len(right) {
		return false
	}
	for row := range left {
		if len(left[row]) != len(right[row]) {
			return false
		}
		for col := range left[row] {
			if left[row][col] != right[row][col] {
				return false
			}
		}
	}
	return true
}

func hashToUnit(input string) float64 {
	hash := uint32(2166136261)
	for _, r := range input {
		hash ^= uint32(r)
		hash *= 16777619
	}
	return float64(hash) / 4294967296
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	buffer := make([]byte, 0, 12)
	for value > 0 {
		buffer = append(buffer, byte('0'+value%10))
		value /= 10
	}
	if negative {
		buffer = append(buffer, '-')
	}
	for left, right := 0, len(buffer)-1; left < right; left, right = left+1, right-1 {
		buffer[left], buffer[right] = buffer[right], buffer[left]
	}
	return string(buffer)
}
