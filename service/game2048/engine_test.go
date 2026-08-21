package game2048

import (
	"reflect"
	"testing"
)

func TestMoveGridMergesLeft(t *testing.T) {
	result := MoveGrid(Grid{
		{2, 2, 2, 2, 2},
		{2, 2, 4, 0, 4},
		{4, 0, 4, 4, 4},
		{0, 0, 0, 0, 0},
		{8, 8, 8, 0, 8},
	}, DirectionLeft)

	expected := Grid{
		{4, 4, 2, 0, 0},
		{4, 8, 0, 0, 0},
		{8, 8, 0, 0, 0},
		{0, 0, 0, 0, 0},
		{16, 16, 0, 0, 0},
	}
	if !result.Moved {
		t.Fatal("expected grid to move")
	}
	if result.ScoreDelta != 68 {
		t.Fatalf("unexpected score delta: got %d want 68", result.ScoreDelta)
	}
	if !reflect.DeepEqual(result.Grid, expected) {
		t.Fatalf("unexpected grid:\n got %#v\nwant %#v", result.Grid, expected)
	}
}

func TestCreateInitialGridMatchesTypeScriptSeed(t *testing.T) {
	expected := Grid{
		{0, 0, 0, 0, 0},
		{0, 0, 0, 0, 0},
		{0, 0, 0, 2, 0},
		{0, 0, 0, 0, 0},
		{0, 2, 0, 0, 0},
	}
	if got := CreateInitialGrid("fixed-seed"); !reflect.DeepEqual(got, expected) {
		t.Fatalf("unexpected initial grid:\n got %#v\nwant %#v", got, expected)
	}
}

func TestSimulateMatchesTypeScriptSeed(t *testing.T) {
	result := Simulate("fixed-seed", []Direction{
		DirectionLeft,
		DirectionUp,
		DirectionRight,
		DirectionDown,
		DirectionLeft,
		DirectionUp,
	}, MaxMoves)

	expectedGrid := Grid{
		{4, 2, 0, 0, 0},
		{2, 8, 0, 0, 0},
		{0, 0, 0, 0, 0},
		{0, 0, 0, 0, 0},
		{0, 0, 0, 0, 0},
	}
	if !result.OK {
		t.Fatalf("expected simulation ok, got message=%q", result.Message)
	}
	if result.Score != 20 || result.HighestTile != 8 || result.MovesSubmitted != 6 || result.MovesApplied != 6 {
		t.Fatalf("unexpected simulation summary: %+v", result)
	}
	if result.Won || result.GameOver {
		t.Fatalf("unexpected terminal flags: won=%v gameOver=%v", result.Won, result.GameOver)
	}
	if !reflect.DeepEqual(result.Grid, expectedGrid) {
		t.Fatalf("unexpected final grid:\n got %#v\nwant %#v", result.Grid, expectedGrid)
	}
}

func TestWinScoreThreshold(t *testing.T) {
	if WinScore != 20000 {
		t.Fatalf("unexpected win score: got %d want 20000", WinScore)
	}
	if IsWinningScore(19999) {
		t.Fatal("expected score below win line to lose")
	}
	if !IsWinningScore(20000) || !IsWinningScore(20001) {
		t.Fatal("expected score on or above win line to win")
	}
}

func TestValidateInput(t *testing.T) {
	if IsValidGrid(Grid{{2}}) {
		t.Fatal("expected short grid to be invalid")
	}
	if IsValidTile(3) {
		t.Fatal("expected non power-of-two tile to be invalid")
	}
	if !IsValidTile(1048576) {
		t.Fatal("expected high power-of-two tile to be valid")
	}
	if _, ok, _ := NormalizeMoves([]Direction{Direction("bad")}, MaxMoves); ok {
		t.Fatal("expected invalid direction to fail")
	}
	tooManyMoves := make([]Direction, MaxMoves+1)
	for index := range tooManyMoves {
		tooManyMoves[index] = DirectionLeft
	}
	if _, ok, message := NormalizeMoves(tooManyMoves, MaxMoves); ok || message != "操作步数过多" {
		t.Fatalf("expected too many moves failure, ok=%v message=%q", ok, message)
	}
}
