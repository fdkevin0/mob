package extension

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/fdkevin0/mob/internal/chat"
)

// Route is an HTTP endpoint a plugin serves at /api/plugins/<plugin>/<Path>,
// behind the service's token like every other API.
type Route struct {
	Method, Path string
	// Handle's result is sent as JSON. A *chat.CommandError sets the
	// response status; any other error is the plugin's service failing (502).
	Handle func(r *http.Request) (any, error)
}

// Decode reads a request body of at most 256 KiB holding exactly one JSON
// value with only the fields dest has.
func Decode(r *http.Request, dest any) error {
	d := json.NewDecoder(io.LimitReader(r.Body, 256<<10))
	d.DisallowUnknownFields()
	if d.Decode(dest) != nil || d.Decode(new(any)) != io.EOF {
		return &chat.CommandError{Status: 400, Message: "invalid request"}
	}
	return nil
}
