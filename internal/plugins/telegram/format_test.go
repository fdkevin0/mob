package telegram

import (
	"strings"
	"testing"
)

func TestChunksFormatMarkdownAsTelegramHTML(t *testing.T) {
	got := chunks("# Title\n\nSome **bold**, *it*, ~~gone~~ and `a<b>` & [link](https://x.y/?a=1&b=2), [local](file:///etc).\nNext line.\n\n"+
		"- one\n- two\n  - nested\n\n3. three\n\n> quoted *text*\n\n```go\nif a < b {}\n```\n\n| Tool | 次数 |\n| --- | --- |\n| run | 2 |\n\n<div>raw</div>", chunkLimit)
	if len(got) != 1 {
		t.Fatalf("chunks: %+v", got)
	}
	want := "<b>Title</b>\n\nSome <b>bold</b>, <i>it</i>, <s>gone</s> and <code>a&lt;b&gt;</code> &amp; <a href=\"https://x.y/?a=1&amp;b=2\">link</a>, local.\nNext line.\n\n" +
		"• one\n• two\n  • nested\n\n3. three\n\n<blockquote>quoted text</blockquote>\n\n<pre><code class=\"language-go\">if a &lt; b {}</code></pre>\n\n" +
		"<pre>Tool | 次数\n-----+-----\nrun  | 2</pre>\n\n&lt;div&gt;raw&lt;/div&gt;"
	if got[0].HTML != want {
		t.Fatalf("HTML:\n%s\nwant:\n%s", got[0].HTML, want)
	}
	if !strings.HasPrefix(got[0].Plain, "Title\n\nSome bold, it, gone and a<b> & link, local.") {
		t.Fatalf("plain: %s", got[0].Plain)
	}
}

func TestChunksSplitLongReplies(t *testing.T) {
	code := "```\n" + strings.Repeat("line <x>\n", 1000) + "```"
	got := chunks("intro\n\n"+code+"\n\n"+strings.Repeat("😀", 3000), 4000)
	for i, c := range got {
		if units(c.HTML) > 4000 {
			t.Fatalf("chunk %d has %d units", i, units(c.HTML))
		}
	}
	if !strings.HasPrefix(got[0].HTML, "intro\n\n<pre>line &lt;x&gt;") || !strings.HasSuffix(got[0].HTML, "</pre>") {
		t.Fatalf("first chunk: %.80s … %s", got[0].HTML, got[0].HTML[len(got[0].HTML)-20:])
	}
	var text strings.Builder
	for _, c := range got[:len(got)-2] {
		if !strings.HasPrefix(strings.TrimPrefix(c.HTML, "intro\n\n"), "<pre>") {
			t.Fatalf("code chunk lost its block: %.40s", c.HTML)
		}
		text.WriteString(c.Plain)
	}
	if n := strings.Count(text.String(), "line <x>"); n != 1000 {
		t.Fatalf("code lines kept: %d", n)
	}
	if emoji := got[len(got)-2].Plain + got[len(got)-1].Plain; emoji != strings.Repeat("😀", 3000) {
		t.Fatalf("long paragraph split badly: %d runes", len([]rune(emoji)))
	}
}

func TestFitKeepsEntitiesWhole(t *testing.T) {
	if n := fit("ab&amp;c", 4); n != 2 {
		t.Fatalf("fit cut an entity: %d", n)
	}
	if n := fit("😀😀", 3); n != len("😀") {
		t.Fatalf("fit cut a surrogate pair: %d", n)
	}
}

func TestChunksDropALanguageTagTooLongToFit(t *testing.T) {
	got := chunks("```"+strings.Repeat("x", 4000)+"\n"+strings.Repeat("code\n", 2000)+"```", 4000)
	if len(got) < 3 {
		t.Fatalf("chunks: %d", len(got))
	}
	for i, c := range got {
		if units(c.HTML) > 4000 || !strings.HasPrefix(c.HTML, "<pre>code") {
			t.Fatalf("chunk %d: %d units, %.40s", i, units(c.HTML), c.HTML)
		}
	}
	if n := fit("abc", 0); n != 1 {
		t.Fatalf("fit took nothing: %d", n)
	}
}
