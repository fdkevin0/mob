package skills

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/fdkevin0/mob/internal/chat"
	"github.com/fdkevin0/mob/internal/llm"
	"github.com/fdkevin0/mob/internal/sandbox"
)

// copies is where loaded skills are copied in a sandbox workspace.
const copies = ".mob/skills"

// listed is how many skills the system prompt names; beyond it, the model
// finds them with tool_search.
const listed = 20

// Entries are the skills found now, for tool_search to find; none while the
// system prompt names them all.
func (l *Library) Entries() []chat.Entry {
	list, _ := l.Scan()
	if len(list) <= listed {
		return nil
	}
	entries := make([]chat.Entry, len(list))
	for i, s := range list {
		entries[i] = chat.Entry{Kind: "skill", Name: s.Name, Description: s.Description, Use: fmt.Sprintf("Call the skill tool with name %q.", s.Name), OwnerOnly: true}
	}
	return entries
}

// Tools is the skill tool, listing the skills found now; none while there
// are none.
func (l *Library) Tools() []chat.Tool {
	list, _ := l.Scan()
	if len(list) == 0 {
		return nil
	}
	names := make([]string, len(list))
	var catalog strings.Builder
	catalog.WriteString("Skills are task instructions the owner installed. When a task matches a skill's description, call the skill tool with its name before starting and follow what it returns.")
	if len(list) > listed {
		// Many skills are found with tool_search instead of filling the prompt.
		fmt.Fprintf(&catalog, " %d skills are installed; find the ones a task needs with tool_search.", len(list))
	} else {
		catalog.WriteString(" <available_skills>")
	}
	for i, s := range list {
		names[i] = s.Name
		if len(list) <= listed {
			fmt.Fprintf(&catalog, "<skill><name>%s</name><description>%s</description></skill>", s.Name, html.EscapeString(s.Description))
		}
	}
	if len(list) <= listed {
		catalog.WriteString("</available_skills>")
	}
	return []chat.Tool{{
		Tool: llm.Tool{
			Name:        "skill",
			Description: "Load a skill's instructions by name, or read one of its files by its path relative to the skill.",
			Parameters: map[string]any{"type": "object", "properties": map[string]any{
				"name": map[string]any{"type": "string", "enum": names},
				"path": map[string]any{"type": "string", "description": "A file in the skill, such as references/guide.md; omit it to load SKILL.md."},
			}, "required": []string{"name"}, "additionalProperties": false},
		},
		Prompt:    catalog.String(),
		OwnerOnly: true,
		Run:       l.run,
	}}
}

func (l *Library) run(_ context.Context, call chat.ToolCall) (any, error) {
	name, _ := call.Input["name"].(string)
	file, _ := call.Input["path"].(string)
	s, ok := l.Find(name)
	if !ok {
		return nil, fmt.Errorf("no skill is named %q", name)
	}
	if file != "" {
		return l.readFile(s, file)
	}
	return l.load(s, call.ConversationID)
}

// load returns the skill's instructions and files, and copies it into the
// conversation's sandbox workspace so its scripts can run there.
func (l *Library) load(s Skill, conversationID string) (string, error) {
	data, err := readText(s.Dir, "SKILL.md")
	if err != nil {
		return "", err
	}
	_, body, err := split(data)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "<skill_content name=%q>\n%s\n</skill_content>\n", s.Name, body)
	if s.Compatibility != "" {
		fmt.Fprintf(&b, "Compatibility: %s\n", s.Compatibility)
	}
	dir, err := resolve(s.Dir)
	if err != nil {
		return "", err
	}
	list, more := files(dir)
	if len(list) == 0 {
		return b.String(), nil
	}
	fmt.Fprintf(&b, "Files in the skill: %s", strings.Join(list, ", "))
	if more {
		b.WriteString(", and more")
	}
	b.WriteString(". Read one with the skill tool's path argument.")
	sandboxDir, err := l.copyToWorkspace(dir, s.Name, conversationID)
	switch {
	case err != nil:
		fmt.Fprintf(&b, " The skill could not be copied into the sandbox: %s.", err)
	case sandboxDir == "":
		b.WriteString(" The sandbox is off, so the skill's scripts cannot run.")
	default:
		fmt.Fprintf(&b, " The skill is copied to %s in the sandbox; resolve its relative paths there and run its scripts with the sandbox tool.", sandboxDir)
	}
	return b.String(), nil
}

// readFile returns one of the skill's text files.
func (l *Library) readFile(s Skill, file string) (string, error) {
	file = path.Clean(strings.ReplaceAll(file, "\\", "/"))
	if path.IsAbs(file) || file == ".." || strings.HasPrefix(file, "../") {
		return "", errors.New("path must be relative to the skill")
	}
	return readText(s.Dir, filepath.FromSlash(file))
}

// copyToWorkspace replaces the skill's copy in the conversation's workspace
// and returns where commands see it, or "" without a sandbox. Links and
// hidden entries are not copied.
func (l *Library) copyToWorkspace(dir, name, conversationID string) (string, error) {
	if l.Workspace == nil {
		return "", nil
	}
	workspace, err := l.Workspace(conversationID)
	if err != nil || workspace == "" {
		return "", err
	}
	// Commands control the workspace and may plant links in it, so every
	// write is resolved within it.
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return "", err
	}
	defer root.Close()
	target := path.Join(copies, name)
	if err := root.RemoveAll(target); err != nil {
		return "", err
	}
	source, err := os.OpenRoot(dir)
	if err != nil {
		return "", err
	}
	defer source.Close()
	count, size := 0, int64(0)
	err = fs.WalkDir(source.FS(), ".", func(rel string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if rel != "." && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		dest := path.Join(target, filepath.ToSlash(rel))
		if d.IsDir() {
			return root.MkdirAll(dest, 0700)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		count++
		if count > maxFiles || info.Size() > maxBytes-size {
			return fmt.Errorf("it has over %d files or %d MiB", maxFiles, maxBytes>>20)
		}
		mode := os.FileMode(0600)
		if info.Mode()&0111 != 0 {
			mode = 0700
		}
		n, err := copyFile(source, root, rel, dest, mode, maxBytes-size)
		size += n
		return err
	})
	if err != nil {
		_ = root.RemoveAll(target)
		return "", err
	}
	return path.Join(sandbox.Workdir, target), nil
}

func copyFile(source, root *os.Root, name, dest string, mode os.FileMode, limit int64) (int64, error) {
	in, err := source.Open(name)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() {
		return 0, fmt.Errorf("%s is not a file", name)
	}
	out, err := root.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, io.LimitReader(in, limit+1))
	if err == nil && n > limit {
		err = fmt.Errorf("skill exceeds %d MiB", maxBytes>>20)
	}
	if err != nil {
		out.Close()
		return n, err
	}
	return n, out.Close()
}

// resolve follows a linked skill directory, so walking it walks its files.
func resolve(dir string) (string, error) {
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	return resolved, nil
}

// Commands list the skills found and what was skipped.
func Commands(l *Library) []chat.Command {
	return []chat.Command{{
		CommandSpec: chat.CommandSpec{Name: "skills", Usage: "/skills", Summary: "Show the skills the model can load", Clients: chat.Interactive},
		OwnerOnly:   true,
		Run:         func(context.Context, chat.CommandCall) (chat.CommandResult, error) { return chat.Reply(l.describe()) },
	}}
}

func (l *Library) describe() string {
	list, problems := l.Scan()
	var b strings.Builder
	if len(list) == 0 {
		fmt.Fprintf(&b, "No skills found. Put skill directories, each with a SKILL.md, in %s.\n", strings.Join(l.Roots, " or "))
	} else {
		b.WriteString("| Skill | Description | Directory |\n| --- | --- | --- |\n")
		for _, s := range list {
			fmt.Fprintf(&b, "| %s | %s | %s |\n", chat.Cell(s.Name), chat.Cell(s.Description), chat.Cell(s.Dir))
		}
	}
	if len(problems) > 0 {
		b.WriteString("\n**Warnings**\n\n")
		for _, p := range problems {
			fmt.Fprintf(&b, "- %s: %s\n", p.Dir, p.Message)
		}
	}
	return b.String()
}
