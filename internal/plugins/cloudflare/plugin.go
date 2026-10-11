package cloudflare

import (
	"context"
	"net/http"
	"strings"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/extension"
)

// Commands is /cloud, which runs any operation the Cloudflare panel offers.
// config reads the saved configuration.
func Commands(config func() (Config, error)) []chat.Command {
	return []chat.Command{{
		CommandSpec: chat.CommandSpec{Name: "cloud", Usage: "/cloud OPERATION [ARGUMENT]", Summary: "Run a Cloudflare operation; D1 runs writes too and Workers AI may incur charges", Clients: chat.Interactive},
		OwnerOnly:   true,
		Args:        []chat.Argument{chat.Choices(operations...)},
		Run: func(ctx context.Context, call chat.CommandCall) (chat.CommandResult, error) {
			if len(call.Fields) == 0 {
				return chat.Reply("`/cloud " + strings.Join(operations, "|") + " [prompt/search/key/SQL]`\n\nD1 executes your SQL, including writes. Workers AI calls may incur charges.")
			}
			operation := call.Fields[0]
			argument := strings.TrimSpace(strings.TrimPrefix(call.Rest, operation))
			c, err := config()
			if err != nil {
				return chat.CommandResult{}, err
			}
			ctx, cancel := context.WithTimeout(ctx, requestTimeout)
			defer cancel()
			result, err := c.Do(ctx, Action{Operation: operation, Text: argument, Key: argument, SQL: argument})
			if err != nil {
				return chat.CommandResult{}, err
			}
			return chat.ReplyJSON("**"+chat.Cell(operation)+"**", result)
		},
	}}
}

// Routes serve the web UI's Cloudflare panel.
func Routes(config func() (Config, error)) []extension.Route {
	return []extension.Route{{Method: "POST", Path: "action", Handle: func(r *http.Request) (any, error) {
		var a Action
		if err := extension.Decode(r, &a); err != nil {
			return nil, err
		}
		c, err := config()
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
		defer cancel()
		return c.Do(ctx, a)
	}}}
}
