package game2048

const (
	GameType2048 = "2048"

	BoardSize    = 5
	WinTile      = 2048
	WinScore     = int64(20000)
	MaxMoves     = 8000
	MaxTileValue = 1073741824
)

type Direction string

const (
	DirectionUp    Direction = "up"
	DirectionDown  Direction = "down"
	DirectionLeft  Direction = "left"
	DirectionRight Direction = "right"
)

type Grid [][]int

type MoveResult struct {
	Grid       Grid
	ScoreDelta int64
	Moved      bool
}

type SimulationResult struct {
	OK             bool
	Message        string
	Grid           Grid
	Score          int64
	HighestTile    int
	MovesSubmitted int
	MovesApplied   int
	Won            bool
	GameOver       bool
}
