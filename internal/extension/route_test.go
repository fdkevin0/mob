package extension

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/chat"
)

func TestDecode(t *testing.T) {
	type input struct {
		Name string `json:"name"`
	}
	for body, ok := range map[string]bool{
		`{"name":"mob"}`:           true,
		`{"name":"mob","extra":1}`: false,
		`{"name":"mob"} {}`:        false,
		`not json`:                 false,
		`{"name":"` + strings.Repeat("x", 256<<10) + `"}`: false,
		// A valid value that ends exactly at the limit, then more bytes.
		padded(maxBody) + " ":  false,
		padded(maxBody) + "{}": false,
		padded(maxBody):        true,
	} {
		var v input
		err := Decode(httptest.NewRequest("POST", "/", strings.NewReader(body)), &v)
		var command *chat.CommandError
		if ok != (err == nil) || !ok && (!errors.As(err, &command) || command.Status != 400) {
			t.Fatalf("%.40s: %v", body, err)
		}
	}
}

// padded is a valid body of exactly n bytes.
func padded(n int) string {
	body := `{"name":""}`
	return body[:9] + strings.Repeat("x", n-len(body)) + body[9:]
}
