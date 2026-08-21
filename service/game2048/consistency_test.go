package game2048

import (
	"encoding/json"
	"os"
	"reflect"
	"regexp"
	"testing"
)

// fixture 是 testdata/fixtures.json 的一条记录。同一份文件由前端
// web/src/lib/__tests__/game2048.test.ts 读取并断言 TS 引擎输出,
// 两端共用期望值,任何一端跑偏都会在这里或那里炸掉。
type fixture struct {
	Name     string      `json:"name"`
	Seed     string      `json:"seed"`
	Moves    []Direction `json:"moves"`
	Expected struct {
		Grid           Grid  `json:"grid"`
		Score          int64 `json:"score"`
		HighestTile    int   `json:"highest_tile"`
		MovesSubmitted int   `json:"moves_submitted"`
		MovesApplied   int   `json:"moves_applied"`
		Won            bool  `json:"won"`
		GameOver       bool  `json:"game_over"`
	} `json:"expected"`
}

func loadFixtures(t *testing.T) []fixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/fixtures.json")
	if err != nil {
		t.Fatalf("读取夹具失败: %v", err)
	}
	var fixtures []fixture
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatalf("解析夹具失败: %v", err)
	}
	return fixtures
}

func TestSimulateMatchesFixtures(t *testing.T) {
	for _, f := range loadFixtures(t) {
		t.Run(f.Name, func(t *testing.T) {
			result := Simulate(f.Seed, f.Moves, MaxMoves)
			if !result.OK {
				t.Fatalf("模拟失败: %s", result.Message)
			}
			if !reflect.DeepEqual(result.Grid, f.Expected.Grid) {
				t.Fatalf("棋盘不一致:\n got %#v\nwant %#v", result.Grid, f.Expected.Grid)
			}
			if result.Score != f.Expected.Score {
				t.Fatalf("分数不一致: got %d want %d", result.Score, f.Expected.Score)
			}
			if result.HighestTile != f.Expected.HighestTile {
				t.Fatalf("最高方块不一致: got %d want %d", result.HighestTile, f.Expected.HighestTile)
			}
			if result.MovesSubmitted != f.Expected.MovesSubmitted {
				t.Fatalf("提交步数不一致: got %d want %d", result.MovesSubmitted, f.Expected.MovesSubmitted)
			}
			if result.MovesApplied != f.Expected.MovesApplied {
				t.Fatalf("生效步数不一致: got %d want %d", result.MovesApplied, f.Expected.MovesApplied)
			}
			if result.Won != f.Expected.Won || result.GameOver != f.Expected.GameOver {
				t.Fatalf("终局标记不一致: won=%v gameOver=%v want won=%v gameOver=%v",
					result.Won, result.GameOver, f.Expected.Won, f.Expected.GameOver)
			}
		})
	}
}

// TestFixtureCoverage 锁住夹具本身的覆盖面,防止后来者把夹具削弱成三组两步的玩具。
func TestFixtureCoverage(t *testing.T) {
	fixtures := loadFixtures(t)
	if len(fixtures) < 3 {
		t.Fatalf("夹具组数不足: got %d want >= 3", len(fixtures))
	}

	hexSeed := regexp.MustCompile(`^[0-9a-f]{32}$`)
	hasLongRun := false
	hasInvalidHeavy := false
	for _, f := range fixtures {
		// 种子必须是纯 hex(ASCII)。hashToUnit 在 Go 里按 rune 遍历、在 JS 里按 UTF-16
		// 码元遍历,只有全 ASCII 时两端才等价;一旦引入非 ASCII 种子立刻分叉。
		if !hexSeed.MatchString(f.Seed) {
			t.Fatalf("夹具 %s 的种子必须是 32 位小写 hex: %q", f.Name, f.Seed)
		}
		if len(f.Moves) >= 200 {
			hasLongRun = true
		}
		if f.Expected.MovesSubmitted-f.Expected.MovesApplied >= 50 {
			hasInvalidHeavy = true
		}
	}
	if !hasLongRun {
		t.Fatal("缺少 >=200 步的长局夹具")
	}
	if !hasInvalidHeavy {
		t.Fatal("缺少含大量无效移动的夹具(无效步不消耗 spawn 序号)")
	}
}
