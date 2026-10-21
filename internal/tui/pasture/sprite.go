package pasture

import (
	"math"
	"strings"
)

// The calf is pixel art in the Mob logo's blocky style: a side-on body with
// the logo's face turned to the viewer, facing right. Legs change per pose.
//
// t top of the hide, # hide, u belly, l leg, h hoof, K tail tuft,
// p inner ear, b brow, k eye, m muzzle, n nostril, c chin, z closed eye.
const (
	spriteW = 21
	spriteH = 12
)

var calfHead = []string{
	"...ttttt...",
	"p.#######.p",
	"pp#######pp",
	".#bb###bb#.",
	".#k#####k#.",
	".#mmmmmmm#.",
	".mnmmmmmnm.",
	"..mmmmmmm..",
	"...ccccc...",
}

var calfBody = []string{
	".ttttttttttt",
	"K#########tt",
	"K##########t",
	"..#########.",
	"..#########.",
	"..uuuuuuuuu.",
}

// Leg columns per pose; each leg is two rows of shin and a hoof.
type legs [4][3]int

type pose int

const (
	standing pose = iota
	strideA
	strideB
	lying
	hopping
)

var poseLegs = map[pose]legs{
	standing: {{3, 3, 3}, {6, 6, 6}, {11, 11, 11}, {14, 14, 14}},
	strideA:  {{3, 2, 2}, {6, 7, 7}, {11, 10, 10}, {14, 15, 15}},
	strideB:  {{4, 4, 5}, {5, 5, 4}, {12, 12, 13}, {13, 13, 12}},
}

// sprites holds every pose as a spriteH × spriteW grid of pixel codes.
var sprites = func() map[pose][]string {
	out := map[pose][]string{}
	for _, p := range []pose{standing, strideA, strideB, lying, hopping} {
		grid := make([][]byte, spriteH)
		for y := range grid {
			grid[y] = []byte(strings.Repeat(".", spriteW))
		}
		put := func(x, y int, c byte) {
			if x >= 0 && y >= 0 && x < spriteW && y < spriteH && c != '.' {
				grid[y][x] = c
			}
		}
		bodyTop, headTop := 3, 0
		switch p {
		case lying:
			// Legs folded under, head resting low.
			bodyTop, headTop = 6, 3
		case hopping:
			bodyTop, headTop = 2, 0
		}
		for y, row := range calfBody {
			for x := range len(row) {
				put(x+1, bodyTop+y, row[x])
			}
		}
		switch p {
		case lying:
			for _, x := range []int{3, 6, 12, 15} {
				put(x, spriteH-1, 'h')
			}
		case hopping:
			// Tucked legs mid-hop.
			for _, x := range []int{3, 6, 11, 14} {
				put(x, bodyTop+6, 'l')
				put(x, bodyTop+7, 'h')
			}
		default:
			for _, leg := range poseLegs[p] {
				put(leg[0], 9, 'l')
				put(leg[1], 10, 'l')
				put(leg[2], 11, 'h')
			}
		}
		for y, row := range calfHead {
			for x := range len(row) {
				c := row[x]
				if p == lying && c == 'k' {
					c = 'z'
				}
				put(x+10, headTop+y, c)
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
	mobOrange = coat{body: hex("#f2852b"), top: hex("#ffa04a"), belly: hex("#f7d2ad")}
	coats     = []string{"#f1f0ea", "#2b2826", "#d08a4e", "#a8683d", "#8d929a", "#d9c39b", "#5ab4f0", "#b9a8ff", "#9bd86a", "#f2a7b8", "#6b4a35"}
	face      = map[byte]rgb{'p': hex("#f6b39a"), 'b': hex("#3b2214"), 'k': hex("#2b170c"), 'z': hex("#3b2214"), 'm': hex("#f7d2ad"), 'n': hex("#c8835f"), 'c': hex("#f4dfc4"), 'h': hex("#3b2214"), 'K': hex("#2b170c")}
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
	c := coat{body: body, top: body.scale(1.12), belly: body.scale(0.85)}
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

// colour is the pixel's colour, before lighting.
func (c coat) colour(code byte) rgb {
	switch code {
	case 't':
		return c.top
	case 'u':
		return c.belly
	case 'l':
		return c.body.scale(0.78)
	case '#':
		return c.body
	}
	if v, ok := face[code]; ok {
		return v
	}
	return c.body
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
