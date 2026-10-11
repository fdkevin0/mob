package tui

import (
	"github.com/fdkevin0/mob/internal/configuration"
	"reflect"
	"strings"
	"testing"
)

// Static UI labels stay handwritten; this check prevents their JSON paths and
// value kinds from drifting from the server contract.
func TestPluginFieldsMatchContract(t *testing.T) {
	configs := reflect.TypeOf(configuration.Plugins{})
	for i := 0; i < configs.NumField(); i++ {
		plugin := configs.Field(i)
		name := plugin.Tag.Get("json")
		for _, field := range fieldsFor(name) {
			typ := plugin.Type
			for _, part := range strings.Split(field.path, ".") {
				found := false
				for j := 0; j < typ.NumField(); j++ {
					f := typ.Field(j)
					if strings.Split(f.Tag.Get("json"), ",")[0] == part {
						typ = f.Type
						found = true
						break
					}
				}
				if !found {
					t.Fatalf("unknown field %s.%s", name, field.path)
				}
			}
			want := reflect.String
			if field.kind == "bool" {
				want = reflect.Bool
			}
			if field.kind == "int" {
				if typ.Kind() != reflect.Int && typ.Kind() != reflect.Int64 {
					t.Fatalf("%s requires integer", field.path)
				}
				continue
			}
			if typ.Kind() != want {
				t.Fatalf("%s: %s, want %s", field.path, typ.Kind(), want)
			}
		}
	}
}
