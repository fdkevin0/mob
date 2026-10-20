package skills

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fdkevin0/mob/internal/chat"
)

func write(t *testing.T, path, text string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), mode); err != nil {
		t.Fatal(err)
	}
}

func call(t *testing.T, l *Library, input map[string]any) (string, error) {
	t.Helper()
	tools := l.Tools()
	if len(tools) != 1 {
		t.Fatalf("tools = %d", len(tools))
	}
	out, err := tools[0].Run(context.Background(), chat.ToolCall{ConversationID: "abc123", Input: input})
	s, _ := out.(string)
	return s, err
}

func TestScanParsesShadowsAndWarns(t *testing.T) {
	mine, shared := t.TempDir(), t.TempDir()
	write(t, filepath.Join(mine, "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Fill PDF forms.\n---\n# PDF\nUse scripts/fill.py.\n", 0600)
	write(t, filepath.Join(shared, "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Another PDF skill.\n---\nbody", 0600)
	// Unquoted colons are common in skills written for other clients.
	write(t, filepath.Join(shared, "review", "SKILL.md"), "\uFEFF---\r\nname: code-review\r\ndescription: Use when: the user asks for a review\r\n---\r\nReview.", 0600)
	write(t, filepath.Join(shared, "empty", "SKILL.md"), "---\nname: empty\n---\nbody", 0600)
	write(t, filepath.Join(shared, "Bad", "SKILL.md"), "---\nname: Bad\ndescription: x\n---\n", 0600)
	write(t, filepath.Join(shared, "plain", "README.md"), "not a skill", 0600)
	l := &Library{Roots: []string{mine, shared, filepath.Join(t.TempDir(), "missing")}}

	list, problems := l.Scan()
	if len(list) != 2 || list[0].Name != "pdf" || list[0].Dir != filepath.Join(mine, "pdf") || list[1].Name != "code-review" || list[1].Description != "Use when: the user asks for a review" {
		t.Fatalf("skills = %+v", list)
	}
	text := ""
	for _, p := range problems {
		text += p.Dir + ": " + p.Message + "\n"
	}
	for _, want := range []string{"already offered from " + filepath.Join(mine, "pdf"), `"code-review" differs from its directory`, "has no description", `name "Bad"`} {
		if !strings.Contains(text, want) {
			t.Errorf("problems lack %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "missing") || strings.Contains(text, "plain") {
		t.Errorf("a missing root or a directory without SKILL.md is not a problem:\n%s", text)
	}
}

func TestToolOffersCatalogAndLoads(t *testing.T) {
	root, workspace := t.TempDir(), t.TempDir()
	dir := filepath.Join(root, "pdf")
	write(t, filepath.Join(dir, "SKILL.md"), "---\nname: pdf\ndescription: Fill <PDF> forms.\ncompatibility: Requires Python\n---\n# PDF\nRun scripts/fill.py.\n", 0600)
	write(t, filepath.Join(dir, "scripts", "fill.py"), "print('ok')\n", 0700)
	write(t, filepath.Join(dir, "references", "forms.md"), "Forms guide", 0600)
	write(t, filepath.Join(dir, ".git", "HEAD"), "ref", 0600)
	l := &Library{Roots: []string{root}}
	if (&Library{Roots: []string{t.TempDir()}}).Tools() != nil {
		t.Fatal("no skills must offer no tool")
	}
	tool := l.Tools()[0]
	if !tool.OwnerOnly || !strings.Contains(tool.Prompt, "<skill><name>pdf</name><description>Fill &lt;PDF&gt; forms.</description></skill>") {
		t.Fatalf("tool = %+v", tool)
	}

	out, err := call(t, l, map[string]any{"name": "pdf"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"<skill_content name=\"pdf\">\n# PDF\nRun scripts/fill.py.\n</skill_content>", "Compatibility: Requires Python", "references/forms.md, scripts/fill.py", "sandbox is off"} {
		if !strings.Contains(out, want) {
			t.Errorf("load lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "name: pdf") || strings.Contains(out, ".git") {
		t.Errorf("load must strip frontmatter and hidden files:\n%s", out)
	}

	l.Workspace = func(id string) (string, error) {
		return filepath.Join(workspace, id), os.MkdirAll(filepath.Join(workspace, id), 0700)
	}
	// A stale copy is replaced.
	write(t, filepath.Join(workspace, "abc123", ".mob", "skills", "pdf", "old.txt"), "stale", 0600)
	out, err = call(t, l, map[string]any{"name": "pdf"})
	if err != nil || !strings.Contains(out, "/workspace/.mob/skills/pdf") {
		t.Fatalf("load with sandbox = %q, %v", out, err)
	}
	copied := filepath.Join(workspace, "abc123", ".mob", "skills", "pdf")
	if info, err := os.Stat(filepath.Join(copied, "scripts", "fill.py")); err != nil || info.Mode()&0100 == 0 {
		t.Fatalf("script copy: %v %v", info, err)
	}
	if _, err := os.Stat(filepath.Join(copied, "old.txt")); !os.IsNotExist(err) {
		t.Fatal("stale copy kept")
	}
	if _, err := os.Stat(filepath.Join(copied, ".git")); !os.IsNotExist(err) {
		t.Fatal("hidden entries copied")
	}

	if out, err := call(t, l, map[string]any{"name": "pdf", "path": "references/forms.md"}); err != nil || out != "Forms guide" {
		t.Fatalf("read = %q, %v", out, err)
	}
	for _, bad := range []string{"../pdf/SKILL.md", "/etc/passwd", "references/../../x"} {
		if _, err := call(t, l, map[string]any{"name": "pdf", "path": bad}); err == nil {
			t.Errorf("read %q must fail", bad)
		}
	}
	if _, err := call(t, l, map[string]any{"name": "nope"}); err == nil {
		t.Fatal("unknown skill must fail")
	}
}

func TestManySkillsAreFoundBySearch(t *testing.T) {
	root := t.TempDir()
	for i := range listed {
		name := fmt.Sprintf("skill-%02d", i)
		write(t, filepath.Join(root, name, "SKILL.md"), "---\nname: "+name+"\ndescription: Does task "+name+".\n---\nbody", 0600)
	}
	l := &Library{Roots: []string{root}}
	if l.Entries() != nil {
		t.Fatal("skills the prompt names are entries too")
	}
	write(t, filepath.Join(root, "last", "SKILL.md"), "---\nname: last\ndescription: The last one.\n---\nbody", 0600)
	tool := l.Tools()[0]
	if strings.Contains(tool.Prompt, "<available_skills>") || !strings.Contains(tool.Prompt, "21 skills are installed") {
		t.Fatalf("prompt: %s", tool.Prompt)
	}
	if names := tool.Parameters["properties"].(map[string]any)["name"].(map[string]any)["enum"].([]string); len(names) != listed+1 {
		t.Fatalf("enum: %v", names)
	}
	entries := l.Entries()
	if len(entries) != listed+1 || entries[0].Kind != "skill" || entries[0].Name != "last" || !entries[0].OwnerOnly || entries[0].Use != `Call the skill tool with name "last".` {
		t.Fatalf("entries: %+v", entries)
	}
}

func TestLinksStayInside(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	write(t, filepath.Join(outside, "secret"), "secret", 0600)
	real := filepath.Join(t.TempDir(), "notes")
	write(t, filepath.Join(real, "SKILL.md"), "---\nname: notes\ndescription: Notes.\n---\nRead guide.md.", 0600)
	write(t, filepath.Join(real, "guide.md"), "guide", 0600)
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(real, "leak")); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	// Installers link skills in from elsewhere.
	if err := os.Symlink(real, filepath.Join(root, "notes")); err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	l := &Library{Roots: []string{root}, Workspace: func(string) (string, error) { return workspace, nil }}
	out, err := call(t, l, map[string]any{"name": "notes"})
	if err != nil || !strings.Contains(out, "Files in the skill: guide.md.") {
		t.Fatalf("load = %q, %v", out, err)
	}
	if _, err := os.Lstat(filepath.Join(workspace, ".mob", "skills", "notes", "leak")); !os.IsNotExist(err) {
		t.Fatal("links must not be copied")
	}
	if _, err := call(t, l, map[string]any{"name": "notes", "path": "leak"}); err == nil {
		t.Fatal("a link out of the skill must not be read")
	}
}

func TestCommandDescribes(t *testing.T) {
	root := t.TempDir()
	l := &Library{Roots: []string{root}}
	if !strings.Contains(l.describe(), "No skills found. Put skill directories, each with a SKILL.md, in "+root) {
		t.Fatal(l.describe())
	}
	write(t, filepath.Join(root, "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Fill forms.\n---\n", 0600)
	write(t, filepath.Join(root, "x", "SKILL.md"), "no frontmatter", 0600)
	got := l.describe()
	if !strings.Contains(got, "| pdf | Fill forms. |") || !strings.Contains(got, "does not start with --- frontmatter") {
		t.Fatal(got)
	}
}

func TestCopyFileConfinesSourceAndBoundsReads(t *testing.T) {
	dir, workspace, outside := t.TempDir(), t.TempDir(), t.TempDir()
	write(t, filepath.Join(dir, "script"), "123456", 0600)
	write(t, filepath.Join(outside, "secret"), "secret", 0600)
	source, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	target, err := os.OpenRoot(workspace)
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	if n, err := copyFile(source, target, "script", "bounded", 0600, 3); err == nil || n != 4 {
		t.Fatalf("bounded copy = %d, %v", n, err)
	}
	// Replace an already discovered file before copying it.
	if err := os.Remove(filepath.Join(dir, "script")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(dir, "script")); err != nil {
		t.Fatal(err)
	}
	if _, err := copyFile(source, target, "script", "leak", 0600, maxBytes); err == nil {
		t.Fatal("source link escape accepted")
	}
	if _, err := os.Stat(filepath.Join(workspace, "leak")); !os.IsNotExist(err) {
		t.Fatal("source escape created an output")
	}
}

func TestCopyLimitsCleanUpAndWorkspaceLinksStayInside(t *testing.T) {
	for _, kind := range []string{"bytes", "files", "workspace-link"} {
		t.Run(kind, func(t *testing.T) {
			dir, workspace := t.TempDir(), t.TempDir()
			write(t, filepath.Join(dir, "SKILL.md"), "instructions", 0600)
			switch kind {
			case "bytes":
				f, err := os.Create(filepath.Join(dir, "large"))
				if err != nil {
					t.Fatal(err)
				}
				if err := f.Truncate(maxBytes); err != nil {
					t.Fatal(err)
				}
				f.Close()
			case "files":
				for i := range maxFiles {
					write(t, filepath.Join(dir, fmt.Sprint(i)), "", 0600)
				}
			case "workspace-link":
				outside := t.TempDir()
				write(t, filepath.Join(outside, "skills", "notes", "keep"), "keep", 0600)
				if err := os.Symlink(outside, filepath.Join(workspace, ".mob")); err != nil {
					t.Fatal(err)
				}
				defer func() {
					if data, err := os.ReadFile(filepath.Join(outside, "skills", "notes", "keep")); err != nil || string(data) != "keep" {
						t.Fatalf("outside file changed: %q, %v", data, err)
					}
				}()
			}
			l := &Library{Workspace: func(string) (string, error) { return workspace, nil }}
			if _, err := l.copyToWorkspace(dir, "notes", "abc123"); err == nil {
				t.Fatal("unsafe or oversized copy succeeded")
			}
			if kind != "workspace-link" {
				if _, err := os.Stat(filepath.Join(workspace, ".mob", "skills", "notes")); !os.IsNotExist(err) {
					t.Fatal("partial copy remains")
				}
			}
		})
	}
}
