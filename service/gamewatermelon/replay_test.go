package gamewatermelon

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

type fixtureSegment struct {
	ToTick   int      `json:"to_tick"`
	Drops    []Drop   `json:"drops"`
	Expected Snapshot `json:"expected"`
}
type fixture struct {
	Name         string           `json:"name"`
	Seed         string           `json:"seed"`
	InitialState *Snapshot        `json:"initial_state"`
	Segments     []fixtureSegment `json:"segments"`
}

func readFixtures(t testing.TB) []fixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Version  string    `json:"version"`
		Fixtures []fixture `json:"fixtures"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	if data.Version != Version || len(data.Fixtures) < 7 {
		t.Fatal("shared fixtures missing coverage/version")
	}
	return data.Fixtures
}
func compareSnapshot(t *testing.T, got, want Snapshot) {
	t.Helper()
	if reflect.DeepEqual(got, want) {
		return
	}
	for i, b := range got.Bodies {
		if i >= len(want.Bodies) {
			break
		}
		for j, n := range b.Nodes {
			if n != want.Bodies[i].Nodes[j] {
				t.Fatalf("tick %d body %d node %d: got %v want %v (metrics %d/%d/%d want %d/%d/%d)", got.Tick, b.ID, j, n, want.Bodies[i].Nodes[j], got.Score, got.Highest, got.Drops, want.Score, want.Highest, want.Drops)
			}
		}
	}
	t.Fatalf("snapshot mismatch: got %+v want %+v", got, want)
}
func TestSharedBrowserParticleFixtures(t *testing.T) {
	long, over, watermelon := false, false, false
	for _, f := range readFixtures(t) {
		t.Run(f.Name, func(t *testing.T) {
			cp := Initial(f.Seed)
			if f.InitialState != nil {
				cp = *f.InitialState
			}
			for _, segment := range f.Segments {
				out, err := Replay(f.Seed, cp, segment.ToTick, segment.Drops)
				if err != nil {
					t.Fatal(err)
				}
				compareSnapshot(t, out, segment.Expected)
				// Exercise the actual persisted codec at every odd (non-drop) boundary.
				raw, err := Encode(out)
				if err != nil {
					t.Fatal(err)
				}
				cp, err = Decode(f.Seed, raw)
				if err != nil {
					t.Fatal(err)
				}
				compareSnapshot(t, cp, out)
			}
			long = long || cp.Tick >= 4000
			over = over || cp.Phase == "over"
			watermelon = watermelon || cp.Highest == 8
		})
	}
	if !long || !over || !watermelon {
		t.Fatalf("missing long/overflow/watermelon coverage: %v %v %v", long, over, watermelon)
	}
}
func TestReplayRejectsInvalidWithoutMutatingCheckpoint(t *testing.T) {
	seed := "0123456789abcdef0123456789abcdef"
	cp, err := Replay(seed, Initial(seed), 100, []Drop{{Tick: 0, X: 180}})
	if err != nil {
		t.Fatal(err)
	}
	before, _ := Encode(cp)
	cases := []struct {
		name  string
		to    int
		drops []Drop
	}{
		{"backwards", 99, nil}, {"oversized", 1301, nil}, {"future_event", 101, []Drop{{Tick: 102, X: 180}}},
		{"negative_x", 102, []Drop{{Tick: 102, X: -1}}}, {"outside_x", 102, []Drop{{Tick: 102, X: 361}}},
		{"out_of_order", 200, []Drop{{Tick: 150, X: 100}, {Tick: 120, X: 150}}},
		{"cooldown", 200, []Drop{{Tick: 110, X: 180}, {Tick: 111, X: 180}}},
		{"too_many", 200, make([]Drop, MaxDrops+1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Replay(seed, cp, tc.to, tc.drops); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("got %v", err)
			}
			after, _ := Encode(cp)
			if before != after {
				t.Fatal("rejected replay mutated checkpoint")
			}
		})
	}
}
func TestDropAndCheckpointBoundarySemantics(t *testing.T) {
	seed := "0123456789abcdef0123456789abcdef"
	start := Initial(seed)
	zero, err := Replay(seed, start, 0, []Drop{{Tick: 0, X: 180}})
	if err != nil {
		t.Fatal(err)
	}
	if zero.Tick != 0 || zero.Drops != 1 || zero.HighestTile() != 0 {
		t.Fatalf("boundary drop/no-merge metrics: %+v", zero)
	}
	if _, err := Replay(seed, zero, 57, []Drop{{Tick: 57, X: 0}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("cooldown: %v", err)
	}
	valid, err := Replay(seed, zero, 58, []Drop{{Tick: 58, X: 0}})
	if err != nil {
		t.Fatal(err)
	}
	if valid.Drops != 2 || valid.Tick != 58 {
		t.Fatal("58th tick drop rejected")
	}
	full, err := Replay(seed, start, 120, []Drop{{Tick: 0, X: 180}, {Tick: 58, X: 0}})
	if err != nil {
		t.Fatal(err)
	}
	split, err := Replay(seed, valid, 120, nil)
	if err != nil {
		t.Fatal(err)
	}
	compareSnapshot(t, split, full)
}
func TestCompactSnapshotLimitsAndVersion(t *testing.T) {
	seed := "abcdef0123456789abcdef0123456789"
	cp := Initial(seed)
	cp.Tick, cp.Drops, cp.Score, cp.NextID = MaxTick, MaxTick, 2147483647, MaxTick*2+1
	cp.CooldownTicks, cp.OverflowTicks = cooldownTicks, overflowTicks
	for i := 0; i < MaxBodies; i++ {
		b := BodyState{ID: MaxTick*2 - i, Level: i % 9, AgeTicks: MaxTick, Touched: false, Nodes: make([]NodeState, Nodes)}
		for j := range b.Nodes {
			b.Nodes[j] = NodeState{-maxCoord, maxCoord, -maxCoord, maxCoord}
		}
		cp.Bodies = append(cp.Bodies, b)
	}
	raw, err := Encode(cp)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > MaxSnapshotBytes {
		t.Fatalf("%d byte snapshot exceeds MySQL TEXT safety bound", len(raw))
	}
	t.Logf("worst permitted 64-body snapshot: %d bytes / %d", len(raw), MaxSnapshotBytes)
	decoded, err := Decode(seed, raw)
	if err != nil {
		t.Fatal(err)
	}
	compareSnapshot(t, decoded, cp)
	for _, bad := range []string{strings.Replace(raw, Version, "watermelon-v2", 1), raw + "{}", strings.Repeat(" ", MaxSnapshotBytes+1), `{"grid":[[0]]}`} {
		if _, err := Decode(seed, bad); !errors.Is(err, ErrInvalidSnapshot) {
			t.Fatalf("invalid save accepted: %v", err)
		}
	}
	cp.Bodies[0].Nodes[0][0] = maxCoord + 1
	if _, err := Encode(cp); !errors.Is(err, ErrInvalidSnapshot) {
		t.Fatalf("unbounded coordinates accepted: %v", err)
	}
}
func TestSynthesisUsesDeformedMembrane(t *testing.T) {
	w := createWorld()
	b := createFruit(1, 4, 180, 100, 0)
	w.bodies = append(w.bodies, b)
	peak := 1.0
	minimum := 1.0
	for i := 0; i < 720; i++ {
		stepWorld(w)
		peak = max(peak, (b.bounds.right-b.bounds.left)/(b.bounds.bottom-b.bounds.top))
		minimum = min(minimum, area(&b.nodes)/b.targetArea)
	}
	if peak < 1.3 || minimum < .94 {
		t.Fatalf("lost soft membrane/area constraints: peak=%f minArea=%f", peak, minimum)
	}
	if b.bounds.bottom > w.bottom || b.bounds.left < w.left || b.bounds.right > w.right {
		t.Fatal("membrane escaped vessel")
	}
}

// 64 colliding bodies, 600 steps: deliberately heavier than legal game replay
// (which ends on capacity). It bounds the native solver's crowded request cost.
func BenchmarkCrowdedMaxSegment(b *testing.B) {
	for i := 0; i < b.N; i++ {
		w := createWorld()
		w.bottom = 1000
		for j := 0; j < MaxBodies; j++ {
			w.bodies = append(w.bodies, createFruit(j+1, j%4, 57+float64(j%5)*57, 960-float64(j/5)*70, 0))
		}
		for tick := 0; tick < MaxSegmentTicks; tick++ {
			stepWorld(w)
		}
	}
}

func BenchmarkLegalReplay(b *testing.B) {
	fixtures := readFixtures(b)
	var crowdedSeed string
	var crowdedBase Snapshot
	var crowdedSegment fixtureSegment
	for _, f := range fixtures {
		if f.InitialState != nil {
			continue
		}
		cp := Initial(f.Seed)
		for _, segment := range f.Segments {
			if len(cp.Bodies) > len(crowdedBase.Bodies) && segment.Expected.Phase == "playing" && segment.ToTick-cp.Tick >= 500 {
				crowdedSeed, crowdedBase, crowdedSegment = f.Seed, cp, segment
			}
			cp = segment.Expected
		}
	}
	b.Run("crowded-legal", func(b *testing.B) {
		b.ReportMetric(float64(len(crowdedBase.Bodies)), "bodies")
		b.ReportMetric(float64(crowdedSegment.ToTick-crowdedBase.Tick), "ticks/op")
		for i := 0; i < b.N; i++ {
			if _, err := Replay(crowdedSeed, crowdedBase, crowdedSegment.ToTick, crowdedSegment.Drops); err != nil {
				b.Fatal(err)
			}
		}
	})
	f := fixtures[1]
	cp := f.Segments[1].Expected
	segment := f.Segments[2]
	b.Run("normal-legal", func(b *testing.B) {
		b.ReportMetric(float64(len(cp.Bodies)), "bodies")
		b.ReportMetric(float64(segment.ToTick-cp.Tick), "ticks/op")
		for i := 0; i < b.N; i++ {
			if _, err := Replay(f.Seed, cp, segment.ToTick, segment.Drops); err != nil {
				b.Fatal(err)
			}
		}
	})
}
