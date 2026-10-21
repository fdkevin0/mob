package pasture

import (
	"time"

	tea "charm.land/bubbletea/v2"
)

const (
	step     = 1.0 / 60
	maxSteps = 4
	// FrameInterval is how often a host should call Advance.
	FrameInterval = time.Second / 30
)

// Pasture is the sim and its renderer, sized in terminal cells.
type Pasture struct {
	world    *world
	renderer renderer
	acc      float64
	// Title is drawn centred over the field; the calves keep clear of it.
	Title []string
}

// New makes a pasture with the given herd, or the default four calves.
func New(herd ...Calf) *Pasture {
	return &Pasture{world: newWorld(herd)}
}

// Resize sets the field to cols × rows cells.
func (p *Pasture) Resize(cols, rows int) {
	cols, rows = max(cols, 1), max(rows, 1)
	if cols == p.renderer.cols && rows == p.renderer.rows {
		return
	}
	p.renderer.resize(cols, rows)
	p.world.resize(float64(cols*cellW), float64(rows*cellH), cellW, cellH)
}

// Size is the field in cells.
func (p *Pasture) Size() (int, int) { return p.renderer.cols, p.renderer.rows }

// Advance runs the sim on a fixed timestep for elapsed wall time.
func (p *Pasture) Advance(elapsed time.Duration) {
	dt := min(0.1, elapsed.Seconds())
	p.acc += dt
	steps := 0
	for p.acc >= step && steps < maxSteps {
		p.world.step(step)
		p.acc -= step
		steps++
	}
	if steps == maxSteps {
		p.acc = 0
	}
}

// Render advances the wake and draws a frame as ANSI text, rows joined by
// newlines.
func (p *Pasture) Render(elapsed time.Duration) string {
	return p.renderer.render(p.world, min(0.1, elapsed.Seconds()), p.Title)
}

// Point moves the pointer to a cell; butterflies shy away from it.
func (p *Pasture) Point(col, row int, active bool) {
	p.world.pointer.x = (float64(col) + 0.5) * cellW
	p.world.pointer.y = (float64(row) + 0.5) * cellH
	p.world.pointer.active = active && col >= 0 && row >= 0 && col < p.renderer.cols && row < p.renderer.rows
}

// Splash scatters everything near a cell.
func (p *Pasture) Splash(col, row int) {
	if col < 0 || row < 0 || col >= p.renderer.cols || row >= p.renderer.rows {
		return
	}
	p.world.splash((float64(col)+0.5)*cellW, (float64(row)+0.5)*cellH)
}

// Frame is the message a host's frame timer delivers.
type Frame struct{ At time.Time }

// Tick schedules the next Frame.
func Tick() tea.Cmd {
	return tea.Tick(FrameInterval, func(t time.Time) tea.Msg { return Frame{At: t} })
}

// Run shows the pasture full screen until q, Esc or Ctrl+C. The pointer
// scares butterflies and a click scatters them.
func Run() error {
	_, err := tea.NewProgram(&screen{pasture: New()}).Run()
	return err
}

type screen struct {
	pasture *Pasture
	last    time.Time
	frame   string
}

func (s *screen) Init() tea.Cmd { return Tick() }

func (s *screen) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.pasture.Resize(msg.Width, msg.Height)
	case tea.KeyPressMsg:
		switch msg.String() {
		case "q", "esc", "ctrl+c":
			return s, tea.Quit
		}
	case tea.MouseMotionMsg:
		s.pasture.Point(msg.X, msg.Y, true)
	case tea.MouseClickMsg:
		s.pasture.Splash(msg.X, msg.Y)
	case tea.BlurMsg:
		s.pasture.Point(0, 0, false)
	case Frame:
		elapsed := FrameInterval
		if !s.last.IsZero() {
			elapsed = msg.At.Sub(s.last)
		}
		s.last = msg.At
		s.pasture.Advance(elapsed)
		s.frame = s.pasture.Render(elapsed)
		return s, Tick()
	}
	return s, nil
}

func (s *screen) View() tea.View {
	v := tea.NewView(s.frame)
	v.AltScreen = true
	v.MouseMode = tea.MouseModeAllMotion
	v.ReportFocus = true
	return v
}
