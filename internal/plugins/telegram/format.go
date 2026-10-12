package telegram

import (
	"bytes"
	"html"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/mattn/go-runewidth"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	east "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// chunkLimit is the most UTF-16 code units of HTML in one message, below
// Telegram's 4096 for the text it parses out of it.
const chunkLimit = 4000

var markdown = goldmark.New(goldmark.WithExtensions(extension.Table, extension.Strikethrough))

// chunk is one message: HTML in the subset Telegram accepts, and the same
// text plain, to send if Telegram rejects the HTML.
type chunk struct{ HTML, Plain string }

// chunks renders Markdown as Telegram HTML in messages that each fit the
// limit, splitting between blocks, and within a block only when it alone is
// too long.
func chunks(markdownText string, limit int) []chunk {
	source := []byte(markdownText)
	doc := markdown.Parser().Parse(text.NewReader(source))
	var list []chunk
	var current strings.Builder
	flush := func() {
		if s := strings.TrimSpace(current.String()); s != "" {
			list = append(list, chunk{HTML: s, Plain: plain(s)})
		}
		current.Reset()
	}
	for n := doc.FirstChild(); n != nil; n = n.NextSibling() {
		block := strings.TrimSpace(renderBlock(n, source))
		if block == "" {
			continue
		}
		for _, part := range split(n, block, source, limit) {
			if current.Len() > 0 && units(current.String())+2+units(part) > limit {
				flush()
			}
			if current.Len() > 0 {
				current.WriteString("\n\n")
			}
			current.WriteString(part)
		}
	}
	flush()
	return list
}

// split is block in pieces that fit the limit: a code block becomes several
// code blocks, anything else plain text.
func split(n ast.Node, block string, source []byte, limit int) []string {
	if units(block) <= limit {
		return []string{block}
	}
	var lines []string
	open, end := "", ""
	if code, ok := n.(*ast.FencedCodeBlock); ok || n.Kind() == ast.KindCodeBlock {
		open, end = "<pre>", "</pre>"
		if ok && code.Language(source) != nil {
			open, end = `<pre><code class="language-`+html.EscapeString(string(code.Language(source)))+`">`, "</code></pre>"
		}
		lines = strings.SplitAfter(html.EscapeString(blockText(n, source)), "\n")
	} else {
		lines = strings.SplitAfter(html.EscapeString(plain(block)), "\n")
	}
	room := limit - units(open) - units(end)
	if room < limit/2 {
		// A language tag that long is not worth the room.
		open, end = "<pre>", "</pre>"
		room = limit - units(open) - units(end)
	}
	var parts []string
	var b strings.Builder
	for _, line := range lines {
		for units(line) > room {
			cut := fit(line, room)
			if b.Len() > 0 {
				parts, b = append(parts, open+b.String()+end), strings.Builder{}
			}
			parts = append(parts, open+line[:cut]+end)
			line = line[cut:]
		}
		if units(b.String())+units(line) > room {
			parts, b = append(parts, open+b.String()+end), strings.Builder{}
		}
		b.WriteString(line)
	}
	if b.Len() > 0 {
		parts = append(parts, open+b.String()+end)
	}
	return parts
}

// fit is how many bytes of s fit in room UTF-16 units without cutting a
// character or an HTML entity.
func fit(s string, room int) int {
	n, used := 0, 0
	for i, r := range s {
		w := utf16.RuneLen(r)
		if used+w > room {
			break
		}
		used += w
		n = i + len(string(r))
	}
	if amp := strings.LastIndexByte(s[:n], '&'); amp > 0 && !strings.Contains(s[amp:n], ";") {
		n = amp
	}
	if n == 0 && s != "" {
		// Always take a character, so that splitting ends.
		_, size := utf8.DecodeRuneInString(s)
		n = size
	}
	return n
}

// units is the length of s in UTF-16 code units, as Telegram counts.
func units(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

var tag = regexp.MustCompile(`<[^>]*>`)

// plain is the text of Telegram HTML.
func plain(s string) string { return html.UnescapeString(tag.ReplaceAllString(s, "")) }

// blockText is the raw lines of a leaf block such as a code block.
func blockText(n ast.Node, source []byte) string {
	var b bytes.Buffer
	lines := n.Lines()
	for i := 0; i < lines.Len(); i++ {
		segment := lines.At(i)
		b.Write(segment.Value(source))
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// renderBlock is a block in Telegram HTML, which has no headings, lists or
// tables: headings become bold lines, list items bulleted lines and tables
// aligned preformatted text.
func renderBlock(n ast.Node, source []byte) string {
	switch n := n.(type) {
	case *ast.Heading:
		return "<b>" + inline(n, source) + "</b>"
	case *ast.Paragraph, *ast.TextBlock:
		return inline(n, source)
	case *ast.FencedCodeBlock:
		code := html.EscapeString(blockText(n, source))
		if lang := n.Language(source); lang != nil {
			return `<pre><code class="language-` + html.EscapeString(string(lang)) + `">` + code + "</code></pre>"
		}
		return "<pre>" + code + "</pre>"
	case *ast.CodeBlock:
		return "<pre>" + html.EscapeString(blockText(n, source)) + "</pre>"
	case *ast.Blockquote:
		var parts []string
		for c := n.FirstChild(); c != nil; c = c.NextSibling() {
			// Telegram does not nest blocks in a quote.
			parts = append(parts, plainBlock(c, source))
		}
		return "<blockquote>" + html.EscapeString(strings.Join(parts, "\n\n")) + "</blockquote>"
	case *ast.List:
		return list(n, source, "")
	case *ast.ThematicBreak:
		return "———"
	case *ast.HTMLBlock:
		return html.EscapeString(blockText(n, source))
	case *east.Table:
		return table(n, source)
	}
	return html.EscapeString(string(n.Text(source)))
}

// plainBlock is a block's text without formatting.
func plainBlock(n ast.Node, source []byte) string { return plain(renderBlock(n, source)) }

func list(l *ast.List, source []byte, indent string) string {
	var lines []string
	number := l.Start
	for item := l.FirstChild(); item != nil; item = item.NextSibling() {
		marker := "• "
		if l.IsOrdered() {
			marker = strconv.Itoa(number) + ". "
			number++
		}
		first := true
		for c := item.FirstChild(); c != nil; c = c.NextSibling() {
			if sub, ok := c.(*ast.List); ok {
				lines = append(lines, list(sub, source, indent+"  "))
				continue
			}
			body := renderBlock(c, source)
			if first {
				body, first = indent+marker+body, false
			} else {
				body = indent + "  " + body
			}
			lines = append(lines, body)
		}
		if first {
			lines = append(lines, indent+marker)
		}
	}
	return strings.Join(lines, "\n")
}

// table is a table as preformatted text with its columns aligned.
func table(t *east.Table, source []byte) string {
	var rows [][]string
	for row := t.FirstChild(); row != nil; row = row.NextSibling() {
		var cells []string
		for cell := row.FirstChild(); cell != nil; cell = cell.NextSibling() {
			cells = append(cells, plain(inline(cell, source)))
		}
		rows = append(rows, cells)
	}
	var widths []int
	for _, row := range rows {
		for i, cell := range row {
			if i == len(widths) {
				widths = append(widths, 0)
			}
			widths[i] = max(widths[i], runewidth.StringWidth(cell))
		}
	}
	var b strings.Builder
	for r, row := range rows {
		for i, cell := range row {
			if i > 0 {
				b.WriteString(" | ")
			}
			if i < len(row)-1 {
				cell = runewidth.FillRight(cell, widths[i])
			}
			b.WriteString(cell)
		}
		b.WriteString("\n")
		if r == 0 && len(rows) > 1 {
			for i, w := range widths {
				if i > 0 {
					b.WriteString("-+-")
				}
				b.WriteString(strings.Repeat("-", w))
			}
			b.WriteString("\n")
		}
	}
	return "<pre>" + html.EscapeString(strings.TrimSuffix(b.String(), "\n")) + "</pre>"
}

// inline is the HTML of n's inline children.
func inline(n ast.Node, source []byte) string {
	var b strings.Builder
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		writeInline(&b, c, source)
	}
	return b.String()
}

func writeInline(b *strings.Builder, n ast.Node, source []byte) {
	switch n := n.(type) {
	case *ast.Text:
		b.WriteString(html.EscapeString(decoded(n.Segment.Value(source))))
		if n.HardLineBreak() || n.SoftLineBreak() {
			b.WriteString("\n")
		}
	case *ast.String:
		b.WriteString(html.EscapeString(string(n.Value)))
	case *ast.CodeSpan:
		b.WriteString("<code>" + html.EscapeString(string(n.Text(source))) + "</code>")
	case *ast.Emphasis:
		t := "i"
		if n.Level == 2 {
			t = "b"
		}
		b.WriteString("<" + t + ">" + inline(n, source) + "</" + t + ">")
	case *east.Strikethrough:
		b.WriteString("<s>" + inline(n, source) + "</s>")
	case *ast.Link:
		b.WriteString(anchor(string(n.Destination), inline(n, source)))
	case *ast.AutoLink:
		url := string(n.URL(source))
		if n.AutoLinkType == ast.AutoLinkEmail {
			b.WriteString(html.EscapeString(url))
			return
		}
		b.WriteString(anchor(url, html.EscapeString(url)))
	case *ast.Image:
		label := inline(n, source)
		if label == "" {
			label = html.EscapeString(string(n.Destination))
		}
		b.WriteString(anchor(string(n.Destination), label))
	case *ast.RawHTML:
		for i := 0; i < n.Segments.Len(); i++ {
			segment := n.Segments.At(i)
			b.WriteString(html.EscapeString(string(segment.Value(source))))
		}
	default:
		b.WriteString(inline(n, source))
	}
}

// decoded is Markdown text as it reads: backslash escapes and entities
// resolved.
func decoded(text []byte) string {
	return string(util.ResolveEntityNames(util.ResolveNumericReferences(util.UnescapePunctuations(text))))
}

// anchor links label to url when Telegram would accept the link, and is the
// label alone otherwise.
func anchor(url, label string) string {
	lower := strings.ToLower(url)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") && !strings.HasPrefix(lower, "tg://") {
		return label
	}
	return `<a href="` + html.EscapeString(url) + `">` + label + "</a>"
}
