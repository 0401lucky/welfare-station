package gamewatermelon

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strings"
)

func validSeed(seed string) bool {
	if len(seed) < 1 || len(seed) > 128 {
		return false
	}
	for i := 0; i < len(seed); i++ {
		if seed[i] < 32 || seed[i] > 126 {
			return false
		}
	}
	return true
}

func Initial(seed string) Snapshot { return newGame(seed).snapshot() }
func (g *game) snapshot() Snapshot {
	cp := Snapshot{Version: Version, Tick: g.tick, Drops: g.drops, Score: g.score, Highest: g.highest, NextID: g.nextID,
		CooldownTicks: g.cooldown, OverflowTicks: g.overflow, Phase: "playing", Bodies: make([]BodyState, 0, len(g.world.bodies))}
	if g.over {
		cp.Phase = "over"
	}
	for _, b := range g.world.bodies {
		state := BodyState{ID: b.id, Level: b.level, AgeTicks: b.ageTicks, Touched: b.touched, Nodes: make([]NodeState, Nodes)}
		for i, p := range b.nodes {
			state.Nodes[i] = NodeState{int64(math.Floor(float64(p.x*Scale) + .5)), int64(math.Floor(float64(p.y*Scale) + .5)), int64(math.Floor(float64(p.px*Scale) + .5)), int64(math.Floor(float64(p.py*Scale) + .5))}
		}
		cp.Bodies = append(cp.Bodies, state)
	}
	return cp
}

// Validate rejects corrupted/version-mismatched server saves. The browser is
// never permitted to submit this shape as a checkpoint or a replacement state.
func Validate(cp Snapshot) error {
	if cp.Version != Version || cp.Tick < 0 || cp.Tick > MaxTick || cp.Drops < 0 || cp.Drops > MaxTick || cp.Score < 0 || cp.Score > 2147483647 || cp.Highest < -1 || cp.Highest == 0 || cp.Highest >= len(radii) || cp.NextID < 1 || cp.NextID > MaxTick*2+1 || cp.CooldownTicks < 0 || cp.CooldownTicks > cooldownTicks || cp.OverflowTicks < 0 || cp.OverflowTicks > overflowTicks || (cp.Phase != "playing" && cp.Phase != "over") || len(cp.Bodies) > MaxBodies || cp.Bodies == nil {
		return ErrInvalidSnapshot
	}
	ids := make(map[int]bool, len(cp.Bodies))
	for _, b := range cp.Bodies {
		if b.ID < 1 || b.ID >= cp.NextID || ids[b.ID] || b.Level < 0 || b.Level >= len(radii) || b.AgeTicks < 0 || b.AgeTicks > MaxTick || len(b.Nodes) != Nodes {
			return ErrInvalidSnapshot
		}
		ids[b.ID] = true
		for _, p := range b.Nodes {
			for _, v := range p {
				if v < -maxCoord || v > maxCoord {
					return ErrInvalidSnapshot
				}
			}
		}
	}
	return nil
}
func restore(seed string, cp Snapshot) (*game, error) {
	if !validSeed(seed) {
		return nil, ErrInvalidSnapshot
	}
	if err := Validate(cp); err != nil {
		return nil, err
	}
	g := newGame(seed)
	g.tick, g.drops, g.score, g.highest, g.nextID = cp.Tick, cp.Drops, cp.Score, cp.Highest, cp.NextID
	g.cooldown, g.overflow, g.over = cp.CooldownTicks, cp.OverflowTicks, cp.Phase == "over"
	for _, state := range cp.Bodies {
		b := createFruit(state.ID, state.Level, 0, 0, 0)
		b.ageTicks, b.touched = state.AgeTicks, state.Touched
		for i, p := range state.Nodes {
			b.nodes[i].x, b.nodes[i].y, b.nodes[i].px, b.nodes[i].py = float64(p[0])/Scale, float64(p[1])/Scale, float64(p[2])/Scale, float64(p[3])/Scale
		}
		measure(b)
		g.world.bodies = append(g.world.bodies, b)
	}
	return g, nil
}

func Encode(cp Snapshot) (string, error) {
	if err := Validate(cp); err != nil {
		return "", err
	}
	payload, err := json.Marshal(cp)
	if err != nil {
		return "", err
	}
	if len(payload) > MaxSnapshotBytes {
		return "", ErrInvalidSnapshot
	}
	return string(payload), nil
}
func Decode(seed, payload string) (Snapshot, error) {
	if !validSeed(seed) {
		return Snapshot{}, ErrInvalidSnapshot
	}
	if len(payload) > MaxSnapshotBytes {
		return Snapshot{}, ErrInvalidSnapshot
	}
	if strings.TrimSpace(payload) == "" {
		return Initial(seed), nil
	}
	var cp Snapshot
	decoder := json.NewDecoder(bytes.NewBufferString(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cp); err != nil {
		return Snapshot{}, ErrInvalidSnapshot
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return Snapshot{}, ErrInvalidSnapshot
	}
	return cp, Validate(cp)
}

// ValidateSegment performs cheap bounds checks before a database lock or any
// physics work. Both the tick and successful-drop token are checked by service.
func ValidateSegment(baseTick, baseMoves, toTick int, drops []Drop) error {
	if baseTick < 0 || baseTick > MaxTick || baseMoves < 0 || baseMoves > MaxTick || toTick < baseTick || toTick > MaxTick || toTick-baseTick > MaxSegmentTicks || len(drops) > MaxDrops {
		return ErrInvalidInput
	}
	last := baseTick
	for _, d := range drops {
		if d.Tick < last || d.Tick > toTick || d.X < 0 || d.X > 360 {
			return ErrInvalidInput
		}
		last = d.Tick
	}
	return nil
}

// Replay never mutates cp. Each invalid event aborts the entire candidate;
// callers only persist the returned state after all validation succeeds.
func Replay(seed string, cp Snapshot, toTick int, drops []Drop) (Snapshot, error) {
	if err := ValidateSegment(cp.Tick, cp.Drops, toTick, drops); err != nil {
		return Snapshot{}, err
	}
	g, err := restore(seed, cp)
	if err != nil {
		return Snapshot{}, err
	}
	advance := func(target int) error {
		for g.tick < target {
			if !g.step() {
				return fmt.Errorf("%w: 本局已结束", ErrInvalidInput)
			}
		}
		return nil
	}
	for _, d := range drops {
		if err := advance(d.Tick); err != nil {
			return Snapshot{}, err
		}
		if !g.drop(d.X) {
			return Snapshot{}, fmt.Errorf("%w: 无法在该时刻投放", ErrInvalidInput)
		}
	}
	if err := advance(toTick); err != nil {
		return Snapshot{}, err
	}
	final := g.snapshot()
	if err := Validate(final); err != nil {
		return Snapshot{}, err
	}
	return final, nil
}
