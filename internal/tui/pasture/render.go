package pasture

import (
	"math"
	"strconv"
	"strings"
)

// The renderer draws the world as a grid of terminal cells:
//  1. a pure black field
//  2. a wake field that diffuses where things move, lighting cells cyan
//  3. butterflies as minimal glyphs, one per cell, glinting on hard turns
//  4. calves as blocky pixel art in half blocks, two pixels to a cell

// Cell size in pixels. The sim runs in pixels; a terminal cell is about
// twice as tall as it is wide.
const (
	cellW = 8
	cellH = 16
)

const alphaLevels = 6

var (
	flutterAlphas = []float64{0.28, 0.42, 0.58, 0.74, 0.9}
	flutterRGB    = rgb{230, 238, 255}
	wakeRGB       = rgb{110, 230, 255}
	black         = rgb{}
	white         = rgb{255, 255, 255}
	alertRGB      = hex("#f2c33a")
)

type renderer struct {
	cols, rows int

	energy, energyTmp, heat []float64

	// calfMask says which halves of a cell hold calf pixels: 1 top, 2 bottom.
	calfMask   []uint8
	calfTop    []rgb
	calfBottom []rgb

	// flutterStamp marks cells holding a butterfly this frame; wake skips them.
	flutterStamp []uint32
	flutterLevel []uint8
	flutterWing  []bool
	frame        uint32

	glyph []rune
	fg    []rgb
	bg    []rgb
}

func (r *renderer) resize(cols, rows int) {
	r.cols, r.rows = cols, rows
	n := cols * rows
	r.energy = make([]float64, n)
	r.energyTmp = make([]float64, n)
	r.heat = make([]float64, n)
	r.calfMask = make([]uint8, n)
	r.calfTop = make([]rgb, n)
	r.calfBottom = make([]rgb, n)
	r.flutterStamp = make([]uint32, n)
	r.flutterLevel = make([]uint8, n)
	r.flutterWing = make([]bool, n)
	r.glyph = make([]rune, n)
	r.fg = make([]rgb, n)
	r.bg = make([]rgb, n)
}

// render advances the fields by dt and draws the world, with title lines
// centred over it.
func (r *renderer) render(w *world, dt float64, title []string) string {
	if r.cols == 0 || r.rows == 0 {
		return ""
	}
	r.consumeEvents(w)
	r.rasterizeCalves(w.calves)
	r.depositWake(w, dt)
	r.diffuse(dt)

	for i := range r.glyph {
		r.glyph[i], r.fg[i], r.bg[i] = ' ', black, black
	}
	r.markFlutters(w)
	r.drawWake()
	r.drawHeat()
	r.drawFlutters()
	r.drawCalves()
	r.drawOverlays(w)
	r.drawTitle(title)
	return r.compose()
}

func (r *renderer) cellIndex(x, y float64) int {
	c := int(math.Floor(x / cellW))
	row := int(math.Floor(y / cellH))
	if c < 0 || row < 0 || c >= r.cols || row >= r.rows {
		return -1
	}
	return row*r.cols + c
}

func (r *renderer) stamp(field []float64, x, y float64, radius int, amount float64) {
	c0 := int(math.Floor(x / cellW))
	r0 := int(math.Floor(y / cellH))
	for row := r0 - radius; row <= r0+radius; row++ {
		for c := c0 - radius; c <= c0+radius; c++ {
			if c < 0 || row < 0 || c >= r.cols || row >= r.rows {
				continue
			}
			d := math.Hypot(float64(c-c0), float64(row-r0)*1.4)
			if d > float64(radius)+0.5 {
				continue
			}
			i := row*r.cols + c
			field[i] = math.Min(1.6, field[i]+amount*(1-d/float64(radius+1)))
		}
	}
}

func (r *renderer) consumeEvents(w *world) {
	for _, e := range w.events {
		switch e.kind {
		case caught:
			r.stamp(r.heat, e.x, e.y, 2, 1)
			r.stamp(r.energy, e.x, e.y, 3, 0.9)
		case sparked:
			r.stamp(r.heat, e.x, e.y, 2, 1.4)
			r.stamp(r.energy, e.x, e.y, 4, 1.2)
		default:
			r.stamp(r.energy, e.x, e.y, 6, 1.4)
		}
	}
	w.events = w.events[:0]
}

func (r *renderer) depositWake(w *world, dt float64) {
	// Deposits are tuned per 60 Hz frame.
	frames := dt * 60
	for i := range w.flutters {
		f := &w.flutters[i]
		if !f.alive {
			continue
		}
		if c := r.cellIndex(f.x, f.y); c >= 0 {
			r.energy[c] = math.Min(1.6, r.energy[c]+(0.012+f.alarm*0.03)*frames)
		}
	}
	for i := range w.calves {
		c := &w.calves[i]
		// The hooves stir up the grass.
		feet := c.y + c.height*0.45
		for k := range 6 {
			x := c.x + (float64(k)/5-0.5)*c.length*0.7
			if j := r.cellIndex(x, feet); j >= 0 {
				r.energy[j] = math.Min(1.6, r.energy[j]+(0.03+c.speed*0.0012)*frames)
			}
		}
	}
	if w.pointer.active {
		r.stamp(r.energy, w.pointer.x, w.pointer.y, 1, 0.08)
	}
}

// diffuse blurs and decays the fields so wakes spread like ripples and fade.
func (r *renderer) diffuse(dt float64) {
	cols, rows, e, tmp := r.cols, r.rows, r.energy, r.energyTmp
	decay := math.Exp(-dt * 1.5)
	for row := range rows {
		for c := range cols {
			i := row*cols + c
			l, rt, u, d := e[i], e[i], e[i], e[i]
			if c > 0 {
				l = e[i-1]
			}
			if c < cols-1 {
				rt = e[i+1]
			}
			if row > 0 {
				u = e[i-cols]
			}
			if row < rows-1 {
				d = e[i+cols]
			}
			tmp[i] = (e[i]*4 + l + rt + u + d) * 0.125 * decay
		}
	}
	r.energy, r.energyTmp = tmp, e
	heatDecay := math.Exp(-dt * 2.2)
	for i := range r.heat {
		r.heat[i] *= heatDecay
	}
}

// ── calves ─────────────────────────────────────────────────────────────

// rasterizeCalves paints each calf's sprite pixel for pixel into the half
// cells it covers, farther calves first.
func (r *renderer) rasterizeCalves(calves []calf) {
	for i := range r.calfMask {
		r.calfMask[i] = 0
	}
	for ci := range calves {
		c := &calves[ci]
		sprite := sprites[gait(c)]
		hide := coatFor(c.coat)
		dim := 0.72 + 0.28*c.depth
		col0 := int(math.Round((c.x - c.length/2) / cellW))
		half0 := int(math.Round((c.y - c.height/2) / (cellH / 2)))
		for sy, row := range sprite {
			half := half0 + sy
			cellRow := half >> 1
			if half < 0 || cellRow >= r.rows {
				continue
			}
			for sx := range len(row) {
				x := sx
				if c.facing < 0 {
					x = spriteW - 1 - sx
				}
				colour, ok := hide.colour(row[x], x, sy, c.id)
				col := col0 + sx
				if !ok || col < 0 || col >= r.cols {
					continue
				}
				i := cellRow*r.cols + col
				if half&1 == 0 {
					r.calfTop[i] = colour.scale(dim)
					r.calfMask[i] |= 1
				} else {
					r.calfBottom[i] = colour.scale(dim)
					r.calfMask[i] |= 2
				}
			}
		}
	}
}

// drawCalves turns pairs of pixels into half-block cells.
func (r *renderer) drawCalves() {
	for i, mask := range r.calfMask {
		switch mask {
		case 1:
			r.glyph[i], r.fg[i], r.bg[i] = '▀', r.calfTop[i], black
		case 2:
			r.glyph[i], r.fg[i], r.bg[i] = '▄', r.calfBottom[i], black
		case 3:
			r.glyph[i], r.fg[i], r.bg[i] = '▀', r.calfTop[i], r.calfBottom[i]
		}
	}
}

// drawOverlays floats a calf's mood over its head: Zs over a sleeper and a
// "!" when it spots a butterfly or is startled.
func (r *renderer) drawOverlays(w *world) {
	for ci := range w.calves {
		c := &w.calves[ci]
		headX := c.x + c.facing*c.length*0.24
		top := c.y - c.height/2
		switch {
		case c.state == napping:
			for k := range 3 {
				age := math.Mod(w.time*0.45+float64(k)/3, 1)
				glyph := 'z'
				if age > 0.5 {
					glyph = 'Z'
				}
				x := headX + c.facing*age*cellW*4
				y := top + c.height*0.25 - age*cellH*3
				r.put(x, y, glyph, white.scale(1-age*0.8))
			}
		case w.time < c.alertUntil:
			r.put(headX, top-cellH*0.5, '!', alertRGB)
		}
	}
}

func (r *renderer) put(x, y float64, glyph rune, fg rgb) {
	if i := r.cellIndex(x, y); i >= 0 {
		r.glyph[i], r.fg[i] = glyph, fg
	}
}

// ── butterflies, wake, heat ────────────────────────────────────────────

// markFlutters snaps each butterfly to a cell and buckets it by brightness:
// far ones are dim, near ones brighter, and turning or panicking ones glint.
// Nearer butterflies claim a cell first.
func (r *renderer) markFlutters(w *world) {
	r.frame++
	for pass := range 2 {
		for i := range w.flutters {
			f := &w.flutters[i]
			near := 1
			if f.depth > 0.78 {
				near = 0
			}
			if !f.alive || near != pass {
				continue
			}
			c := r.cellIndex(f.x, f.y)
			if c < 0 || r.flutterStamp[c] == r.frame || r.calfMask[c] != 0 {
				continue
			}
			r.flutterStamp[c] = r.frame
			glint := clamp(math.Abs(f.turn)/3.5, 0, 1)
			v := 0.3 + 0.4*(f.depth-0.55)/0.45 + 0.3*math.Max(glint, f.alarm)
			r.flutterLevel[c] = uint8(clamp(math.Floor(v*float64(len(flutterAlphas))), 0, float64(len(flutterAlphas)-1)))
			r.flutterWing[c] = math.Sin(f.phase) > 0
		}
	}
}

func (r *renderer) drawFlutters() {
	for i, s := range r.flutterStamp {
		if s != r.frame {
			continue
		}
		// Wings up, wings level.
		r.glyph[i] = '-'
		if r.flutterWing[i] {
			r.glyph[i] = 'v'
		}
		r.fg[i] = flutterRGB.scale(flutterAlphas[r.flutterLevel[i]])
	}
}

func (r *renderer) drawHeat() {
	for i, h := range r.heat {
		if h < 0.08 {
			continue
		}
		r.glyph[i] = '.'
		if h > 0.6 {
			r.glyph[i] = '*'
		}
		if h > 0.5 {
			r.fg[i] = rgb{255, 120, 60}.scale(math.Min(1, h))
		} else {
			r.fg[i] = rgb{220, 40, 40}.scale(math.Min(1, h*1.6))
		}
	}
}

// drawWake lights cells cyan where the wake field is strong.
func (r *renderer) drawWake() {
	for i, e := range r.energy {
		if e <= 0.45 || r.calfMask[i] != 0 {
			continue
		}
		level := clamp(math.Floor((e-0.45)*5), 0, alphaLevels-1)
		r.glyph[i] = '.'
		r.fg[i] = wakeRGB.scale((level + 1) / alphaLevels)
	}
}

func (r *renderer) drawTitle(lines []string) {
	top := r.rows/2 - len(lines)/2
	for k, line := range lines {
		row := top + k
		if row < 0 || row >= r.rows {
			continue
		}
		text := []rune(line)
		start := (r.cols - len(text)) / 2
		// Clear a cell either side so nothing runs into the words.
		for j := -1; j <= len(text); j++ {
			col := start + j
			if col < 0 || col >= r.cols {
				continue
			}
			i := row*r.cols + col
			r.glyph[i], r.bg[i] = ' ', black
			if j < 0 || j == len(text) {
				continue
			}
			r.glyph[i], r.fg[i] = text[j], white
			if k > 0 {
				r.fg[i] = white.scale(0.55)
			}
		}
	}
}

// compose writes the cells as truecolor ANSI, changing colour only when it
// differs from the cell before.
func (r *renderer) compose() string {
	var b strings.Builder
	b.Grow(r.cols * r.rows * 8)
	for row := range r.rows {
		var lastFg, lastBg rgb
		freshFg, freshBg := true, true
		for col := range r.cols {
			i := row*r.cols + col
			fg, bg := r.fg[i], r.bg[i]
			if freshBg || bg != lastBg {
				sgr(&b, 48, bg)
				lastBg, freshBg = bg, false
			}
			if r.glyph[i] != ' ' && (freshFg || fg != lastFg) {
				sgr(&b, 38, fg)
				lastFg, freshFg = fg, false
			}
			b.WriteRune(r.glyph[i])
		}
		b.WriteString("\x1b[0m")
		if row < r.rows-1 {
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func sgr(b *strings.Builder, kind int, c rgb) {
	b.WriteString("\x1b[")
	b.WriteString(strconv.Itoa(kind))
	b.WriteString(";2;")
	b.WriteString(strconv.Itoa(channel(c.r)))
	b.WriteByte(';')
	b.WriteString(strconv.Itoa(channel(c.g)))
	b.WriteByte(';')
	b.WriteString(strconv.Itoa(channel(c.b)))
	b.WriteByte('m')
}

func channel(v float64) int { return int(clamp(math.Round(v), 0, 255)) }
