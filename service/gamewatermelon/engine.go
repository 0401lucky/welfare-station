package gamewatermelon

import (
	"math"
	"strconv"
)

func clamp(x, low, high float64) float64 { return max(low, min(high, x)) }
func quant(x float64) float64            { return math.Floor(float64(x*Scale)+.5) / Scale }
func area(nodes *[Nodes]node) float64 {
	result := 0.0
	for i := range nodes {
		a, b := &nodes[i], &nodes[(i+1)%Nodes]
		result += float64(a.x*b.y) - float64(b.x*a.y)
	}
	return result / 2
}
func measure(b *body) {
	x, y := 0.0, 0.0
	box := bounds{math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)}
	for i := range b.nodes {
		p := &b.nodes[i]
		x += p.x
		y += p.y
		box.left = min(box.left, p.x)
		box.right = max(box.right, p.x)
		box.top = min(box.top, p.y)
		box.bottom = max(box.bottom, p.y)
	}
	b.x, b.y, b.bounds = x/Nodes, y/Nodes, box
}
func quantize(b *body, previous bool) {
	for i := range b.nodes {
		p := &b.nodes[i]
		p.x, p.y = quant(p.x), quant(p.y)
		if previous {
			p.px, p.py = quant(p.px), quant(p.py)
		}
	}
	measure(b)
}
func createFruit(id, level int, x, y, vy float64) *body {
	r := radii[level]
	b := &body{id: id, level: level, radius: r, targetArea: float64(r*r) * areaUnit, edge: r * edgeUnit, invMass: 1 / float64(r*r)}
	for i, v := range ring {
		rx, ry := float64(v[0]*r), float64(v[1]*r)
		b.nodes[i] = node{x: quant(x + rx), y: quant(y + ry), px: quant(x + rx), py: quant(float64(y+ry) - float64(vy*step)), rx: rx, ry: ry}
	}
	measure(b)
	return b
}
func createWorld() *world { return &world{left: 28, right: 332, bottom: 518, bodies: []*body{}} }

// Explicit binary64 casts forbid fused multiply-add, keeping the evaluation
// order used by JavaScript on ARM64 as well as x86. Trig is display-only in JS.
func shapeConstraints(b *body) {
	nodes, r := &b.nodes, b.radius
	measure(b)
	cross, dot := 0.0, 0.0
	for i := range nodes {
		p := &nodes[i]
		dx, dy := p.x-b.x, p.y-b.y
		cross += float64(p.rx*dy) - float64(p.ry*dx)
		dot += float64(p.rx*dx) + float64(p.ry*dy)
	}
	norm := math.Sqrt(float64(dot*dot) + float64(cross*cross))
	co, si := 1.0, 0.0
	if norm > .000001 {
		co, si = dot/norm, cross/norm
	}
	for i := range nodes {
		p := &nodes[i]
		tx := float64(b.x+float64(p.rx*co)) - float64(p.ry*si)
		ty := float64(b.y+float64(p.rx*si)) + float64(p.ry*co)
		p.x += float64((tx - p.x) * .0016)
		p.y += float64((ty - p.y) * .0016)
		dx, dy := p.x-b.x, p.y-b.y
		distance := math.Sqrt(float64(dx*dx) + float64(dy*dy))
		safe := clamp(distance, r*.48, r*1.6)
		if distance > .001 && safe != distance {
			p.x += float64(float64(dx*(safe/distance-1)) * .65)
			p.y += float64(float64(dy*(safe/distance-1)) * .65)
		}
		p.sx, p.sy = 0, 0
	}
	for i := range nodes {
		a, c := &nodes[i], &nodes[(i+1)%Nodes]
		dx, dy := c.x-a.x, c.y-a.y
		length := math.Sqrt(float64(dx*dx) + float64(dy*dy))
		if length < .001 {
			continue
		}
		stiffness := .035
		if length > b.edge*1.55 || length < b.edge*.5 {
			stiffness = .35
		}
		scale := float64(float64((length-b.edge)/length)*stiffness) * .5
		a.sx += float64(dx * scale)
		a.sy += float64(dy * scale)
		c.sx -= float64(dx * scale)
		c.sy -= float64(dy * scale)
	}
	for i := range nodes {
		p := &nodes[i]
		p.x += p.sx
		p.y += p.sy
		p.sx, p.sy = 0, 0
	}
	for i := range nodes {
		a, p, c := &nodes[(i+Nodes-1)%Nodes], &nodes[i], &nodes[(i+1)%Nodes]
		dx, dy := c.x-a.x, c.y-a.y
		length := math.Sqrt(float64(dx*dx) + float64(dy*dy))
		if length < .001 {
			continue
		}
		side := (float64((p.x-a.x)*dy) - float64((p.y-a.y)*dx)) / length
		if side < .04 {
			push := (.04 - side) * .8
			p.sx = float64(dy/length) * push
			p.sy = float64(-dx/length) * push
		}
	}
	for i := range nodes {
		p := &nodes[i]
		p.x += p.sx
		p.y += p.sy
	}
	err := b.targetArea - area(nodes)
	denominator := 0.0
	for i := range nodes {
		a, c, p := &nodes[(i+Nodes-1)%Nodes], &nodes[(i+1)%Nodes], &nodes[i]
		p.gx, p.gy = (c.y-a.y)*.5, (a.x-c.x)*.5
		denominator += float64(p.gx*p.gx) + float64(p.gy*p.gy)
	}
	lambda := clamp(float64(err/max(denominator, .001))*.98, -.18, .18)
	for i := range nodes {
		p := &nodes[i]
		p.x += float64(p.gx * lambda)
		p.y += float64(p.gy * lambda)
	}
	measure(b)
}

type pointHit struct {
	edge                    int
	fraction, nx, ny, depth float64
}

func pointContact(p *node, b *body) (pointHit, bool) {
	nodes := &b.nodes
	inside, distance2 := false, math.Inf(1)
	edge, fraction, qx, qy := 0, 0.0, 0.0, 0.0
	for i, j := 0, Nodes-1; i < Nodes; j, i = i, i+1 {
		a, c := &nodes[j], &nodes[i]
		if (a.y > p.y) != (c.y > p.y) && p.x < float64(float64((c.x-a.x)*(p.y-a.y))/(c.y-a.y))+a.x {
			inside = !inside
		}
		dx, dy := c.x-a.x, c.y-a.y
		t := clamp((float64((p.x-a.x)*dx)+float64((p.y-a.y)*dy))/max(float64(dx*dx)+float64(dy*dy), .001), 0, 1)
		x, y := a.x+float64(dx*t), a.y+float64(dy*t)
		ex, ey := p.x-x, p.y-y
		d2 := float64(ex*ex) + float64(ey*ey)
		if d2 < distance2 {
			distance2, edge, fraction, qx, qy = d2, j, t, x, y
		}
	}
	if !inside && distance2 > float64(contactSkin)*float64(contactSkin) {
		return pointHit{}, false
	}
	distance := math.Sqrt(distance2)
	nx, ny := 0.0, 0.0
	if distance > .0001 {
		nx, ny = (qx-p.x)/distance, (qy-p.y)/distance
		if !inside {
			nx, ny = -nx, -ny
		}
	} else {
		a, c := &nodes[edge], &nodes[(edge+1)%Nodes]
		dx, dy := c.x-a.x, c.y-a.y
		length := math.Sqrt(float64(dx*dx) + float64(dy*dy))
		if length == 0 {
			length = 1
		}
		nx, ny = dy/length, -dx/length
	}
	depth := contactSkin - distance
	if inside {
		depth = distance + contactSkin
	}
	return pointHit{edge, fraction, nx, ny, depth}, true
}
func separate(a, b *body) bool {
	touching := false
	for i := range a.nodes {
		p := &a.nodes[i]
		if p.x < b.bounds.left-contactSkin || p.x > b.bounds.right+contactSkin || p.y < b.bounds.top-contactSkin || p.y > b.bounds.bottom+contactSkin {
			continue
		}
		hit, ok := pointContact(p, b)
		if !ok {
			continue
		}
		touching = true
		q, r := &b.nodes[hit.edge], &b.nodes[(hit.edge+1)%Nodes]
		u, v := 1-hit.fraction, hit.fraction
		denominator := a.invMass + float64(b.invMass*(float64(u*u)+float64(v*v)))
		correction := float64(min(hit.depth, min(a.radius, b.radius)*.35)*.92) / denominator
		p.x += float64(float64(hit.nx*correction) * a.invMass)
		p.y += float64(float64(hit.ny*correction) * a.invMass)
		q.x -= float64(float64(float64(hit.nx*correction)*b.invMass) * u)
		q.y -= float64(float64(float64(hit.ny*correction)*b.invMass) * u)
		r.x -= float64(float64(float64(hit.nx*correction)*b.invMass) * v)
		r.y -= float64(float64(float64(hit.ny*correction)*b.invMass) * v)
	}
	return touching
}
func keepInside(b *body, w *world) {
	for i := range b.nodes {
		p := &b.nodes[i]
		p.x = clamp(p.x, w.left, w.right)
		if p.y >= w.bottom {
			p.y, b.contact, b.touched = w.bottom, true, true
		}
	}
	measure(b)
}
func stepWorld(w *world) {
	bodies := w.bodies
	// Pair indices are stable during a step. Reuse this bounded membership table
	// while retaining first-contact order and the last pair orientation (JS Map).
	contacts := w.contacts[:0]
	clear(w.contactIndex[:])
	for _, b := range bodies {
		b.ageTicks++
		b.contact = false
		vx, vy := 0.0, 0.0
		for i := range b.nodes {
			p := &b.nodes[i]
			vx += p.x - p.px
			vy += p.y - p.py
		}
		vx /= Nodes
		vy /= Nodes
		for i := range b.nodes {
			p := &b.nodes[i]
			dx := clamp(float64((p.x-p.px)*.78)+float64(vx*.215), -3.5, 3.5)
			dy := clamp(float64((p.y-p.py)*.78)+float64(vy*.215), -3.5, 3.5)
			p.px, p.py = p.x, p.y
			p.x += dx
			// Store intermediates to match JS (760 * STEP * STEP), not rational constant folding.
			gravityStep := float64(760 * float64(step))
			gravityStep = float64(gravityStep * float64(step))
			p.y += dy + gravityStep
		}
	}
	for iteration := 0; iteration < iterations; iteration++ {
		for _, b := range bodies {
			shapeConstraints(b)
			keepInside(b, w)
		}
		for ii := range bodies {
			i := ii
			if iteration%2 != 0 {
				i = len(bodies) - 1 - ii
			}
			a := bodies[i]
			for jj := ii + 1; jj < len(bodies); jj++ {
				j := jj
				if iteration%2 != 0 {
					j = len(bodies) - 1 - jj
				}
				b := bodies[j]
				if a.bounds.right+contactSkin < b.bounds.left || b.bounds.right+contactSkin < a.bounds.left || a.bounds.bottom+contactSkin < b.bounds.top || b.bounds.bottom+contactSkin < a.bounds.top {
					continue
				}
				ab, ba := separate(a, b), separate(b, a)
				if ab || ba {
					a.contact, b.contact, a.touched, b.touched = true, true, true, true
					key := min(i, j)*MaxBodies + max(i, j)
					if at := w.contactIndex[key]; at > 0 {
						contacts[at-1] = contact{a, b}
					} else {
						contacts = append(contacts, contact{a, b})
						w.contactIndex[key] = uint16(len(contacts))
					}
					measure(a)
					measure(b)
				}
			}
		}
		for _, b := range bodies {
			keepInside(b, w)
			quantize(b, false)
		}
	}
	for _, b := range bodies {
		for i := range b.nodes {
			p := &b.nodes[i]
			if p.y >= w.bottom-.05 {
				p.px += float64((p.x - p.px) * .12)
				p.py = p.y
			}
			if p.x <= w.left+.05 || p.x >= w.right-.05 {
				p.px = p.x
			}
		}
		quantize(b, true)
	}
	w.contacts = contacts
}

// ASCII input is intentional: session seeds are crypto/rand lowercase hex.
func SpawnLevel(seed string, index int) int {
	hash := uint32(2166136261)
	input := seed + ":watermelon:spawn:" + strconv.Itoa(index)
	for i := 0; i < len(input); i++ {
		hash = (hash ^ uint32(input[i])) * 16777619
	}
	// Raw FNV's neighbouring decimal indices share high bits. The same Murmur3
	// fmix32 finalizer in engine.js removes those index-induced fruit blocks.
	hash ^= hash >> 16
	hash *= 0x85ebca6b
	hash ^= hash >> 13
	hash *= 0xc2b2ae35
	hash ^= hash >> 16
	return int(math.Floor(float64(hash) / 4294967296 * 3))
}
func newGame(seed string) *game {
	return &game{seed: seed, world: createWorld(), highest: -1, nextID: 1}
}
func (g *game) drop(x int) bool {
	if g.over || g.cooldown > 0 || len(g.world.bodies) >= MaxBodies {
		return false
	}
	level := SpawnLevel(g.seed, g.drops)
	r := radii[level]
	aim := clamp(float64(x), g.world.left+r+2, g.world.right-r-2)
	for _, b := range g.world.bodies {
		if b.bounds.top < 87+r && b.bounds.bottom > 87-r && b.bounds.left < aim+r && b.bounds.right > aim-r {
			return false
		}
	}
	b := createFruit(g.nextID, level, aim, 87, 25)
	g.nextID++
	g.drops++
	g.cooldown = cooldownTicks
	g.world.bodies = append(g.world.bodies, b)
	if len(g.world.bodies) >= MaxBodies {
		g.over = true
	}
	return true
}
func (g *game) mergeContacts() {
	consumed := make(map[int]bool)
	born := make([]*body, 0)
	for _, pair := range g.world.contacts {
		a, b := pair.a, pair.b
		if a.level != b.level || a.level == len(radii)-1 || consumed[a.id] || consumed[b.id] || a.ageTicks < mergeAgeTicks || b.ageTicks < mergeAgeTicks {
			continue
		}
		consumed[a.id], consumed[b.id] = true, true
		level := a.level + 1
		radius := radii[level]
		x, y := (a.x+b.x)/2, (a.y+b.y)/2
		fruit := createFruit(g.nextID, level, x, y, 0)
		g.nextID++
		dx, dy := b.x-a.x, b.y-a.y
		distance := math.Sqrt(float64(dx*dx) + float64(dy*dy))
		co, si := 1.0, 0.0
		if distance > .000001 {
			co, si = dx/distance, dy/distance
		}
		stretch := clamp((float64(distance*.5)+a.radius)/radius, 1, 1.42)
		vx, vy := 0.0, 0.0
		for _, parent := range []*body{a, b} {
			for i := range parent.nodes {
				p := &parent.nodes[i]
				vx += p.x - p.px
				vy += p.y - p.py
			}
		}
		vx = clamp(vx/(Nodes*2), -1.5, 1.5)
		vy = clamp(vy/(Nodes*2), -1.5, 1.5)
		for i := range fruit.nodes {
			p := &fruit.nodes[i]
			along, across := float64(p.rx*co)+float64(p.ry*si), float64(-p.rx*si)+float64(p.ry*co)
			p.x = float64(x+float64(float64(along*stretch)*co)) - float64(float64(across/stretch)*si)
			p.y = float64(y+float64(float64(along*stretch)*si)) + float64(float64(across/stretch)*co)
		}
		measure(fruit)
		moveX := math.Max(0, g.world.left-fruit.bounds.left) - math.Max(0, fruit.bounds.right-g.world.right)
		moveY := -math.Max(0, fruit.bounds.bottom-g.world.bottom)
		for i := range fruit.nodes {
			p := &fruit.nodes[i]
			p.x += moveX
			p.y += moveY
			p.px = p.x - vx
			p.py = p.y - vy
		}
		quantize(fruit, true)
		fruit.touched = a.touched || b.touched
		born = append(born, fruit)
		g.score += int64(1 << level)
		g.highest = max(g.highest, level)
	}
	if len(consumed) > 0 {
		remaining := make([]*body, 0, len(g.world.bodies)-len(consumed)+len(born))
		for _, b := range g.world.bodies {
			if !consumed[b.id] {
				remaining = append(remaining, b)
			}
		}
		g.world.bodies = append(remaining, born...)
	}
}
func (g *game) step() bool {
	if g.over {
		return false
	}
	g.cooldown = max(0, g.cooldown-1)
	stepWorld(g.world)
	g.tick++
	g.mergeContacts()
	overflowing := false
	for _, b := range g.world.bodies {
		if b.ageTicks > overflowAgeTicks && b.touched && b.bounds.top < 137 {
			overflowing = true
			break
		}
	}
	if overflowing {
		g.overflow++
	} else {
		g.overflow = max(0, g.overflow-2)
	}
	if g.overflow >= overflowTicks || len(g.world.bodies) >= MaxBodies {
		g.over = true
	}
	return true
}
