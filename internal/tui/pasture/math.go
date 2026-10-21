package pasture

import (
	"math"
	"math/rand/v2"
)

const tau = math.Pi * 2

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func between(lo, hi float64) float64 { return lo + rand.Float64()*(hi-lo) }

func betweenInt(lo, hi int) int { return lo + rand.IntN(hi-lo+1) }

func smoothstep(e0, e1, x float64) float64 {
	t := clamp((x-e0)/(e1-e0), 0, 1)
	return t * t * (3 - 2*t)
}

// angleDiff is the shortest signed angle from a to b, in (-π, π].
func angleDiff(a, b float64) float64 {
	d := math.Mod(b-a, tau)
	if d > math.Pi {
		d -= tau
	}
	if d < -math.Pi {
		d += tau
	}
	return d
}

// hash3 is a cheap integer hash to [0, 1). It is deterministic, so textures
// stay put from frame to frame.
func hash3(x, y, z int) float64 {
	h := uint32(int32(x))*374761393 ^ uint32(int32(y))*668265263 ^ uint32(int32(z))*1442695041
	h = (h ^ h>>13) * 1274126177
	h ^= h >> 16
	return float64(h) / 4294967296
}

const (
	k1           = 1.0 / 260
	k2           = 1.0 / 310
	k3           = 1.0 / 190
	currentScale = 3400
)

// breeze is a divergence-free wind: the curl of a slowly drifting stream
// function, so it carries flocks about without piling them into a corner.
func breeze(x, y, t float64) (float64, float64) {
	a := x*k1 + t*0.07
	b := y*k2 - t*0.05
	c := (x+y)*k3 + t*0.11
	u := (-k2*math.Sin(a)*math.Sin(b) + 0.5*k3*math.Cos(c)) * currentScale
	v := (-k1*math.Cos(a)*math.Cos(b) - 0.5*k3*math.Cos(c)) * currentScale
	return u, v
}
