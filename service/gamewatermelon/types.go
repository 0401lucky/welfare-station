// Package gamewatermelon replays the actual deformable-membrane browser game.
// Keep engine.go and the shipped engine.js arithmetic in sync; exact canonical
// particle fixtures (not just scores) are the reward release gate.
package gamewatermelon

import (
	"encoding/json"
	"errors"
)

const (
	GameType         = "watermelon"
	Version          = "watermelon-v1"
	TickRate         = 120
	Scale            = 100000
	Nodes            = 16
	MaxBodies        = 64
	MaxSegmentTicks  = 600
	MaxDrops         = 32
	MaxRequestBytes  = 16 * 1024
	MaxSnapshotBytes = 60 * 1024
	MaxTick          = 100000000
	maxCoord         = 4096 * Scale
	iterations       = 9
	step             = 1.0 / TickRate
	contactSkin      = 0.45
	cooldownTicks    = 58
	mergeAgeTicks    = 16
	overflowAgeTicks = 204
	overflowTicks    = 300
	areaUnit         = 3.0614674589207183
	edgeUnit         = 0.39018064403225655
)

var (
	ErrInvalidInput    = errors.New("西瓜进度参数不合法")
	ErrInvalidSnapshot = errors.New("西瓜存档已损坏或版本不兼容，请放弃本局后重开")
)

type Limits struct {
	MaxSegmentTicks int `json:"max_segment_ticks"`
	MaxDrops        int `json:"max_drops"`
	MaxBodies       int `json:"max_bodies"`
}

func RequestLimits() *Limits { return &Limits{MaxSegmentTicks, MaxDrops, MaxBodies} }

// Drop is the only authoritative player input. Tick counts completed steps;
// replay first advances to that tick, then attempts this drop.
type Drop struct {
	Tick int `json:"tick"`
	X    int `json:"x"`
}

// NodeState stores only integer positions and previous positions. All material
// rest vectors, scratch buffers, bounds and contact references are derived.
type NodeState [4]int64

func (n *NodeState) UnmarshalJSON(raw []byte) error {
	// encoding/json silently pads/truncates fixed arrays by default; a saved
	// particle must have exactly four integer coordinates, never a partial tuple.
	var values []int64
	if err := json.Unmarshal(raw, &values); err != nil {
		return err
	}
	if len(values) != 4 {
		return ErrInvalidSnapshot
	}
	copy(n[:], values)
	return nil
}

type BodyState struct {
	ID       int         `json:"id"`
	Level    int         `json:"level"`
	AgeTicks int         `json:"age_ticks"`
	Touched  bool        `json:"touched"`
	Nodes    []NodeState `json:"nodes"`
}
type Snapshot struct {
	Version       string      `json:"version"`
	Tick          int         `json:"tick"`
	Drops         int         `json:"drops"`
	Score         int64       `json:"score"`
	Highest       int         `json:"highest"`
	NextID        int         `json:"next_id"`
	CooldownTicks int         `json:"cooldown_ticks"`
	OverflowTicks int         `json:"overflow_ticks"`
	Phase         string      `json:"phase"`
	Bodies        []BodyState `json:"bodies"`
}

// HighestTile deliberately excludes initially spawned fruit from rewards.
func (cp Snapshot) HighestTile() int {
	if cp.Highest < 1 || cp.Highest >= len(radii) {
		return 0
	}
	return 1 << (cp.Highest + 1)
}

var radii = [9]float64{14, 18, 23, 29, 37, 46, 58, 73, 92}
var ring = [Nodes][2]float64{
	{1, 0}, {.9238795325112867, .3826834323650898}, {.7071067811865476, .7071067811865476}, {.3826834323650898, .9238795325112867},
	{0, 1}, {-.3826834323650898, .9238795325112867}, {-.7071067811865476, .7071067811865476}, {-.9238795325112867, .3826834323650898},
	{-1, 0}, {-.9238795325112867, -.3826834323650898}, {-.7071067811865476, -.7071067811865476}, {-.3826834323650898, -.9238795325112867},
	{0, -1}, {.3826834323650898, -.9238795325112867}, {.7071067811865476, -.7071067811865476}, {.9238795325112867, -.3826834323650898},
}

type node struct{ x, y, px, py, rx, ry, gx, gy, sx, sy float64 }
type bounds struct{ left, right, top, bottom float64 }
type body struct {
	id, level, ageTicks                     int
	radius, targetArea, edge, invMass, x, y float64
	touched, contact                        bool
	nodes                                   [Nodes]node
	bounds                                  bounds
}
type contact struct{ a, b *body }
type world struct {
	left, right, bottom float64
	bodies              []*body
	contacts            []contact
	contactIndex        [MaxBodies * MaxBodies]uint16
}
type game struct {
	seed                                             string
	world                                            *world
	tick, drops, highest, nextID, cooldown, overflow int
	score                                            int64
	over                                             bool
}
