package chat

import (
	"context"
	"fmt"
	"strings"

	"github.com/fdkevin0/mob/internal/llm"
)

// Slash commands are answered by Mob itself, in every client and channel.
// They are recorded in the transcript but never sent to a model.
const modelHelp = "/model shows this conversation's model · /model NAME switches it · /model default [NAME] follows or sets the default · /models [FILTER] lists models"

// perProvider bounds /models output; a filter narrows a long list.
const perProvider = 25

func isCommand(text string) bool {
	name, _, _ := strings.Cut(text, " ")
	return name == "/model" || name == "/models"
}

func (s *ConversationService) command(ctx context.Context, input ChatRequest, emit func(Event) error) error {
	// A retried request must not switch models again after later choices.
	if s.Store.HasRequest(input.RequestID) {
		return &CommandError{409, "request already accepted; refresh history"}
	}
	name, args, _ := strings.Cut(input.Text, " ")
	args = strings.TrimSpace(args)
	var reply string
	var err error
	if name == "/models" {
		reply, err = s.models(ctx, input.ID, args)
	} else {
		reply, err = s.switchModel(input.ID, args, input.Owner)
	}
	if err != nil {
		return err
	}
	message, err := s.Store.Command(input.ID, input.RequestID, input.Text, reply)
	if err != nil {
		if s.Store.HasRequest(input.RequestID) {
			return &CommandError{409, "request already accepted; refresh history"}
		}
		return err
	}
	id := NewID()
	for _, e := range []Event{{Kind: TurnStarted, MessageID: message.ID}, {Kind: StepStarted}, {Kind: SegmentStarted, Segment: "text", ID: id},
		{Kind: SegmentDelta, Segment: "text", ID: id, Text: reply}, {Kind: SegmentFinished, Segment: "text", ID: id}, {Kind: StepFinished}, {Kind: TurnFinished, Reason: "stop"}} {
		if err := emit(e); err != nil {
			return err
		}
	}
	return nil
}

// describe is one line about a model: its name and what it can do.
func describe(i llm.Info) string {
	var traits []string
	if i.Name != "" && i.Name != i.ID {
		traits = append(traits, i.Name)
	}
	if i.Reasoning {
		trait := "reasoning"
		if len(i.Efforts) > 0 {
			trait += " (" + strings.Join(i.Efforts, "/") + ")"
		}
		traits = append(traits, trait)
	}
	if i.Tools {
		traits = append(traits, "tools")
	}
	if i.Vision {
		traits = append(traits, "images")
	}
	if i.Context > 0 {
		traits = append(traits, fmt.Sprintf("%dk context", i.Context/1000))
	}
	if i.Cost != nil {
		if i.Cost.Input == 0 && i.Cost.Output == 0 {
			traits = append(traits, "free")
		} else {
			traits = append(traits, fmt.Sprintf("$%g/$%g per 1M tokens", i.Cost.Input, i.Cost.Output))
		}
	}
	return strings.Join(traits, " · ")
}

func (s *ConversationService) models(ctx context.Context, id, filter string) (string, error) {
	current, err := s.Model(id)
	if err != nil {
		return "", err
	}
	currentRef, _ := llm.ParseRef(current)
	groups := s.Models.List(ctx, filter)
	var b strings.Builder
	fmt.Fprintf(&b, "**Current model:** `%s`\n", current)
	if len(groups) == 0 {
		if filter != "" {
			fmt.Fprintf(&b, "\nNo model matches %q.", filter)
		} else {
			b.WriteString("\nNo providers yet. Add one with `mob provider add`.")
		}
		return b.String(), nil
	}
	for _, g := range groups {
		fmt.Fprintf(&b, "\n### %s (%s)\n\n", g.Provider, g.Name)
		if g.Error != "" {
			fmt.Fprintf(&b, "> **Warning:** %s\n\n", g.Error)
		}
		for i, m := range g.Models {
			if i == perProvider {
				fmt.Fprintf(&b, "\n*… %d more; narrow with `/models FILTER`.*\n", len(g.Models)-perProvider)
				break
			}
			ref := "`" + g.Provider + "/" + m.ID + "`"
			if g.Provider == currentRef.Provider && m.ID == currentRef.Model {
				ref = "**" + ref + "** (current)"
			}
			line := "- " + ref
			if d := describe(m); d != "" {
				line += " — " + d
			}
			b.WriteString(line + "\n")
		}
	}
	b.WriteString("\nSwitch with `/model NAME`, e.g. `/model " + example(groups) + "`.")
	return b.String(), nil
}

func example(groups []llm.Group) string {
	for _, g := range groups {
		if len(g.Models) > 0 {
			return g.Provider + "/" + g.Models[0].ID
		}
	}
	return "provider/model"
}

func (s *ConversationService) switchModel(id, args string, owner bool) (string, error) {
	if args == "" {
		current, err := s.Model(id)
		if err != nil {
			return "", err
		}
		if current == "" {
			return "No model is configured.\n" + modelHelp, nil
		}
		line := "This conversation uses " + current
		if m, err := s.Models.Resolve(current); err != nil {
			line += " (unavailable: " + err.Error() + ")"
		} else if d := describe(m.Info()); d != "" {
			line += " — " + d
		}
		if ref, _ := s.Store.ConversationModel(id); ref == "" {
			line += " (the default)"
		}
		return line + "\n" + modelHelp, nil
	}
	if !owner {
		return "Only the owner of this Mob can switch models.", nil
	}
	target, rest, _ := strings.Cut(args, " ")
	if target == "default" {
		rest = strings.TrimSpace(rest)
		if rest == "" {
			if err := s.Store.SetConversationModel(id, ""); err != nil {
				return "", err
			}
			return "This conversation now follows the default model, " + s.Models.Default() + ".", nil
		}
		ref, err := s.Models.SetDefault(rest)
		if err != nil {
			return err.Error(), nil
		}
		return "The default model is now " + ref.String() + ". Conversations without their own /model choice use it.", nil
	}
	m, err := s.Models.Resolve(args)
	if err != nil {
		return err.Error(), nil
	}
	if err = s.Store.SetConversationModel(id, m.Ref().String()); err != nil {
		return "", err
	}
	line := "Switched this conversation to " + m.Ref().String()
	if d := describe(m.Info()); d != "" {
		line += " — " + d
	}
	return line + ".", nil
}
