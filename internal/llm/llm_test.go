package llm

import (
	"strings"
	"testing"
)

func TestSSEMultiline(t *testing.T) {
	var got []string
	err := ReadSSE(strings.NewReader(": heartbeat\r\nevent: delta\r\ndata: one\r\ndata: two\r\n\r\ndata: tail"), func(event string, raw []byte) error {
		got = append(got, event+"="+string(raw))
		return nil
	})
	if err != nil || strings.Join(got, "|") != "delta=one\ntwo|=tail" {
		t.Fatalf("%v %v", got, err)
	}
}

func TestParseRef(t *testing.T) {
	for in, want := range map[string]Ref{
		"deepseek/deepseek-reasoner:high":    {"deepseek", "deepseek-reasoner", "high"},
		"ollama/llama3.2:3b":                 {"ollama", "llama3.2:3b", ""},
		"openrouter/deepseek/deepseek-chat":  {"openrouter", "deepseek/deepseek-chat", ""},
		" cf/@cf/meta/llama-3.1-8b:minimal ": {"cf", "@cf/meta/llama-3.1-8b", "minimal"},
	} {
		got, ok := ParseRef(in)
		if !ok || got != want {
			t.Errorf("%q → %+v", in, got)
		}
	}
	for _, bad := range []string{"", "model", "/model", "provider/"} {
		if _, ok := ParseRef(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
	if (Ref{"a", "b", "low"}).String() != "a/b:low" {
		t.Fatal("ref string")
	}
}

func TestUsagePriced(t *testing.T) {
	u := Usage{Input: 1_000_000, Output: 1_000_000, CacheRead: 500_000}.Priced(&Cost{Input: 2, Output: 8, CacheRead: 0.5})
	if u.Cost != 1+8+0.25 {
		t.Fatalf("cost %v", u.Cost)
	}
}
