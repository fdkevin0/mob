package telegram

import (
	"context"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/extension"
)

// Extension polls the Telegram Bot API while the plugin is enabled. config
// reads the saved configuration.
func Extension(config func() (Config, error), store *chat.Store, conversation *chat.ConversationService) extension.Extension {
	return extension.Extension{Name: "telegram", Start: func() (extension.Serve, error) {
		c, err := config()
		if err != nil || !c.Enabled {
			return nil, err
		}
		service := &Service{Store: store, Conversation: conversation}
		return func(ctx context.Context, status func(string)) { service.Loop(ctx, c, status) }, nil
	}}
}
