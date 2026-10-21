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
//  4. calves rasterised cell by cell with supersampled edges: coloured
//     blocks shaded by the light, dense glyphs, and shimmering accents

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
	accents       = []rgb{hex("#e0892c"), hex("#e03a32"), hex("#b44ae0"), hex("#33c8cc"), hex("#3cb54a"), hex("#3150e8"), hex("#d9c14a")}
	black         = rgb{}
	white         = rgb{255, 255, 255}
	inkLight      = hex("#0e0f13")
	inkDark       = hex("#1b1d24")
	eyeGlint      = hex("#9aa0ad")
	alertRGB      = hex("#f2c33a")
)

// Sparse glyphs on bright hide, dense glyphs in shadow, so the texture
// reinforces the shading instead of fighting it.
const (
	skinRamp   = ":;t%SX8#@"
	ridgeGlyph = "@8%"
	edgeHeavy  = ":;"
	edgeLight  = ".',`"
	markGlyph  = "#%@"
)

const (
	flagBody = iota + 1
	flagEdge
	flagRidge
	flagEye
	// flagMark is dark detail: brows, hooves, the tail tuft and spots.
	flagMark
)

// Sub-cell sample offsets for anti-aliased silhouettes.
var subsamples = [][2]float64{{0.25, 0.3}, {0.75, 0.3}, {0.25, 0.72}, {0.75, 0.72}}

type renderer struct {
	cols, rows int

	energy, energyTmp, heat []float64

	calfFlag  []uint8
	calfShade []float64
	calfColor []rgb
	calfKey   []uint32
	calfDepth []float64

	// flutterStamp marks cells holding a butterfly this frame; wake skips them.
	flutterStamp []uint32
	flutterLevel []uint8
	flutterWing  []bool
	frame        uint32

	glyph []byte
	fg    []rgb
	bg    []rgb
}

func (r *renderer) resize(cols, rows int) {
	r.cols, r.rows = cols, rows
	n := cols * rows
	r.energy = make([]float64, n)
	r.energyTmp = make([]float64, n)
	r.heat = make([]float64, n)
	r.calfFlag = make([]uint8, n)
	r.calfShade = make([]float64, n)
	r.calfColor = make([]rgb, n)
	r.calfKey = make([]uint32, n)
	r.calfDepth = make([]float64, n)
	r.flutterStamp = make([]uint32, n)
	r.flutterLevel = make([]uint8, n)
	r.flutterWing = make([]bool, n)
	r.glyph = make([]byte, n)
	r.fg = make([]rgb, n)
	r.bg = make([]rgb, n)
}

// render advances the fields by dt and draws the world, with title lines
// centred over it.
func (r *renderer) render(w *world, dt float64, title []string) string {
	if r.cols == 0 || r.rows == 0 {
		return ""
	}
	t := w.time
	r.consumeEvents(w)
	r.rasterizeCalves(w.calves, t)
	r.depositWake(w, dt)
	r.diffuse(dt)

	for i := range r.glyph {
		r.glyph[i], r.fg[i], r.bg[i] = ' ', black, black
	}
	r.markFlutters(w)
	r.drawWake()
	r.drawHeat()
	r.drawFlutters()
	r.drawCalves(t)
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

// rasterizeCalves supersamples every cell in each calf's box against its
// sprite. Fully covered cells become solid hide; partial cells become edge
// glyphs.
func (r *renderer) rasterizeCalves(calves []calf, t float64) {
	for i := range r.calfFlag {
		r.calfFlag[i] = 0
	}
	for ci := range calves {
		c := &calves[ci]
		sprite := sprites[gait(c)]
		hide := coatFor(c.coat)
		px := c.length / spriteW
		py := c.height / spriteH
		left := c.x - c.length/2
		top := c.y - c.height/2
		if c.state == roaming && c.speed > 4 {
			// A little bob in the step.
			top -= math.Abs(math.Sin(c.phase)) * py * 0.4
		}
		// sample returns the sprite pixel under a point, or 0 off the calf.
		sample := func(x, y float64) (byte, int, int) {
			sx := (x - left) / px
			sy := (y - top) / py
			if sx < 0 || sy < 0 || sx >= spriteW || sy >= spriteH {
				return 0, 0, 0
			}
			if c.facing < 0 {
				sx = spriteW - sx
			}
			ix, iy := min(int(sx), spriteW-1), int(sy)
			code := sprite[iy][ix]
			if code == '.' {
				return 0, ix, iy
			}
			return code, ix, iy
		}
		c0 := max(0, int(math.Floor(left/cellW)))
		c1 := min(r.cols-1, int(math.Floor((left+c.length)/cellW)))
		r0 := max(0, int(math.Floor(top/cellH)))
		r1 := min(r.rows-1, int(math.Floor((top+c.height)/cellH)))
		dim := 0.7 + 0.3*c.depth
		headTop := spriteTop(sprite)
		for row := r0; row <= r1; row++ {
			for col := c0; col <= c1; col++ {
				x, y := float64(col*cellW), float64(row*cellH)
				code, ix, iy := sample(x+cellW/2, y+cellH/2)
				centre := code != 0
				hits := 0
				if centre {
					hits = 1
				}
				// Eyes and brows win any sample they touch, so the face
				// survives at small sizes.
				for _, s := range subsamples {
					sc, sx, sy := sample(x+s[0]*cellW, y+s[1]*cellH)
					if sc == 0 {
						continue
					}
					hits++
					if priority(sc) > priority(code) {
						code, ix, iy = sc, sx, sy
					}
				}
				if hits == 0 {
					continue
				}
				coverage := float64(hits) / 5
				i := row*r.cols + col
				// Body-anchored key, so each glyph rides along with the hide.
				r.calfKey[i] = uint32(hash3(ix, iy, c.id) * 4294967295)
				r.calfDepth[i] = dim
				colour := hide.colour(code)
				flag, shade := shading(code, iy)
				if hide.blaze && (code == '#' || code == 't') && ix >= 14 && ix <= 16 && iy <= headTop+4 {
					colour = pale
				}
				if hide.spotted && (code == '#' || code == 't') && spot(ix, iy, c.id) {
					flag, colour = flagMark, hide.spots
				}
				r.calfColor[i] = colour
				if priority(code) > 1 || centre && hits >= 3 {
					r.calfFlag[i] = uint8(flag)
					flicker := (hash3(col, row, int(t*6)) - 0.5) * 0.06
					r.calfShade[i] = clamp(shade+flicker, 0, 1)
				} else {
					r.calfFlag[i] = flagEdge
					r.calfShade[i] = coverage
				}
			}
		}
	}
}

// spriteTop is the first row of the head, which moves down when lying.
func spriteTop(sprite []string) int {
	for y, row := range sprite {
		if strings.Contains(row, "t") {
			return y
		}
	}
	return 0
}

func priority(code byte) int {
	switch code {
	case 'k', 'z':
		return 3
	case 'b':
		return 2
	case 0:
		return 0
	}
	return 1
}

// spot reports whether a hide pixel falls on a patch, on a jittered grid so
// the patches ride along with the calf.
func spot(x, y, id int) bool {
	gx, gy := float64(x)/4, float64(y)/3
	cx, cy := math.Floor(gx), math.Floor(gy)
	jx := hash3(int(cx), int(cy), id)*0.5 + 0.25
	jy := hash3(int(cx), int(cy), id+11)*0.5 + 0.25
	return (gx-cx-jx)*(gx-cx-jx)+(gy-cy-jy)*(gy-cy-jy) < 0.09
}

// shading lights the calf from above: the back catches the light and the
// belly falls into shadow.
func shading(code byte, y int) (int, float64) {
	shade := 0.72 - 0.42*float64(y)/spriteH
	switch code {
	case 'k', 'z':
		return flagEye, 0
	case 'b', 'h', 'K':
		return flagMark, 0.2
	case 't':
		return flagRidge, 0.95
	case 'm', 'c', 'p', 'n':
		return flagBody, math.Max(shade, 0.66)
	case 'l', 'u':
		return flagBody, shade * 0.85
	}
	return flagBody, shade
}

func (r *renderer) drawCalves(t float64) {
	for i, flag := range r.calfFlag {
		if flag == 0 {
			continue
		}
		key := r.calfKey[i]
		shade := r.calfShade[i]
		dim := r.calfDepth[i]
		colour := r.calfColor[i]
		// Colours re-roll on a staggered clock so the hide shimmers.
		tick := int(t*2.4 + float64(key%997)/97)
		roll := hash3(int(key), tick, 7)

		if flag == flagEdge {
			// Soft, anti-aliased silhouette: no block, just a light glyph.
			set := edgeLight
			if shade >= 0.5 {
				set = edgeHeavy
			}
			r.glyph[i] = set[(key>>8)%uint32(len(set))]
			r.fg[i] = colour.scale((0.35 + 0.45*shade) * dim)
			if roll < 0.07 {
				r.fg[i] = accents[key%uint32(len(accents))]
			}
			continue
		}

		var glyph byte
		level := 0.45 + 0.55*shade
		switch flag {
		case flagRidge:
			glyph = ridgeGlyph[(key>>8)%uint32(len(ridgeGlyph))]
		case flagEye:
			level, glyph = 0.08, 'o'
		case flagMark:
			level = 0.55 + shade*0.3
			glyph = markGlyph[(key>>8)%uint32(len(markGlyph))]
		default:
			jitter := int((key>>4)%3) - 1
			glyph = skinRamp[int(clamp(math.Floor((1-shade)*8.99)+float64(jitter), 0, float64(len(skinRamp)-1)))]
		}
		block := colour.scale(level * dim)
		if flag == flagEye {
			block = colour.scale(0.5)
		}
		r.bg[i] = block
		r.glyph[i] = glyph
		switch {
		case flag == flagEye && colour == face['z']:
			r.glyph[i], r.fg[i] = '-', eyeGlint
		case flag == flagEye:
			r.fg[i] = eyeGlint
		case flag == flagMark:
			r.fg[i] = block.scale(1.6)
		case roll < 0.09:
			r.fg[i] = accents[key%uint32(len(accents))]
		case roll < 0.13:
			r.fg[i] = white
		case luminance(block) < 0.22:
			// Dark ink disappears on a dark hide.
			r.fg[i] = block.scale(2)
		case shade > 0.55:
			r.fg[i] = inkLight
		default:
			r.fg[i] = inkDark
		}
	}
}

func luminance(c rgb) float64 { return (c.r*0.3 + c.g*0.59 + c.b*0.11) / 255 }

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
				glyph := byte('z')
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

func (r *renderer) put(x, y float64, glyph byte, fg rgb) {
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
			if c < 0 || r.flutterStamp[c] == r.frame || r.calfFlag[c] != 0 {
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
		if e <= 0.45 || r.calfFlag[i] != 0 {
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
		start := (r.cols - len(line)) / 2
		for j := range len(line) {
			col := start + j
			if col < 0 || col >= r.cols || line[j] == ' ' {
				continue
			}
			i := row*r.cols + col
			r.glyph[i], r.bg[i] = line[j], black
			r.fg[i] = white
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
			b.WriteByte(r.glyph[i])
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
