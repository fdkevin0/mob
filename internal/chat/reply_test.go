package chat

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/llm"
)

type recordingModel struct {
	info   llm.Info
	stream func(context.Context, llm.Request, func(string, string) error) (llm.Result, error)
}

func (m recordingModel) Ref() llm.Ref { return llm.Ref{Provider: "test", Model: "recording"} }
func (m recordingModel) Info() llm.Info {
	return m.info
}
func (m recordingModel) Stream(ctx context.Context, req llm.Request, emit func(string, string) error) (llm.Result, error) {
	return m.stream(ctx, req, emit)
}

type recordingDelegate func(context.Context, *DelegateTurn) error

func (recordingDelegate) Owns(string) bool                      { return true }
func (recordingDelegate) Label(string) string                   { return "test/recording" }
func (recordingDelegate) Decide(string, Decision, Answer) error { return nil }
func (d recordingDelegate) Reply(ctx context.Context, turn *DelegateTurn) error {
	return d(ctx, turn)
}

func TestReplyRecordingKeepsPartsAndStepGrouping(t *testing.T) {
	for _, path := range []string{"model", "delegate"} {
		t.Run(path, func(t *testing.T) {
			s, id, m := turnFixture(t)
			var events []EventKind
			emit := func(e Event) error { events = append(events, e.Kind); return nil }
			var err error
			if path == "model" {
				step := 0
				model := recordingModel{info: llm.Info{Tools: true}, stream: func(_ context.Context, _ llm.Request, emit func(string, string) error) (llm.Result, error) {
					step++
					if step == 1 {
						if err := emit("reasoning", "thinking"); err != nil {
							return llm.Result{}, err
						}
						return llm.Result{Text: "checking", Calls: []llm.ToolCall{{ID: "call", Name: "lookup", Arguments: `{}`}}}, emit("text", "checking")
					}
					return llm.Result{Text: "done"}, emit("text", "done")
				}}
				tool := echoTool("lookup", func(context.Context, ToolCall) (any, error) { return "found", nil })
				err = Run(context.Background(), s, model, Agent{Tools: []Tool{tool}}, id, m, "", emit)
			} else {
				delegate := recordingDelegate(func(_ context.Context, turn *DelegateTurn) error {
					if err := turn.Stream("reasoning", "thinking"); err != nil {
						return err
					}
					if err := turn.Stream("text", "checking"); err != nil {
						return err
					}
					if err := turn.Tool("call", "lookup", map[string]any{}); err != nil {
						return err
					}
					if err := turn.ToolDone("call", "found", ""); err != nil {
						return err
					}
					return turn.Stream("text", "done")
				})
				err = runDelegate(context.Background(), s, delegate, ChatRequest{ID: id}, m, emit)
			}
			if err != nil {
				t.Fatal(err)
			}
			history, err := s.History(id)
			if err != nil {
				t.Fatal(err)
			}
			last := history[len(history)-1]
			want := []Part{
				{"type": "reasoning", "text": "thinking"},
				{"type": "text", "text": "checking"},
				{"type": "tool-lookup", "toolCallId": "call", "state": "output-available", "input": map[string]any{}, "output": "found"},
				{"type": "text", "text": "done"},
			}
			if !reflect.DeepEqual(last.Parts, want) || last.Metadata["status"] != "complete" {
				t.Fatalf("saved reply: %+v", last)
			}
			kinds := []EventKind{TurnStarted, StepStarted, SegmentStarted, SegmentDelta, SegmentStarted, SegmentDelta, SegmentFinished, SegmentFinished}
			if path == "model" {
				kinds = append(kinds, ToolInput, ToolOutput, StepFinished, StepStarted)
			} else {
				kinds = append(kinds, StepFinished, StepStarted, ToolInput, ToolOutput)
			}
			kinds = append(kinds, SegmentStarted, SegmentDelta, SegmentFinished, StepFinished)
			if !slices.Equal(events, kinds) {
				t.Fatalf("events %v, want %v", events, kinds)
			}
		})
	}
}

func TestReplyRecordingPreservesPartialTextAndFailures(t *testing.T) {
	for _, path := range []string{"model", "delegate"} {
		for _, failure := range []string{"cancelled", "save-failed"} {
			t.Run(path+"/"+failure, func(t *testing.T) {
				s, id, m := turnFixture(t)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				cause := errors.New("upstream failed")
				if failure == "cancelled" {
					cause = context.Canceled
				} else if _, err := s.db.Exec(`CREATE TRIGGER fail_final_save BEFORE UPDATE ON messages WHEN NEW.status != 'streaming' BEGIN SELECT RAISE(ABORT, 'final save failed'); END`); err != nil {
					t.Fatal(err)
				}
				write := func(stream func(string, string) error) error {
					if err := stream("text", "partial"); err != nil {
						return err
					}
					if failure == "cancelled" {
						cancel()
					}
					return cause
				}
				var err, hookErr error
				if path == "model" {
					model := recordingModel{stream: func(_ context.Context, _ llm.Request, emit func(string, string) error) (llm.Result, error) {
						return llm.Result{}, write(emit)
					}}
					agent := Agent{Hooks: Hooks{AfterTurn: []func(context.Context, *Turn, Message, error){func(_ context.Context, _ *Turn, _ Message, err error) { hookErr = err }}}}
					err = Run(ctx, s, model, agent, id, m, "", func(Event) error { return nil })
					if !errors.Is(hookErr, cause) || (failure == "save-failed" && !strings.Contains(hookErr.Error(), "final save failed")) {
						t.Fatalf("AfterTurn missed the final error: %v", hookErr)
					}
				} else {
					delegate := recordingDelegate(func(_ context.Context, turn *DelegateTurn) error { return write(turn.Stream) })
					err = runDelegate(ctx, s, delegate, ChatRequest{ID: id}, m, func(Event) error { return nil })
				}
				if !errors.Is(err, cause) {
					t.Fatalf("lost original failure: %v", err)
				}
				if failure == "save-failed" {
					if !strings.Contains(err.Error(), "final save failed") {
						t.Fatalf("lost save failure: %v", err)
					}
					return
				}
				history, err := s.History(id)
				if err != nil {
					t.Fatal(err)
				}
				last := history[len(history)-1]
				if Text(last) != "partial" || last.Metadata["status"] != "cancelled" {
					t.Fatalf("lost cancelled reply: %+v", last)
				}
			})
		}
	}
}
