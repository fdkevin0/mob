package configuration

import (
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/chat"
)

// Fields name real JSON paths of the right kind, and every secret an update
// accepts is a secret field.
func TestSectionFieldsMatchConfiguration(t *testing.T) {
	configs := reflect.TypeOf(Plugins{})
	if configs.NumField() != len(sections) {
		t.Fatalf("%d plugins, %d sections", configs.NumField(), len(sections))
	}
	for i, section := range Sections() {
		plugin := configs.Field(i)
		if name := plugin.Tag.Get("json"); name != section.Name {
			t.Fatalf("section %d is %s, configuration field is %s", i, section.Name, name)
		}
		var secrets []string
		for _, field := range section.Fields {
			typ := plugin.Type
			for _, part := range strings.Split(field.Path, ".") {
				f, ok := fieldByTag(typ, part)
				if !ok {
					t.Fatalf("unknown field %s.%s", section.Name, field.Path)
				}
				typ = f.Type
			}
			switch field.Kind {
			case "bool":
				if typ.Kind() != reflect.Bool {
					t.Fatalf("%s.%s is %s, want bool", section.Name, field.Path, typ.Kind())
				}
			case "int":
				if typ.Kind() != reflect.Int && typ.Kind() != reflect.Int64 {
					t.Fatalf("%s.%s is %s, want an integer", section.Name, field.Path, typ.Kind())
				}
			case "text", "secret":
				if typ.Kind() != reflect.String {
					t.Fatalf("%s.%s is %s, want string", section.Name, field.Path, typ.Kind())
				}
			default:
				t.Fatalf("%s.%s has unknown kind %q", section.Name, field.Path, field.Kind)
			}
			if field.Kind == "secret" {
				secrets = append(secrets, field.Path)
			}
		}
		if len(section.Fields) > 0 && !slices.Equal(secrets, section.Secrets) {
			t.Fatalf("%s: secret fields %v, secrets %v", section.Name, secrets, section.Secrets)
		}
	}
}

func fieldByTag(typ reflect.Type, tag string) (reflect.StructField, bool) {
	for i := 0; i < typ.NumField(); i++ {
		if f := typ.Field(i); strings.Split(f.Tag.Get("json"), ",")[0] == tag {
			return f, true
		}
	}
	return reflect.StructField{}, false
}

func TestSectionUpdates(t *testing.T) {
	store, err := chat.OpenStore(filepath.Join(t.TempDir(), "mob.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	s := &Service{Store: store}
	mail := `{"enabled":true,"from":"a@example.org","imap":{"host":"imap.example.org","port":993,"security":"tls","username":"a","password":"imap-secret"},"smtp":{"host":"smtp.example.org","port":587,"security":"starttls","username":"a","password":"smtp-secret"}}`
	if _, err := s.UpdatePlugin("email", []byte(mail)); err != nil {
		t.Fatal(err)
	}
	blank := strings.ReplaceAll(strings.ReplaceAll(mail, `"imap-secret"`, `""`), `"smtp-secret"`, `""`)
	c, err := s.UpdatePlugin("email", []byte(blank))
	if err != nil || c.Email.IMAP.Password != "imap-secret" || c.Email.SMTP.Password != "smtp-secret" {
		t.Fatalf("blank passwords for the same owners: %v %+v", err, c.Email)
	}
	// A new SMTP username drops only the SMTP password, which validation then requires.
	if _, err := s.UpdatePlugin("email", []byte(strings.Replace(blank, `"username":"a","password":""}}`, `"username":"b","password":""}}`, 1))); err == nil || !strings.Contains(err.Error(), "password are required") {
		t.Fatalf("SMTP password followed a new username: %v", err)
	}
	c, err = s.UpdatePlugin("telegram", []byte(`{"enabled":false,"userId":42,"secrets":{"token":{"mode":"replace","value":"123:abc"}}}`))
	if err != nil || c.Telegram.Token != "123:abc" || c.Email.IMAP.Password != "imap-secret" {
		t.Fatalf("telegram update: %v %+v", err, c)
	}
	for _, bad := range []struct{ name, raw string }{
		{"unknown", `{}`},
		{"telegram", `{"enabled":false,"secrets":{"password":{"mode":"clear"}}}`},
		{"telegram", `{"enabled":true,"userId":0}`},
		{"wechat_ilink", `{"enabled":true,"baseUrl":"ftp://example.org"}`},
	} {
		if _, err := s.UpdatePlugin(bad.name, []byte(bad.raw)); err == nil {
			t.Fatalf("%s accepted %s", bad.name, bad.raw)
		}
	}
	saved, err := s.Plugins()
	if err != nil || saved.Telegram.Token != "123:abc" || saved.WeChatILink.Enabled {
		t.Fatalf("a refused update was saved: %v %+v", err, saved)
	}
}
