package gamewatermelon

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"
)

// These exact vectors are shared with the shipped JS engine tests, including
// decimal-index boundaries and random access far beyond a short opening round.
func TestSpawnKnownVectorsAndRandomAccess(t *testing.T) {
	var vectors []struct {
		Seed   string `json:"seed"`
		Start  int    `json:"start_index"`
		Levels []int  `json:"levels"`
	}
	raw, err := os.ReadFile("testdata/spawn-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		for i, want := range v.Levels {
			if got := SpawnLevel(v.Seed, v.Start+i); got != want {
				t.Fatalf("seed %s index %d: got %d want %d", v.Seed, v.Start+i, got, want)
			}
		}
		// Random access must not consume a mutable RNG or depend on call order.
		for i := len(v.Levels) - 1; i >= 0; i-- {
			if got := SpawnLevel(v.Seed, v.Start+i); got != v.Levels[i] {
				t.Fatal("sequence changed with call order")
			}
		}
	}
}

func TestSpawnRegressionOpeningHasAllLowStages(t *testing.T) {
	seed := "0123456789abcdef0123456789abcdef"
	sequence, other := make([]int, 20), make([]int, 20)
	seen := map[int]bool{}
	for i := range sequence {
		sequence[i] = SpawnLevel(seed, i)
		other[i] = SpawnLevel("00000000000000000000000000000000", i)
		if i < 12 {
			seen[sequence[i]] = true
		}
		if SpawnLevel(seed, i) != sequence[i] {
			t.Fatal("same seed must be repeatable")
		}
	}
	if len(seen) != 3 {
		t.Fatalf("regression: raw FNV mapped the first 20 adjacent indices to one fruit: %v", sequence)
	}
	if reflect.DeepEqual(sequence, other) {
		t.Fatal("different seeds produced the same opening")
	}
}

func TestSpawnDistributionAndAdjacentIndependence(t *testing.T) {
	const seeds = 32
	const perSeed = 2048
	counts := [3]int{}
	transitions := 0
	for s := 0; s < seeds; s++ {
		seed := fmt.Sprintf("%032x", s)
		previous := -1
		for i := 0; i < perSeed; i++ {
			level := SpawnLevel(seed, i)
			if level < 0 || level > 2 {
				t.Fatalf("spawned non-low-stage fruit: %d", level)
			}
			counts[level]++
			if previous >= 0 && level != previous {
				transitions++
			}
			previous = level
		}
	}
	for level, count := range counts {
		fraction := float64(count) / (seeds * perSeed)
		if fraction < .30 || fraction > .37 {
			t.Fatalf("stage %d biased fraction %.4f", level, fraction)
		}
	}
	rate := float64(transitions) / float64(seeds*(perSeed-1))
	// Independent three-way draws change ~2/3 of the time. This catches raw FNV
	// index blocks AND an accidental forced-no-repeat/bag workaround.
	if rate < .60 || rate > .73 {
		t.Fatalf("adjacent transition rate %.4f, want near 2/3", rate)
	}
	t.Logf("65536 draws: counts=%v, adjacent transition rate=%.4f", counts, rate)
}
