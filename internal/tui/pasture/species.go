package pasture

import "math/rand/v2"

// species is one kind of butterfly. Different mixes of the behaviour weights
// give different flock shapes (Couzin et al. 2002): strong alignment gives
// polarised flocks and ribbons, low alignment gives swarms, and a tangential
// pull makes the flock circle on the spot.
type species struct {
	name                       string
	cruise, maxSpeed, minSpeed float64
	// weight is the relative odds of a new flock being this species.
	weight    float64
	flockSize [2]int
	// spacing is personal space in grid cells (x, y), so every butterfly
	// gets its own glyph.
	spacing         [2]float64
	align, cohesion float64
	jitter          float64
	mill            float64
	// verticalDrag damps vertical speed; butterflies mostly drift level.
	verticalDrag float64
}

var allSpecies = []species{
	{name: "cabbage white", cruise: 36, maxSpeed: 64, minSpeed: 18, weight: 3, flockSize: [2]int{18, 28}, spacing: [2]float64{1.8, 1.1}, align: 1.6, cohesion: 1.6, jitter: 40, mill: 70, verticalDrag: 0.5},
	{name: "sulphur", cruise: 46, maxSpeed: 78, minSpeed: 22, weight: 3, flockSize: [2]int{20, 32}, spacing: [2]float64{1.5, 1}, align: 3.2, cohesion: 0.45, jitter: 30, verticalDrag: 1.4},
	{name: "common blue", cruise: 40, maxSpeed: 70, minSpeed: 20, weight: 3, flockSize: [2]int{12, 20}, spacing: [2]float64{2, 1.1}, align: 2.4, cohesion: 1.1, jitter: 35, verticalDrag: 1.6},
	{name: "monarch", cruise: 32, maxSpeed: 60, minSpeed: 16, weight: 2, flockSize: [2]int{5, 9}, spacing: [2]float64{2.6, 1.3}, align: 2, cohesion: 0.9, jitter: 25, verticalDrag: 2},
	{name: "midge", cruise: 26, maxSpeed: 56, minSpeed: 10, weight: 1, flockSize: [2]int{8, 12}, spacing: [2]float64{1.4, 1.1}, align: 0.35, cohesion: 1.4, jitter: 110, verticalDrag: 0.3},
}

func pickSpecies() int {
	total := 0.0
	for _, s := range allSpecies {
		total += s.weight
	}
	r := rand.Float64() * total
	for i, s := range allSpecies {
		r -= s.weight
		if r <= 0 {
			return i
		}
	}
	return 0
}
