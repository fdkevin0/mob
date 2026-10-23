package pasture

import "math"

// The calf is pixel art in the Mob logo's blocky style: a side-on body with
// the logo's face turned to the viewer, facing right. It is drawn with half
// blocks, so a pixel is one cell wide and half a cell tall, which is square.
//
// t top of the hide, # hide, s shaded hide, u belly, l leg, h hoof,
// K tail tuft, p inner ear, b brow, w eye white, k pupil, m muzzle,
// M shaded muzzle, n nostril, c chin.
const (
	spriteW = 24
	spriteH = 16
)

var calfHead = []string{
	"....tttt....",
	"..tttttttt..",
	"#p########p#",
	".#p######p#.",
	"..########..",
	"..#bb##bb#..",
	"..#wk##wk#..",
	"..########..",
	".#mmmmmmmm#.",
	".#MnmmmmnM#.",
	".#mmmmmmmm#.",
	"..#McccccM..",
	"...ssssss...",
}

var calfBody = []string{
	".tttttttttttt.",
	"t############t",
	"##############",
	"##############",
	"##############",
	"##############",
	"s############s",
	".uuuuuuuuuuuu.",
}

type pose int

const (
	standing pose = iota
	strideA
	strideB
	lying
	hopping
)

// legX are the left columns of the four legs, back to front; each leg is
// two pixels wide.
var legX = [4]int{3, 6, 11, 14}

// sprites holds every pose as a spriteH × spriteW grid of pixel codes.
var sprites = func() map[pose][]string {
	out := map[pose][]string{}
	for _, p := range []pose{standing, strideA, strideB, lying, hopping} {
		grid := make([][]byte, spriteH)
		for y := range grid {
			grid[y] = make([]byte, spriteW)
			for x := range grid[y] {
				grid[y][x] = '.'
			}
		}
		put := func(x, y int, c byte) {
			if x >= 0 && y >= 0 && x < spriteW && y < spriteH && c != '.' {
				grid[y][x] = c
			}
		}
		// Body and head top rows; lying sinks both, a hop lifts them.
		bodyTop, headTop := 4, 0
		switch p {
		case lying:
			bodyTop, headTop = 8, 3
		case hopping:
			bodyTop, headTop = 3, 0
		}
		legTop := bodyTop + len(calfBody)
		switch p {
		case lying:
			// Legs folded under: only the hooves peek out.
			for _, x := range legX {
				put(x, spriteH-1, 'h')
				put(x+1, spriteH-1, 'h')
			}
		case hopping:
			for _, x := range legX {
				put(x, legTop, 'l')
				put(x+1, legTop, 'l')
				put(x, legTop+1, 'h')
				put(x+1, legTop+1, 'h')
			}
		default:
			for k, x := range legX {
				// A stride swings diagonal pairs forward and back and lifts
				// the swinging hoof.
				shift, lift := 0, 0
				if p != standing {
					forward := k == 0 || k == 3
					if p == strideB {
						forward = !forward
					}
					if forward {
						shift, lift = 1, 1
					} else {
						shift = -1
					}
				}
				for y := legTop; y < spriteH-1-lift; y++ {
					dx := 0
					if y >= legTop+2 {
						dx = shift
					}
					put(x+dx, y, 'l')
					put(x+dx+1, y, 'l')
				}
				put(x+shift, spriteH-1-lift, 'h')
				put(x+shift+1, spriteH-1-lift, 'h')
			}
		}
		for y, row := range calfBody {
			for x := range len(row) {
				put(x+2, bodyTop+y, row[x])
			}
		}
		// The tail hangs off the rump and swings with the stride.
		tail := 0
		if p == strideA {
			tail = -1
		}
		put(1, bodyTop+1, 's')
		put(0+max(0, -tail), bodyTop+2, 's')
		put(0, bodyTop+3, 's')
		put(0+tail+1, bodyTop+4, 'K')
		put(0+tail+1, bodyTop+5, 'K')
		for y, row := range calfHead {
			for x := range len(row) {
				c := row[x]
				if p == lying && (c == 'w' || c == 'k') {
					// Eyes shut: only the brows stay.
					c = '#'
				}
				put(x+12, headTop+y, c)
			}
		}
		rows := make([]string, spriteH)
		for y := range grid {
			rows[y] = string(grid[y])
		}
		out[p] = rows
	}
	return out
}()

type rgb struct{ r, g, b float64 }

func hex(s string) rgb {
	var v [3]float64
	for i := range 3 {
		var n int
		for _, ch := range s[1+i*2 : 3+i*2] {
			n <<= 4
			switch {
			case ch >= '0' && ch <= '9':
				n += int(ch - '0')
			case ch >= 'a' && ch <= 'f':
				n += int(ch-'a') + 10
			}
		}
		v[i] = float64(n)
	}
	return rgb{v[0], v[1], v[2]}
}

func (c rgb) scale(k float64) rgb { return rgb{c.r * k, c.g * k, c.b * k} }

func (c rgb) light() bool { return (c.r*0.3+c.g*0.59+c.b*0.11)/255 > 0.55 }

// coat is a calf's hide: the landing page's seeded skins, with the logo's
// orange for coat 0.
type coat struct {
	body, top, belly, spots rgb
	blaze, spotted          bool
}

var (
	mobOrange = coat{body: hex("#f2852b"), top: hex("#ffa04a"), belly: hex("#e0742a")}
	coats     = []string{"#f1f0ea", "#2b2826", "#d08a4e", "#a8683d", "#8d929a", "#d9c39b", "#5ab4f0", "#b9a8ff", "#9bd86a", "#f2a7b8", "#6b4a35"}
	face      = map[byte]rgb{'p': hex("#f6b39a"), 'b': hex("#3b2214"), 'w': hex("#f6efe4"), 'k': hex("#2b170c"), 'm': hex("#f7d2ad"), 'M': hex("#e4b086"), 'n': hex("#c8835f"), 'c': hex("#f4dfc4"), 'h': hex("#3b2214"), 'K': hex("#3b2214")}
	pale      = hex("#f1ece2")
	dark      = hex("#2b2826")
)

func coatFor(seed int) coat {
	if seed == 0 {
		return mobOrange
	}
	a := uint32(seed) * 2654435761
	next := func() float64 {
		a ^= a << 13
		a ^= a >> 17
		a ^= a << 5
		return float64(a) / 4294967296
	}
	body := hex(coats[int(next()*float64(len(coats)))])
	var mark rgb
	if body.light() {
		mark = body.scale(0.62)
		if next() < 0.5 {
			mark = dark
		}
	} else {
		mark = body.scale(1.35)
		if next() < 0.6 {
			mark = pale
		}
	}
	c := coat{body: body, top: lift(body), belly: body.scale(0.85)}
	switch kind := next(); {
	case kind < 0.45:
		c.spotted, c.spots = true, mark
	case kind < 0.65:
		c.blaze = true
	case kind < 0.85:
		c.belly = pale
		if body.light() {
			c.belly = body.scale(0.8)
		}
	}
	return c
}

// lift brightens a colour toward white for the sunlit back.
func lift(c rgb) rgb {
	return rgb{c.r + (255-c.r)*0.25, c.g + (255-c.g)*0.25, c.b + (255-c.b)*0.25}
}

// colour is the pixel's colour, or false for an empty pixel. x and y are
// sprite coordinates, which spots and the blaze are anchored to.
func (c coat) colour(code byte, x, y, id int) (rgb, bool) {
	switch code {
	case '.':
		return rgb{}, false
	case 't':
		return c.top, true
	case 'u':
		return c.belly, true
	case 's':
		return c.body.scale(0.8), true
	case 'l':
		return c.body.scale(0.72), true
	case '#':
		if c.blaze && x >= 17 && x <= 18 {
			return pale, true
		}
		if c.spotted && x < 13 && spot(x, y, id) {
			return c.spots, true
		}
		return c.body, true
	}
	if v, ok := face[code]; ok {
		return v, true
	}
	return c.body, true
}

// spot reports whether a hide pixel falls on a patch.
func spot(x, y, id int) bool {
	gx, gy := float64(x)/5, float64(y)/4
	cx, cy := math.Floor(gx), math.Floor(gy)
	jx := hash3(int(cx), int(cy), id)*0.5 + 0.25
	jy := hash3(int(cx), int(cy), id+11)*0.5 + 0.25
	return (gx-cx-jx)*(gx-cx-jx)+(gy-cy-jy)*(gy-cy-jy) < 0.1
}

// gait picks the pose for a calf from what it is doing.
func gait(c *calf) pose {
	switch c.state {
	case napping:
		return lying
	case highFiving:
		if math.Sin(c.phase*4) > 0 {
			return hopping
		}
		return standing
	}
	if c.speed < 4 {
		return standing
	}
	if math.Sin(c.phase) > 0 {
		return strideA
	}
	return strideB
}
