package chat

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestStartStopsAnApprovedCallBeforeTheFirstEvent(t *testing.T) {
	service, c := testService(t)
	entered, exited := make(chan struct{}), make(chan error, 1)
	tool := echoTool("deploy", func(context.Context, ToolCall) (any, error) { return nil, nil })
	tool.Approved = func(ctx context.Context, _ ApprovedCall) (any, error) {
		close(entered)
		<-ctx.Done()
		exited <- ctx.Err()
		return nil, ctx.Err()
	}
	service.Tools.Register(tool)
	m, _ := service.Store.Begin(c.ID, NewID(), "deploy", "alpha/one")
	m.Parts = []Part{{"type": "tool-deploy", "toolCallId": "call", "input": map[string]string{"target": "prod"}}}
	approval, err := service.Store.RequestApproval(c.ID, m, "call", map[string]string{"target": "prod"})
	if err != nil {
		t.Fatal(err)
	}
	input := ChatRequest{ID: c.ID, Owner: true, Approval: &Answer{ID: approval, Approved: true}}
	stop := make(chan struct{})
	started := make(chan error, 1)
	go func() {
		_, err := service.Start(input, stop)
		started <- err
	}()
	<-entered
	close(stop)
	select {
	case err := <-exited:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("approved call ended with %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("closing stop left the approved call running")
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("Start did not return")
	}
	if service.Active(c.ID) {
		t.Fatal("the turn is still running")
	}
}

func TestStartDoesNothingWithAlreadyWithdrawnAuthority(t *testing.T) {
	service, c := testService(t)
	tool := echoTool("deploy", func(context.Context, ToolCall) (any, error) { return nil, nil })
	tool.Approved = func(context.Context, ApprovedCall) (any, error) {
		t.Error("ran an approved call after stop closed")
		return nil, nil
	}
	service.Tools.Register(tool)
	stop := make(chan struct{})
	close(stop)
	for range 30 {
		m, _ := service.Store.Begin(c.ID, NewID(), "deploy", "alpha/one")
		m.Parts = []Part{{"type": "tool-deploy", "toolCallId": "call", "input": map[string]string{"target": "prod"}}}
		approval, err := service.Store.RequestApproval(c.ID, m, "call", map[string]string{"target": "prod"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := service.Start(ChatRequest{ID: c.ID, Owner: true, Approval: &Answer{ID: approval, Approved: true}}, stop); !errors.Is(err, context.Canceled) {
			t.Fatalf("Start with withdrawn authority: %v", err)
		}
		// The approval is still pending: nothing was decided for a stopped turn.
		if _, err := service.Store.Decide(c.ID, approval, false, ""); err != nil {
			t.Fatalf("approval was decided: %v", err)
		}
	}
}
