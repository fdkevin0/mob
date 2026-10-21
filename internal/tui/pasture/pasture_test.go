package pasture

import (
	"regexp"
	"strings"
	"testing"
)

var sgrPattern = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func TestFrameFillsTheField(t *testing.T) {
	p := New()
	p.Resize(90, 30)
	p.Title = []string{"Mob"}
	var frame string
	for range 90 {
		p.Advance(FrameInterval)
		frame = p.Render(FrameInterval)
	}
	lines := strings.Split(sgrPattern.ReplaceAllString(frame, ""), "\n")
	if len(lines) != 30 {
		t.Fatalf("rows = %d, want 30", len(lines))
	}
	for i, line := range lines {
		if len(line) != 90 {
			t.Fatalf("row %d is %d cells wide, want 90", i, len(line))
		}
	}
	if !strings.Contains(lines[15], "Mob") {
		t.Fatalf("title missing from the middle row: %q", lines[15])
	}
	if !strings.ContainsAny(frame, "v-") {
		t.Fatal("no butterflies drawn")
	}
}

func TestCalvesStayOnTheField(t *testing.T) {
	p := New()
	p.Resize(80, 24)
	W, H := p.world.width, p.world.height
	for range 60 * 120 {
		p.world.step(step)
		p.world.events = p.world.events[:0]
		for _, c := range p.world.calves {
			if c.x < -c.length*0.1 || c.x > W+c.length*0.1 || c.y < 0 || c.y > H {
				t.Fatalf("calf %d wandered off to (%.0f, %.0f) in a %.0f×%.0f field", c.id, c.x, c.y, W, H)
			}
		}
	}
}

func TestCalvesNapAndHighFive(t *testing.T) {
	p := New()
	p.Resize(120, 40)
	napped, fived := false, false
	for range 60 * 300 {
		p.world.step(step)
		for _, e := range p.world.events {
			fived = fived || e.kind == sparked
		}
		p.world.events = p.world.events[:0]
		for _, c := range p.world.calves {
			napped = napped || c.state == napping
		}
		if napped && fived {
			return
		}
	}
	t.Fatalf("in five minutes: napped %t, high-fived %t", napped, fived)
}

func TestSpritesAreRectangular(t *testing.T) {
	for p, rows := range sprites {
		if len(rows) != spriteH {
			t.Fatalf("pose %d has %d rows", p, len(rows))
		}
		for _, row := range rows {
			if len(row) != spriteW {
				t.Fatalf("pose %d row %q is not %d wide", p, row, spriteW)
			}
		}
	}
}

func BenchmarkFrame(b *testing.B) {
	p := New()
	p.Resize(120, 40)
	for b.Loop() {
		p.Advance(FrameInterval)
		p.Render(FrameInterval)
	}
}
