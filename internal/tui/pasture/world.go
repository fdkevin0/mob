// Package pasture is an artificial-life sim for the terminal: flocks of
// butterflies and the calves that play with them, drawn as ASCII cells.
// It ports stackedlol/ascii-sharks to Bubble Tea, with calves in place of the
// sharks and butterflies in place of the fish.
//
// Butterflies: Reynolds boids (separation / alignment / cohesion) in
// Couzin-style zones, with a blind spot behind each one. Alarm spreads from
// butterfly to butterfly through the flock, so a whole flock bolts even when
// only its edge can see the calf, and fleeing butterflies break sideways
// around the calf's path.
//
// Calves: Reynolds steering (wander + pursuit + separation). Playfulness
// builds over time and drops when a calf catches a butterfly. They prefer
// butterflies in sparse spots, so stragglers get caught. A calf that has
// played enough lies down for a nap, and two idle calves that meet stop for
// a high five. Caught butterflies come back later as new flocks fluttering
// in from the edges, which keeps the population steady.
package pasture

import (
	"math"
	"math/rand/v2"
	"slices"
)

// Calf says which calf to put in the field. Size is relative to the biggest
// and Coat picks its hide: 0 is the Mob orange, any other value a seeded coat.
type Calf struct {
	Size float64
	Coat int
}

// The default herd: four calves at different depths, the orange one in front.
var defaultHerd = []Calf{{Size: 1, Coat: 0}, {Size: 0.7, Coat: 3}, {Size: 0.84, Coat: 9}, {Size: 0.77, Coat: 15}}

type butterfly struct {
	x, y, vx, vy float64
	species      int
	// alarm runs from 0 calm to 1 panicking and spreads to neighbours.
	alarm     float64
	alive     bool
	respawnAt float64
	// phase drives the wing beat.
	phase float64
	// turn is the smoothed angular velocity in rad/s; hard turns glint.
	turn float64
	// depth runs from 0.55 far to 1 near.
	depth   float64
	millDir float64
}

type activity int

const (
	roaming activity = iota
	napping
	highFiving
)

type calf struct {
	id, coat int
	// length is the sprite's width and height its height, in pixels.
	length, height float64
	// x, y is the middle of the sprite.
	x, y, heading, speed float64
	// phase drives the gait.
	phase float64
	// turn is the smoothed angular velocity in rad/s.
	turn float64
	// facing is 1 when the head is on the right and -1 when on the left.
	facing float64
	hunger float64
	// tired builds while the calf plays; at 1 it lies down for a nap.
	tired       float64
	wander      float64
	orbitDir    float64
	orbitRadius float64
	target      int
	retargetAt  float64
	hunting     bool
	// depth runs from 0 far and dim to 1 near and bright.
	depth      float64
	state      activity
	stateUntil float64
	nextSocial float64
	// alertUntil shows a "!" over the calf: it spotted a butterfly or was startled.
	alertUntil float64
}

// mouth is where the calf catches butterflies.
func (c *calf) mouth() (float64, float64) {
	return c.x + c.facing*c.length*0.4, c.y - c.height*0.12
}

// points are the front half of the calf, which butterflies keep away from.
func (c *calf) points() [3][2]float64 {
	mx, my := c.mouth()
	return [3][2]float64{{mx, my}, {c.x + c.facing*c.length*0.2, c.y}, {c.x, c.y}}
}

type eventKind int

const (
	caught eventKind = iota
	splashed
	sparked
)

type event struct {
	kind eventKind
	x, y float64
}

const (
	separationK = 420
	alignK      = 1.4
	cohesionK   = 1.0
	fleeK       = 1100
	// blindCos keeps about 127° either side of the heading visible.
	blindCos = -0.6
)

type world struct {
	width, height float64
	time          float64
	flutters      []butterfly
	calves        []calf
	events        []event
	pointer       struct {
		x, y   float64
		active bool
	}
	herd []Calf

	// perception is the neighbourhood radius; hash buckets match it.
	perception float64
	sepX, sepY []float64
	foreignSep float64
	bucketCols int
	bucketRows int
	bucketHead []int32
	bucketCnt  []uint16
	bucketNext []int32
	lastSpawn  float64
}

func newWorld(herd []Calf) *world {
	if len(herd) == 0 {
		herd = defaultHerd
	}
	return &world{herd: herd, perception: 60, foreignSep: 40}
}

func (w *world) resize(width, height, cellW, cellH float64) {
	first := w.width == 0
	w.width, w.height = width, height
	// Spacing is set in grid cells so every butterfly lands in its own cell.
	w.sepX = w.sepX[:0]
	w.sepY = w.sepY[:0]
	for _, sp := range allSpecies {
		w.sepX = append(w.sepX, sp.spacing[0]*cellW)
		w.sepY = append(w.sepY, sp.spacing[1]*cellH)
	}
	w.perception = math.Max(cellH*3, cellW*5.5)
	w.foreignSep = cellW * 3
	if first || len(w.flutters) == 0 {
		w.seed()
		return
	}
	for i := range w.flutters {
		f := &w.flutters[i]
		f.x = clamp(f.x, 0, width)
		f.y = clamp(f.y, 0, height)
	}
	for i := range w.calves {
		c := &w.calves[i]
		c.x = clamp(c.x, 0, width)
		c.y = clamp(c.y, 0, height)
	}
}

func (w *world) seed() {
	W, H := w.width, w.height
	minSide := math.Min(W, H)
	// Sprite pixels are a cell wide and half a cell tall.
	length, height := float64(spriteW*cellW), float64(spriteH*cellH/2)

	w.calves = w.calves[:0]
	for i, spec := range w.herd {
		orbitRadius := minSide * between(0.28, 0.4)
		a := float64(i)/float64(len(w.herd))*tau + between(-0.4, 0.4)
		orbitDir := 1.0
		if i%2 == 1 {
			orbitDir = -1
		}
		heading := a + orbitDir*math.Pi/2
		facing := 1.0
		if math.Cos(heading) < 0 {
			facing = -1
		}
		w.calves = append(w.calves, calf{
			id:          i + 1,
			coat:        spec.Coat,
			length:      length,
			height:      height,
			x:           W/2 + math.Cos(a)*orbitRadius*(W/minSide)*0.9,
			y:           H/2 + math.Sin(a)*orbitRadius*math.Max(0.3, (H-height)/minSide),
			heading:     heading,
			speed:       30,
			phase:       between(0, tau),
			facing:      facing,
			hunger:      between(0.25, 0.75),
			tired:       between(0, 0.5),
			orbitDir:    orbitDir,
			orbitRadius: orbitRadius,
			target:      -1,
			depth:       spec.Size,
			nextSocial:  between(3, 8),
		})
	}
	// Smaller (farther) calves draw first so the big one walks over them.
	slices.SortStableFunc(w.calves, func(a, b calf) int {
		if a.length < b.length {
			return -1
		}
		if a.length > b.length {
			return 1
		}
		return 0
	})

	total := int(clamp(math.Round(W*H/4400), 85, 340))
	w.flutters = w.flutters[:0]
	for len(w.flutters) < total {
		s := pickSpecies()
		sp := allSpecies[s]
		size := min(betweenInt(sp.flockSize[0], sp.flockSize[1]), total-len(w.flutters))
		millDir := 1.0
		if rand.Float64() < 0.5 {
			millDir = -1
		}
		cx := between(W*0.06, W*0.94)
		cy := between(H*0.08, H*0.92)
		// Mostly level headings: butterflies drift sideways far more than up or down.
		dir := between(-0.5, 0.5)
		if rand.Float64() < 0.5 {
			dir += math.Pi
		}
		root := math.Sqrt(float64(size))
		for range size {
			w.flutters = append(w.flutters, butterfly{
				x:       cx + between(-1, 1)*w.sepX[s]*root,
				y:       cy + between(-1, 1)*w.sepY[s]*root*0.6,
				vx:      math.Cos(dir) * sp.cruise,
				vy:      math.Sin(dir) * sp.cruise,
				species: s,
				alive:   true,
				phase:   between(0, tau),
				depth:   between(0.55, 1),
				millDir: millDir,
			})
		}
	}
	w.bucketNext = make([]int32, len(w.flutters))
}

// splash scatters every butterfly nearby and startles calves.
func (w *world) splash(x, y float64) {
	w.events = append(w.events, event{kind: splashed, x: x, y: y})
	const r = 240
	for i := range w.flutters {
		f := &w.flutters[i]
		if !f.alive {
			continue
		}
		dx, dy := f.x-x, f.y-y
		d := math.Hypot(dx, dy)
		if d > r || d < 1e-3 {
			continue
		}
		// Flash expansion: everybody nearby bolts straight out.
		k := (1 - d/r) * 260
		f.vx += dx / d * k
		f.vy += dy / d * k
		f.alarm = 1
	}
	for i := range w.calves {
		c := &w.calves[i]
		if math.Hypot(c.x-x, c.y-y) < r+c.length*0.5 {
			if c.state != roaming {
				c.state = roaming
				c.nextSocial = w.time + between(4, 9)
			}
			c.alertUntil = w.time + 0.8
		}
	}
}

func (w *world) step(dt float64) {
	w.time += dt
	w.rebuildHash()
	w.stepFlutters(dt)
	w.stepCalves(dt)
	w.respawn()
}

func (w *world) rebuildHash() {
	size := w.perception
	const pad = 2
	w.bucketCols = int(math.Ceil(w.width/size)) + pad*2
	w.bucketRows = int(math.Ceil(w.height/size)) + pad*2
	n := w.bucketCols * w.bucketRows
	if len(w.bucketHead) != n {
		w.bucketHead = make([]int32, n)
		w.bucketCnt = make([]uint16, n)
	}
	for i := range w.bucketHead {
		w.bucketHead[i] = -1
		w.bucketCnt[i] = 0
	}
	if len(w.bucketNext) != len(w.flutters) {
		w.bucketNext = make([]int32, len(w.flutters))
	}
	for i := range w.flutters {
		f := &w.flutters[i]
		if !f.alive {
			continue
		}
		b := w.bucketOf(f.x, f.y)
		w.bucketNext[i] = w.bucketHead[b]
		w.bucketHead[b] = int32(i)
		w.bucketCnt[b]++
	}
}

func (w *world) bucketOf(x, y float64) int {
	size := w.perception
	c := int(clamp(math.Floor(x/size)+2, 0, float64(w.bucketCols-1)))
	r := int(clamp(math.Floor(y/size)+2, 0, float64(w.bucketRows-1)))
	return r*w.bucketCols + c
}

func (w *world) stepFlutters(dt float64) {
	W, H, t := w.width, w.height, w.time
	R := w.perception
	R2 := R * R
	cols, rows := w.bucketCols, w.bucketRows
	calmDecay := math.Exp(-dt * 0.7)
	contagion := math.Min(1, dt*6)

	for i := range w.flutters {
		f := &w.flutters[i]
		if !f.alive {
			continue
		}
		sp := allSpecies[f.species]
		// Alarmed butterflies want more room: the flock flashes apart around
		// a calf and closes back up once the threat fades.
		spread := 1 + 1.8*f.alarm
		sepX := w.sepX[f.species] * spread
		sepY := w.sepY[f.species] * spread

		speed := math.Hypot(f.vx, f.vy)
		if speed == 0 {
			speed = 1
		}
		hx, hy := f.vx/speed, f.vy/speed

		var ax, ay, sx, sy, avx, avy, cx, cy, neighbourAlarm float64
		n := 0
		bc := int(clamp(math.Floor(f.x/R)+2, 0, float64(cols-1)))
		br := int(clamp(math.Floor(f.y/R)+2, 0, float64(rows-1)))
		for r := max(0, br-1); r <= min(rows-1, br+1); r++ {
			for c := max(0, bc-1); c <= min(cols-1, bc+1); c++ {
				for j := w.bucketHead[r*cols+c]; j != -1; j = w.bucketNext[j] {
					if int(j) == i {
						continue
					}
					o := &w.flutters[j]
					dx, dy := o.x-f.x, o.y-f.y
					d2 := dx*dx + dy*dy
					if d2 >= R2 || d2 <= 1e-6 {
						continue
					}
					d := math.Sqrt(d2)
					// Blind zone directly behind.
					if (dx*hx+dy*hy)/d <= blindCos {
						continue
					}
					// Elliptical personal space: wide along x, tight along y.
					qx, qy := dx/sepX, dy/sepY
					if q2 := qx*qx + qy*qy; q2 < 1 {
						q := math.Sqrt(q2)
						if q == 0 {
							q = 1e-3
						}
						k := (1 - q) / q
						sx -= qx * k
						sy -= qy * k
					}
					if o.species == f.species {
						avx += o.vx
						avy += o.vy
						cx += dx
						cy += dy
						n++
					} else if d < w.foreignSep {
						// Different species keep their own flocks.
						k := (1 - d/w.foreignSep) / d * 0.6
						sx -= dx * k
						sy -= dy * k
					}
					neighbourAlarm = math.Max(neighbourAlarm, o.alarm)
				}
			}
		}

		ax += sx * separationK
		ay += sy * separationK
		if n > 0 {
			fn := float64(n)
			a := alignK * sp.align
			k := cohesionK * sp.cohesion * (1 - 0.8*f.alarm)
			ax += (avx/fn-f.vx)*a + cx/fn*k
			ay += (avy/fn-f.vy)*a + cy/fn*k
			if sp.mill > 0 {
				// Circle the local centre.
				cl := math.Hypot(cx, cy)
				if cl == 0 {
					cl = 1
				}
				ax += -cy / cl * f.millDir * sp.mill * (1 - f.alarm)
				ay += cx / cl * f.millDir * sp.mill * (1 - f.alarm)
			}
		}

		// Calves. Distance is to the nearest point on the front half of the
		// calf, so butterflies also give its flanks a wide berth.
		fear := 0.0
		for ci := range w.calves {
			c := &w.calves[ci]
			fearR := c.length*0.6 + 60
			best := math.Inf(1)
			var bx, by float64
			for _, p := range c.points() {
				if d2 := (f.x-p[0])*(f.x-p[0]) + (f.y-p[1])*(f.y-p[1]); d2 < best {
					best, bx, by = d2, p[0], p[1]
				}
			}
			d := math.Sqrt(best)
			// A napping calf frightens nobody.
			if d >= fearR || d < 1e-3 || c.state == napping {
				continue
			}
			wt := 1 - d/fearR
			wt *= wt
			awayX, awayY := (f.x-bx)/d, (f.y-by)/d
			// Fountain effect: break to whichever side of the calf's path you're on.
			shx, shy := math.Cos(c.heading), math.Sin(c.heading)
			mx, my := c.mouth()
			side := 1.0
			if shx*(f.y-my)-shy*(f.x-mx) < 0 {
				side = -1
			}
			ax += (awayX*0.7 - shy*side*0.9) * fleeK * wt
			ay += (awayY*0.7 + shx*side*0.9) * fleeK * wt
			fear = math.Max(fear, math.Sqrt(wt))
		}

		if w.pointer.active {
			const pr = 130
			dx, dy := f.x-w.pointer.x, f.y-w.pointer.y
			if d := math.Hypot(dx, dy); d < pr && d > 1e-3 {
				wt := (1 - d/pr) * (1 - d/pr)
				ax += dx / d * fleeK * wt
				ay += dy / d * fleeK * wt
				fear = math.Max(fear, math.Sqrt(wt)*0.8)
			}
		}

		// Alarm: a direct threat sets it, neighbours pass it along (slightly
		// weaker each hop), and it fades on its own.
		alarm := math.Max(f.alarm*calmDecay, fear)
		if relayed := neighbourAlarm * 0.86; relayed > alarm {
			alarm += (relayed - alarm) * contagion
		}
		f.alarm = alarm

		// Soft walls.
		const m = 36
		if f.x < m {
			ax += (m - f.x) * 7
		} else if f.x > W-m {
			ax -= (f.x - (W - m)) * 7
		}
		if f.y < m {
			ay += (m - f.y) * 7
		} else if f.y > H-m {
			ay -= (f.y - (H - m)) * 7
		}

		// The breeze and a little individual restlessness.
		bx, by := breeze(f.x, f.y, t)
		ax += bx*0.5 + (rand.Float64()-0.5)*sp.jitter
		ay += by*0.5 + (rand.Float64()-0.5)*sp.jitter
		// Fly level, except when bolting.
		ay -= f.vy * sp.verticalDrag * (1 - 0.7*f.alarm)

		// Relax toward a preferred speed that rises with panic.
		preferred := sp.cruise * (1 + 1.3*f.alarm)
		ax += (preferred - speed) * hx * 1.6
		ay += (preferred - speed) * hy * 1.6

		before := math.Atan2(f.vy, f.vx)
		f.vx += ax * dt
		f.vy += ay * dt
		maxSpeed := sp.maxSpeed * (1 + 1.8*f.alarm)
		if s := math.Hypot(f.vx, f.vy); s > maxSpeed {
			f.vx *= maxSpeed / s
			f.vy *= maxSpeed / s
		} else if s < sp.minSpeed && s > 1e-3 {
			f.vx *= sp.minSpeed / s
			f.vy *= sp.minSpeed / s
		}
		f.turn += (angleDiff(before, math.Atan2(f.vy, f.vx))/dt - f.turn) * math.Min(1, dt*8)
		f.phase += dt * (7 + math.Hypot(f.vx, f.vy)*0.12)
		f.x = clamp(f.x+f.vx*dt, -60, W+60)
		f.y = clamp(f.y+f.vy*dt, -60, H+60)
	}
}

func (w *world) stepCalves(dt float64) {
	W, H, t := w.width, w.height, w.time
	minSide := math.Min(W, H)
	cxW, cyW := W/2, H/2

	w.socialise()
	for i := range w.calves {
		c := &w.calves[i]
		L := c.length
		c.hunger = math.Min(1, c.hunger+dt*0.03)

		if c.state != roaming {
			// Napping and high fives happen standing still.
			c.speed += (0 - c.speed) * math.Min(1, dt*4)
			c.hunting = false
			c.phase += dt * 1.5
			if t >= c.stateUntil {
				c.state = roaming
				c.nextSocial = t + between(8, 16)
			}
			continue
		}

		hx, hy := c.mouth()

		// Momentum.
		dx, dy := math.Cos(c.heading), math.Sin(c.heading)

		// Wander: a slowly drifting offset on a circle ahead.
		c.wander = clamp(c.wander+(rand.Float64()-0.5)*dt*3.2, -1.1, 1.1)
		dx += math.Cos(c.heading+c.wander) * 0.45
		dy += math.Sin(c.heading+c.wander) * 0.45

		// Chase.
		if t >= c.retargetAt {
			before := c.target
			c.target = w.findPrey(c)
			c.retargetAt = t + 0.45
			if c.target >= 0 && before < 0 && c.hunger > 0.3 {
				c.alertUntil = t + 0.6
			}
		}
		closing := 0.0
		c.hunting = false
		if c.target >= 0 && w.flutters[c.target].alive && c.hunger > 0.3 {
			f := &w.flutters[c.target]
			// Pursuit: aim at where the butterfly is about to be.
			tx := f.x + f.vx*0.35 - hx
			ty := f.y + f.vy*0.35 - hy
			d := math.Hypot(tx, ty)
			if d == 0 {
				d = 1
			}
			wt := 1.4 + 2.6*c.hunger
			dx += tx / d * wt
			dy += ty / d * wt
			c.hunting = true
			closing = clamp(1-d/(L*0.9), 0, 1)
		} else {
			// Patrol: a lazy circuit around the middle, squashed so a tall
			// calf stays inside a short field.
			rx := (c.x - cxW) / (W / minSide)
			ry := (c.y - cyW) / math.Max(0.3, (H-c.height)/minSide)
			r := math.Hypot(rx, ry)
			if r == 0 {
				r = 1
			}
			radius := c.orbitRadius * (1 + 0.15*math.Sin(t*0.05+float64(c.id)))
			radial := clamp((radius-r)/radius, -1, 1)
			dx += (-ry/r*c.orbitDir + rx/r*radial*0.9) * 0.55
			dy += (rx/r*c.orbitDir + ry/r*radial*0.9) * 0.55
		}

		// Give other calves room.
		for j := range w.calves {
			if j == i {
				continue
			}
			o := &w.calves[j]
			for _, p := range [3][2]float64{{o.x - o.length*0.35, o.y}, {o.x, o.y}, {o.x + o.length*0.35, o.y}} {
				ox, oy := c.x-p[0], c.y-p[1]
				d := math.Hypot(ox, oy)
				if r := (L + o.length) * 0.45; d < r && d > 1e-3 {
					wt := (1 - d/r) * 3
					dx += ox / d * wt
					dy += oy / d * wt
				}
			}
		}

		// Keep the headline mostly clear: a soft elliptical no-go zone.
		ex := (c.x - cxW) / (W * 0.3)
		ey := (c.y - cyW) / (H * 0.16)
		if e2 := ex*ex + ey*ey; e2 < 1 {
			e := math.Sqrt(e2)
			if e == 0 {
				e = 1e-3
			}
			k := 2.5
			if c.hunting {
				k = 1
			}
			wt := (1 - e) * k
			dx += ex / e * wt
			dy += ey / e * wt
		}

		// Turn back once the calf reaches the edge, so calves dip off-screen
		// now and then but never wander away for good.
		over := max(c.length/2-c.x, c.x+c.length/2-W, c.height/2-c.y, c.y+c.height/2-H)
		if over > -L*0.05 {
			wt := clamp((over+L*0.05)/(L*0.35), 0, 3) * 3.5
			toX, toY := cxW-c.x, cyW-c.y
			d := math.Hypot(toX, toY)
			if d == 0 {
				d = 1
			}
			dx += toX / d * wt
			dy += toY / d * wt
		}

		desired := math.Atan2(dy, dx)
		// No pivoting on the spot: the turning circle grows with speed.
		agility := 0.8
		if c.hunting {
			agility = 1.7 + closing
		}
		agility = math.Min(agility, c.speed/(L*0.22))
		maxTurn := agility * dt
		turned := clamp(angleDiff(c.heading, desired), -maxTurn, maxTurn)
		c.heading += turned
		c.turn += (turned/dt - c.turn) * math.Min(1, dt*3)

		cruise := 30 + L*0.04
		target := cruise
		if c.hunting {
			target = cruise * (1.45 + closing*1.5)
		}
		c.speed += (target - c.speed) * math.Min(1, dt*1.1)
		// The gait quickens with speed: a walk, then a gallop.
		c.phase += dt * (2 + c.speed/8)

		// Never more than about half a calf off the field.
		c.x = clamp(c.x+math.Cos(c.heading)*c.speed*dt, -L*0.1, W+L*0.1)
		c.y = clamp(c.y+math.Sin(c.heading)*c.speed*dt, 0, H)
		// The sprite turns round only on a clear change of direction.
		if h := math.Cos(c.heading); h > 0.25 {
			c.facing = 1
		} else if h < -0.25 {
			c.facing = -1
		}

		// Catch.
		if c.hunger > 0.15 {
			mouthR := L*0.05 + 8
			mx, my := c.mouth()
			for j := range w.flutters {
				f := &w.flutters[j]
				if !f.alive {
					continue
				}
				if (f.x-mx)*(f.x-mx)+(f.y-my)*(f.y-my) < mouthR*mouthR {
					f.alive = false
					f.respawnAt = t + between(3, 8)
					c.hunger = math.Max(0, c.hunger-0.16)
					w.events = append(w.events, event{kind: caught, x: f.x, y: f.y})
				}
			}
		}

		// A calf that has played enough lies down for a nap.
		if c.hunting {
			c.tired += dt * 0.04
		} else {
			c.tired += dt * 0.01
		}
		if c.tired >= 1 || !c.hunting && c.hunger < 0.25 && rand.Float64() < dt*0.15 {
			c.state = napping
			c.stateUntil = t + between(4, 8)
			c.tired = 0
		}
	}
}

// socialise stops two calves that meet for a high five.
func (w *world) socialise() {
	t := w.time
	idle := func(c *calf) bool { return c.state == roaming && t >= c.nextSocial }
	for i := range w.calves {
		a := &w.calves[i]
		if !idle(a) {
			continue
		}
		for j := i + 1; j < len(w.calves); j++ {
			b := &w.calves[j]
			if !idle(b) || math.Hypot(a.x-b.x, a.y-b.y) > (a.length+b.length)*0.6 {
				continue
			}
			until := t + 1.6
			a.state, b.state = highFiving, highFiving
			a.stateUntil, b.stateUntil = until, until
			if b.x > a.x {
				a.facing, b.facing = 1, -1
			} else {
				a.facing, b.facing = -1, 1
			}
			w.events = append(w.events, event{kind: sparked, x: (a.x + b.x) / 2, y: (a.y+b.y)/2 - (a.height+b.height)/4})
			break
		}
	}
}

// findPrey picks a butterfly ahead of the calf, preferring close ones in
// sparse buckets (stragglers) over ones buried in a dense flock.
func (w *world) findPrey(c *calf) int {
	rng := c.length*0.9 + 160
	hx, hy := c.mouth()
	fx, fy := math.Cos(c.heading), math.Sin(c.heading)
	best := -1
	bestScore := math.Inf(1)
	currentScore := math.Inf(1)
	for i := range w.flutters {
		f := &w.flutters[i]
		if !f.alive {
			continue
		}
		dx, dy := f.x-hx, f.y-hy
		d := math.Hypot(dx, dy)
		if d > rng || d < 1e-3 {
			continue
		}
		cos := (dx*fx + dy*fy) / d
		if cos < 0.2 {
			continue
		}
		crowd := float64(w.bucketCnt[w.bucketOf(f.x, f.y)])
		score := d * (1 + (1-cos)*0.8) * (1 + crowd*0.07)
		if score < bestScore {
			bestScore, best = score, i
		}
		if i == c.target {
			currentScore = score
		}
	}
	// Stick with the current target unless something is clearly better.
	if c.target >= 0 && currentScore < bestScore*1.3 {
		return c.target
	}
	return best
}

func (w *world) respawn() {
	t, W, H := w.time, w.width, w.height
	var due []int
	for i := range w.flutters {
		if !w.flutters[i].alive && w.flutters[i].respawnAt <= t {
			due = append(due, i)
		}
	}
	if len(due) == 0 || len(due) < 6 && t-w.lastSpawn < 9 {
		return
	}
	w.lastSpawn = t

	// A new flock flutters in from a random edge.
	side := rand.IntN(4)
	along := between(0.15, 0.85)
	x, y := along*W, along*H
	switch side {
	case 0:
		x = -20
	case 1:
		x = W + 20
	case 2:
		y = -20
	default:
		y = H + 20
	}
	inward := math.Atan2(H/2-y, W/2-x) + between(-0.5, 0.5)
	s := pickSpecies()
	sp := allSpecies[s]
	millDir := 1.0
	if rand.Float64() < 0.5 {
		millDir = -1
	}
	for _, i := range due[:min(len(due), sp.flockSize[1])] {
		f := &w.flutters[i]
		f.alive = true
		f.species = s
		f.alarm = 0
		f.turn = 0
		f.millDir = millDir
		f.x = x + between(-1, 1)*w.perception
		f.y = y + between(-1, 1)*w.perception
		f.vx = math.Cos(inward) * sp.cruise * 1.4
		f.vy = math.Sin(inward) * sp.cruise * 1.4
	}
}
