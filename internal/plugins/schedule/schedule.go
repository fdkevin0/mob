// Package schedule lets the owner's model run a prompt on its own at a set
// time, once or repeatedly: a morning summary of the projects, a reminder, a
// check on a task. A scheduled prompt runs as a turn of the owner's in the
// conversation that scheduled it, and the owner hears its conclusion in the
// messaging apps they use.
package schedule

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/extension"
	"github.com/fdkevin0/mob/internal/llm"
)

// Repeats are how a schedule may repeat; empty runs it once.
var Repeats = []string{"hourly", "daily", "weekdays", "weekly"}

const (
	// tick is how often due schedules are looked for.
	tick = 30 * time.Second
	// promptLimit bounds a scheduled prompt, in bytes.
	promptLimit = 4000
	// noticeLimit bounds the conclusion a notice repeats, in runes.
	noticeLimit = 1200
)

// runPrompt introduces a scheduled prompt to the model.
const runPrompt = "Scheduled by the owner with the schedule tool, now due (%s): %s\nDo it now, then end with a short conclusion for the owner."

// Service runs the schedules.
type Service struct {
	Store         *chat.Store
	Conversations *chat.ConversationService
	// Now is the clock; nil uses time.Now.
	Now func() time.Time
	// wake makes the loop look for due schedules at once.
	wake     chan struct{}
	wakeOnce sync.Once
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// wakeup is the channel that makes the loop look at once.
func (s *Service) wakeup() chan struct{} {
	s.wakeOnce.Do(func() { s.wake = make(chan struct{}, 1) })
	return s.wake
}

func (s *Service) poke() {
	select {
	case s.wakeup() <- struct{}{}:
	default:
	}
}

// Extension runs due schedules while Mob runs.
func (s *Service) Extension() extension.Extension {
	return extension.Extension{Name: "schedules", Start: func() (extension.Serve, error) {
		return func(ctx context.Context, status func(string)) {
			status("Running")
			timer := time.NewTicker(tick)
			defer timer.Stop()
			for {
				s.RunDue()
				select {
				case <-ctx.Done():
					return
				case <-timer.C:
				case <-s.wakeup():
				}
			}
		}, nil
	}}
}

// RunDue starts a turn for each schedule that is due. A one-off schedule is
// then deleted and a repeating one moved to its next time; one whose
// conversation is busy waits for the next look. A repeat Mob missed while it
// was stopped runs once, not once for each time it missed.
func (s *Service) RunDue() {
	now := s.now()
	due, err := s.Store.Schedules(now.UnixMilli())
	if err != nil {
		return
	}
	for _, sc := range due {
		text := fmt.Sprintf(runPrompt, time.UnixMilli(sc.Next).In(zone(sc.Zone)).Format("Mon 2006-01-02 15:04 MST"), sc.Prompt)
		run, err := s.Conversations.Start(chat.ChatRequest{ID: sc.ConversationID, Text: text, RequestID: chat.NewID(), Owner: true}, nil)
		var busy *chat.CommandError
		if errors.As(err, &busy) && busy.Status == 409 {
			continue
		}
		if sc.Repeat == "" {
			_, _ = s.Store.Unschedule(sc.ID)
		} else {
			_ = s.Store.Reschedule(sc.ID, next(time.UnixMilli(sc.Next), sc.Repeat, zone(sc.Zone), sc.Clock, now).UnixMilli())
		}
		if err != nil {
			s.Conversations.Notify(chat.Notice{ConversationID: sc.ConversationID, Text: "**Scheduled prompt could not run:** " + firstLine(sc.Prompt) + "\n\n" + err.Error()})
			continue
		}
		go s.report(sc, run)
	}
}

// report tells the owner what a scheduled turn concluded once it ends.
func (s *Service) report(sc chat.Schedule, run *chat.Running) {
	<-run.Done()
	// The reply this turn wrote, not a later turn's.
	said, _ := s.Store.Reply(run.MessageID())
	said = strings.TrimSpace(said)
	if r := []rune(said); len(r) > noticeLimit {
		said = string(r[:noticeLimit]) + "…"
	}
	if said == "" {
		said = "It did not finish; open its conversation to see why."
	}
	s.Conversations.Notify(chat.Notice{ConversationID: sc.ConversationID, Text: "**Scheduled:** " + firstLine(sc.Prompt) + "\n\n" + said, Approvals: s.Conversations.Pending(sc.ConversationID)})
}

// next is the first time after now that a schedule last due at last runs
// again. Calendar repeats count days in loc and run at clock (15:04) there,
// so a daily schedule keeps its time of day across daylight saving changes;
// on a day that skips that time, Go moves that one run, not later ones.
func next(last time.Time, repeat string, loc *time.Location, clock string, now time.Time) time.Time {
	if repeat == "hourly" {
		t := last
		for !t.After(now) {
			t = t.Add(time.Hour)
		}
		return t
	}
	day := last.In(loc)
	hour, minute := day.Hour(), day.Minute()
	if c, err := time.Parse("15:04", clock); err == nil {
		hour, minute = c.Hour(), c.Minute()
	}
	y, m, d := day.Date()
	for {
		switch repeat {
		case "weekly":
			d += 7
		case "weekdays":
			d++
			for wd := time.Date(y, m, d, 12, 0, 0, 0, loc).Weekday(); wd == time.Saturday || wd == time.Sunday; wd = time.Date(y, m, d, 12, 0, 0, 0, loc).Weekday() {
				d++
			}
		default:
			d++
		}
		if t := time.Date(y, m, d, hour, minute, 0, 0, loc); t.After(now) {
			return t
		}
	}
}

// zone is the named location, or Mob's own when the name is empty or unknown.
func zone(name string) *time.Location {
	if name != "" {
		if loc, err := time.LoadLocation(name); err == nil {
			return loc
		}
	}
	return time.Local
}

func firstLine(text string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	if r := []rune(line); len(r) > 80 {
		return string(r[:80]) + "…"
	}
	return line
}

func object(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func text(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

// Tools schedule prompts, list them and cancel them.
func (s *Service) Tools() []chat.Tool {
	return []chat.Tool{{
		Tool: llm.Tool{Name: "schedule", Description: "Ask the owner to approve running a prompt on your own later, once or repeatedly, such as a morning summary of the coding tasks or a reminder. It runs as a turn in this conversation and the owner is told its conclusion. Get the current time with datetime first. The turn stops until the owner approves.", Parameters: object(map[string]any{
			"prompt":   text("What to do when it runs, with everything needed, as an instruction to yourself"),
			"at":       text("When it first runs, RFC 3339 with an offset, such as 2026-10-21T09:00:00+08:00"),
			"repeat":   map[string]any{"type": "string", "enum": Repeats, "description": "Repeat after each run; omit to run once"},
			"timezone": text("IANA time zone repeats keep their time of day in, such as Asia/Shanghai; default the computer's"),
		}, "prompt", "at")},
		Prompt:    "You can act later on your own: schedule runs a prompt at a set time, once or repeatedly; schedules lists them and schedule_cancel cancels one.",
		OwnerOnly: true,
		Run:       s.ask,
		Approved:  s.add,
	}, {
		Tool:      llm.Tool{Name: "schedules", Description: "List the scheduled prompts: ID, prompt, next run and repeat.", Parameters: object(map[string]any{})},
		OwnerOnly: true,
		Available: s.any,
		Run: func(context.Context, chat.ToolCall) (any, error) {
			return s.list()
		},
	}, {
		Tool:      llm.Tool{Name: "schedule_cancel", Description: "Cancel a scheduled prompt.", Parameters: object(map[string]any{"id": text("The schedule's ID")}, "id")},
		OwnerOnly: true,
		Available: s.any,
		Run: func(_ context.Context, call chat.ToolCall) (any, error) {
			id, _ := call.Input["id"].(string)
			if id == "" || id == "all" {
				return nil, errors.New("give one schedule's ID")
			}
			n, err := s.Store.Unschedule(id)
			if err != nil {
				return nil, err
			}
			if n == 0 {
				return nil, fmt.Errorf("no schedule %s", id)
			}
			return map[string]any{"cancelled": true}, nil
		},
	}}
}

// any reports whether anything is scheduled; until then only schedule is
// offered.
func (s *Service) any() bool {
	all, err := s.Store.Schedules(0)
	return err == nil && len(all) > 0
}

// request is a schedule call's input, checked.
type request struct {
	Prompt   string `json:"prompt"`
	At       string `json:"at"`
	Repeat   string `json:"repeat,omitempty"`
	Timezone string `json:"timezone,omitempty"`
}

// ask checks a schedule call and asks the owner to approve it.
func (s *Service) ask(_ context.Context, call chat.ToolCall) (any, error) {
	var in request
	raw, _ := json.Marshal(call.Input)
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, err
	}
	in.Prompt = strings.TrimSpace(in.Prompt)
	if in.Prompt == "" || len(in.Prompt) > promptLimit {
		return nil, fmt.Errorf("prompt must be 1–%d bytes", promptLimit)
	}
	at, err := time.Parse(time.RFC3339, in.At)
	if err != nil {
		return nil, errors.New("at must be RFC 3339 with an offset, such as 2026-10-21T09:00:00+08:00")
	}
	if in.Repeat != "" && !slices.Contains(Repeats, in.Repeat) {
		return nil, fmt.Errorf("repeat must be one of %s", strings.Join(Repeats, ", "))
	}
	if in.Timezone != "" {
		if _, err := time.LoadLocation(in.Timezone); err != nil {
			return nil, fmt.Errorf("unknown time zone %q", in.Timezone)
		}
	}
	if in.Repeat == "" && at.Before(s.now()) {
		return nil, fmt.Errorf("%s has passed; it is now %s", in.At, s.now().Format(time.RFC3339))
	}
	in.At = at.Format(time.RFC3339)
	return nil, call.RequestApproval(in)
}

// add saves an approved schedule in the conversation that asked for it.
func (s *Service) add(_ context.Context, call chat.ApprovedCall) (any, error) {
	var in request
	if err := json.Unmarshal(call.Input, &in); err != nil {
		return nil, err
	}
	at, err := time.Parse(time.RFC3339, in.At)
	if err != nil {
		return nil, err
	}
	sc := chat.Schedule{ConversationID: call.ConversationID, Prompt: in.Prompt, Next: at.UnixMilli(), Repeat: in.Repeat, Zone: in.Timezone, Clock: at.In(zone(in.Timezone)).Format("15:04")}
	// A repeat whose first time has passed starts at its next one.
	if now := s.now(); sc.Repeat != "" && at.Before(now) {
		sc.Next = next(at, sc.Repeat, zone(sc.Zone), sc.Clock, now).UnixMilli()
	}
	if err := s.Store.AddSchedule(&sc); err != nil {
		return nil, err
	}
	s.poke()
	return map[string]any{"schedule": sc.ID, "next": time.UnixMilli(sc.Next).In(zone(sc.Zone)).Format(time.RFC3339), "repeat": sc.Repeat}, nil
}

// list is what schedules returns.
func (s *Service) list() (any, error) {
	all, err := s.Store.Schedules(0)
	if err != nil {
		return nil, err
	}
	list := make([]map[string]any, len(all))
	for i, sc := range all {
		list[i] = map[string]any{"id": sc.ID, "prompt": sc.Prompt, "next": time.UnixMilli(sc.Next).In(zone(sc.Zone)).Format(time.RFC3339), "repeat": sc.Repeat, "conversation": sc.ConversationID}
	}
	return map[string]any{"schedules": list}, nil
}

// Commands list and cancel schedules.
func (s *Service) Commands() []chat.Command {
	return []chat.Command{{
		CommandSpec: chat.CommandSpec{Name: "schedules", Usage: "/schedules", Summary: "List scheduled prompts", Clients: chat.Interactive},
		OwnerOnly:   true,
		Run: func(context.Context, chat.CommandCall) (chat.CommandResult, error) {
			all, err := s.Store.Schedules(0)
			if err != nil {
				return chat.CommandResult{}, err
			}
			if len(all) == 0 {
				return chat.Reply("Nothing is scheduled. Ask Mob to do something later, such as \"every weekday at 9 summarize my coding tasks\".")
			}
			var b strings.Builder
			b.WriteString("| Prompt | Next | Repeat | Cancel |\n| --- | --- | --- | --- |\n")
			for _, sc := range all {
				repeat := sc.Repeat
				if repeat == "" {
					repeat = "once"
				}
				fmt.Fprintf(&b, "| %s | %s | %s | `/unschedule %s` |\n", chat.Cell(firstLine(sc.Prompt)), time.UnixMilli(sc.Next).In(zone(sc.Zone)).Format("Mon 2006-01-02 15:04 MST"), repeat, sc.ID)
			}
			b.WriteString("\n`/unschedule all` cancels every one.")
			return chat.Reply(b.String())
		},
	}, {
		CommandSpec: chat.CommandSpec{Name: "unschedule", Usage: "/unschedule ID|all", Summary: "Cancel a scheduled prompt", Clients: chat.Interactive},
		OwnerOnly:   true,
		Run: func(_ context.Context, call chat.CommandCall) (chat.CommandResult, error) {
			if len(call.Fields) != 1 {
				return chat.Reply("Use `/unschedule ID` or `/unschedule all`; `/schedules` lists them.")
			}
			n, err := s.Store.Unschedule(call.Fields[0])
			if err != nil {
				return chat.CommandResult{}, err
			}
			if n == 0 {
				return chat.Reply("No schedule has ID `" + chat.Cell(call.Fields[0]) + "`.")
			}
			return chat.Reply(fmt.Sprintf("Cancelled %d scheduled prompt(s).", n))
		},
	}}
}
