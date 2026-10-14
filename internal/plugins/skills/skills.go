// Package skills gives the model Agent Skills (agentskills.io): directories
// holding a SKILL.md of instructions for one kind of task, with optional
// scripts, references and assets. The model sees each skill's name and
// description, loads a skill's instructions with the skill tool when a task
// matches, and reads its other files on demand. Scripts run only in the
// sandbox, from a copy of the skill in the conversation's workspace.
package skills

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

const (
	// maxSkills bounds how many skills one root offers.
	maxSkills = 100
	// maxText bounds a SKILL.md, or another file the model reads, in bytes.
	maxText = 256 << 10
	// maxFiles and maxBytes bound a skill copied into a workspace, as the MCP
	// skills extension bounds one skill.
	maxFiles = 512
	maxBytes = 16 << 20
	// maxListed bounds the files listed when a skill is loaded.
	maxListed = 100
)

var validName = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// Skill is one skill found in a root.
type Skill struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	Compatibility string `json:"compatibility,omitempty"`
	// Dir is the skill's directory; a symlinked skill keeps its link's path.
	Dir string `json:"dir"`
}

// Problem is a skill directory that was skipped, or loaded with a warning.
type Problem struct {
	Dir     string `json:"dir"`
	Message string `json:"message"`
}

// Library finds skills in its roots each time it is asked, so a skill
// installed or removed while Mob runs counts from the next turn.
type Library struct {
	// Roots are searched in order; a name found in an earlier root shadows
	// later ones. Set them before serving.
	Roots []string
	// Workspace is the host directory of a conversation's sandbox workspace,
	// or "" when no sandbox is set.
	Workspace func(conversationID string) (string, error)
}

// Roots are where Mob looks for skills: its own, under the data directory,
// then the cross-client ~/.agents/skills.
func Roots(dataDir string) []string {
	roots := []string{filepath.Join(dataDir, "skills")}
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, filepath.Join(home, ".agents", "skills"))
	}
	return roots
}

// Scan lists the skills in every root, by name within each root, and what
// was skipped or loaded with a warning.
func (l *Library) Scan() ([]Skill, []Problem) {
	var found []Skill
	var problems []Problem
	seen := map[string]string{}
	for _, root := range l.Roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				problems = append(problems, Problem{root, err.Error()})
			}
			continue
		}
		count := 0
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			dir := filepath.Join(root, e.Name())
			// Installers often link a skill in from elsewhere, so a link to a
			// directory counts.
			if info, err := os.Stat(dir); err != nil || !info.IsDir() {
				continue
			}
			if count == maxSkills {
				problems = append(problems, Problem{root, fmt.Sprintf("only the first %d skills are offered", maxSkills)})
				break
			}
			s, warning, err := read(dir)
			if err != nil {
				if !errors.Is(err, fs.ErrNotExist) {
					problems = append(problems, Problem{dir, err.Error()})
				}
				continue
			}
			if warning != "" {
				problems = append(problems, Problem{dir, warning})
			}
			if first, ok := seen[s.Name]; ok {
				problems = append(problems, Problem{dir, "skipped: " + s.Name + " is already offered from " + first})
				continue
			}
			seen[s.Name] = dir
			found = append(found, s)
			count++
		}
	}
	return found, problems
}

// Find is the skill offered under name.
func (l *Library) Find(name string) (Skill, bool) {
	list, _ := l.Scan()
	i := slices.IndexFunc(list, func(s Skill) bool { return s.Name == name })
	if i < 0 {
		return Skill{}, false
	}
	return list[i], true
}

// read parses dir's SKILL.md. A skill whose name differs from its directory's
// loads with a warning, as other clients' skills often do; one without a
// usable name or a description is skipped.
func read(dir string) (Skill, string, error) {
	data, err := readText(dir, "SKILL.md")
	if err != nil {
		return Skill{}, "", err
	}
	meta, _, err := split(data)
	if err != nil {
		return Skill{}, "", err
	}
	s := Skill{Name: str(meta["name"]), Description: strings.TrimSpace(str(meta["description"])), Compatibility: str(meta["compatibility"]), Dir: dir}
	if s.Description == "" {
		return s, "", errors.New("skipped: SKILL.md has no description")
	}
	if !validName.MatchString(s.Name) || len(s.Name) > 64 {
		return s, "", fmt.Errorf("skipped: name %q must be up to 64 lowercase letters, digits and single hyphens", s.Name)
	}
	if len(s.Description) > 1024 {
		s.Description = s.Description[:1024]
	}
	warning := ""
	if s.Name != filepath.Base(dir) {
		warning = fmt.Sprintf("name %q differs from its directory", s.Name)
	}
	return s, warning, nil
}

// split separates SKILL.md's YAML frontmatter from its body.
func split(data string) (map[string]any, string, error) {
	data = strings.TrimPrefix(strings.ReplaceAll(data, "\r\n", "\n"), "\uFEFF")
	rest, ok := strings.CutPrefix(data, "---\n")
	if !ok {
		return nil, "", errors.New("skipped: SKILL.md does not start with --- frontmatter")
	}
	front, body, ok := strings.Cut(rest, "\n---")
	if !ok {
		return nil, "", errors.New("skipped: SKILL.md frontmatter is not closed with ---")
	}
	// The closing line may carry trailing spaces; the body starts after it.
	if _, after, found := strings.Cut(body, "\n"); found {
		body = after
	} else {
		body = ""
	}
	var meta map[string]any
	if err := yaml.Unmarshal([]byte(front), &meta); err != nil {
		// Skills written for other clients often leave a colon unquoted, as in
		// "description: Use when: ...".
		if err = yaml.Unmarshal([]byte(quote(front)), &meta); err != nil {
			return nil, "", errors.New("skipped: SKILL.md frontmatter is not YAML")
		}
	}
	return meta, strings.TrimSpace(body), nil
}

// quote turns each top-level "key: value" whose value holds a colon into a
// block scalar.
func quote(front string) string {
	lines := strings.Split(front, "\n")
	for i, line := range lines {
		key, value, ok := strings.Cut(line, ": ")
		if !ok || key == "" || strings.ContainsAny(key, " \t\"'") || !strings.Contains(value, ":") || strings.ContainsAny(value[:1], "\"'|>") {
			continue
		}
		lines[i] = key + ": |-\n  " + value
	}
	return strings.Join(lines, "\n")
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// readText reads a text file of at most maxText bytes inside dir; name may
// not lead out of it, through links either.
func readText(dir, name string) (string, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return "", err
	}
	defer root.Close()
	f, err := root.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a file", name)
	}
	if info.Size() > maxText {
		return "", fmt.Errorf("%s is %d bytes, over the %d a skill file may have", name, info.Size(), maxText)
	}
	var b bytes.Buffer
	if _, err := b.ReadFrom(f); err != nil {
		return "", err
	}
	if !utf8.Valid(b.Bytes()) {
		return "", fmt.Errorf("%s is not text", name)
	}
	return b.String(), nil
}

// files lists the skill's regular files other than SKILL.md, relative to its
// directory, skipping hidden entries.
func files(dir string) ([]string, bool) {
	var list []string
	more := false
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(dir, path)
		if rel != "." && strings.HasPrefix(d.Name(), ".") || d.Name() == "node_modules" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || rel == "SKILL.md" {
			return nil
		}
		if len(list) == maxListed {
			more = true
			return filepath.SkipAll
		}
		list = append(list, filepath.ToSlash(rel))
		return nil
	})
	return list, more
}
