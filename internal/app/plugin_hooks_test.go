package app

import (
	"context"
	"reflect"
	"testing"

	"github.com/fdkevin0/mob/internal/chat"
)

func TestPluginsRegisterTypedHooksInOrder(t *testing.T) {
	s := &Server{ConversationService: &chat.ConversationService{}}
	var called []string
	s.Hooks.BeforeTurn = append(s.Hooks.BeforeTurn, func(context.Context, *chat.Turn) error { called = append(called, "core"); return nil })
	for _, name := range []string{"first", "second"} {
		s.register(plugin{name: name, hooks: chat.Hooks{
			BeforeTurn: []func(context.Context, *chat.Turn) error{func(context.Context, *chat.Turn) error { called = append(called, name+" turn"); return nil }},
			BeforeTool: []func(context.Context, chat.ToolCall) error{func(context.Context, chat.ToolCall) error { called = append(called, name+" tool"); return nil }},
			AfterTurn:  []func(context.Context, *chat.Turn, chat.Message, error){func(context.Context, *chat.Turn, chat.Message, error) { called = append(called, name+" after") }},
		}})
	}
	ctx := context.Background()
	for _, hook := range s.Hooks.BeforeTurn {
		if err := hook(ctx, &chat.Turn{}); err != nil {
			t.Fatal(err)
		}
	}
	for _, hook := range s.Hooks.BeforeTool {
		if err := hook(ctx, chat.ToolCall{}); err != nil {
			t.Fatal(err)
		}
	}
	for _, hook := range s.Hooks.AfterTurn {
		hook(ctx, &chat.Turn{}, chat.Message{}, nil)
	}
	want := []string{"core", "first turn", "second turn", "first tool", "second tool", "first after", "second after"}
	if !reflect.DeepEqual(called, want) {
		t.Fatalf("hook order: %v", called)
	}
}
