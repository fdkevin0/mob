# Skills

Skills are [Agent Skills](https://agentskills.io/specification): a directory
holding a `SKILL.md` of instructions for one kind of task, with optional
`scripts/`, `references/` and `assets/`. Mob reads the same format as other
agents, so a skill written for them works here. The code is in
`apps/mob/src/skills`.

## Where skills come from

Mob looks in two directories, in order:

1. `data_dir/skills/`, Mob's own;
2. `~/.agents/skills/`, shared with other agents that follow the convention.

Each skill is a directory directly inside one of them; a link to a directory
counts, as installers often link skills in. They are read again on every turn,
so adding or removing a skill needs no restart. At most 100 skills are offered
from each directory.

- `SKILL.md` starts with YAML frontmatter. `name` (up to 64 lowercase letters,
  digits and single hyphens) and `description` are required; `compatibility` is
  shown when the skill is loaded. Other fields, `allowed-tools` included, are
  ignored and grant nothing.
- Frontmatter that is not valid YAML only because a value holds an unquoted
  colon is read anyway. A name that differs from its directory is a warning.
- A skill without a description or a valid name is skipped. A name already
  found in an earlier directory is skipped too, so Mob's own skills win.
- `/skills` lists the skills found and every warning. Web's **Manage Mob → Skills**
  shows the same catalog as read-only cards, with descriptions, compatibility,
  source directories and scan warnings. Refresh rescans the installed skills.

## How the model uses them

- While any skill is found, the owner's turns are offered the `skill` tool, and
  the system prompt lists each skill's name and description. Only found names
  are accepted.
- With more than 20 skills the prompt only says how many there are, the
  `skill` tool no longer lists every name, and the model finds the ones a task needs with
  [`tool_search`](tools-and-approvals.md#exposure-and-tool_search), which
  returns each match's description and the `skill` call that loads it.
- `skill` with a name returns the instructions without frontmatter, wrapped in
  `<skill_content name="...">`, and lists the skill's other files (up to 100,
  hidden entries left out). With a `path` it returns one of those files as text,
  up to 256 KiB. Paths and links may not lead out of the skill.
- Loading a skill runs at once, without approval: skills are installed by the
  owner, as MCP servers are configured by the owner.
- With the [sandbox](sandbox.md) on, loading a skill also copies it to
  `/workspace/.mob/skills/<name>` in the conversation's workspace, replacing an
  earlier copy, and the model runs its scripts there with the `sandbox` tool.
  Links and hidden entries are not copied, and a skill over 512 files or 16 MiB
  is not copied at all. Reads and copies enforce byte limits while reading,
  including when files grow; copying cannot follow a path outside the source
  skill or destination workspace. With the sandbox off the model is told the scripts
  cannot run. Scripts never run on the host.
- A loaded skill is a tool output like any other: when it is cleared to fit the
  context window the model is told to load it again.

## Web management and installation

Open **Plugins & cloud services → Skills** to search installed skills, read their
instructions, and see scan warnings. **Discover** offers a small selection and
public GitHub repositories: enter `owner/repo`, optionally a branch or tag, then
find and select a `SKILL.md` or enter its path. Preview shows the instructions,
files and resolved commit before installation. A skill's format being compatible
does not mean tools specific to another agent are available in Mob.

Installation downloads that exact commit into `data_dir/skills/`, never runs
installation scripts, and refuses links, unsafe paths, incomplete repository
trees, more than 512 files or more than 16 MiB. Files are staged before becoming
visible; cancelled or failed downloads are discarded. Remote operations have
a 45-second overall deadline. An existing skill, including one in the shared directory, is never
overwritten. Removal is available only for skills Mob installed in its own
directory; it deletes those files, including local edits. Shared or symlinked
skills remain managed by their original installer.

These operations run on the connected Mob service, including when the browser
is on another machine. They are unavailable in the browser-only runner.

## Lock files and update checks

Mob writes `data_dir/.skill-lock.json` using the `npx skills` global lock format
v3: source, source type, source URL, optional ref, path to `SKILL.md`, GitHub folder
tree SHA, and installation/update timestamps. This is a separate lock for Mob's
own files; it does not change where `npx skills` installs or discovers skills.
Unknown fields in a compatible Mob lock are preserved when entries change.

For shared skills Mob reads the CLI's global lock at
`$XDG_STATE_HOME/skills/.skill-lock.json` when `XDG_STATE_HOME` is set, otherwise
`~/.agents/.skill-lock.json`. Shared locks are never written. A shared entry is
not applied to a same-named skill in Mob's directory.

**Check for updates** compares the recorded folder tree SHA with GitHub at the
recorded ref, or the default branch when no ref was recorded. Changes to scripts
or references count, while unrelated changes elsewhere in the repository do not.
Requests for the same repository and ref are shared within a check. Results
distinguish current, changes available, unknown source, and request failure.
Checking does not modify files, refresh the baseline hash, or install updates;
it compares upstream with the recorded installation, not with local edits.

Only public GitHub sources with usable global v3 lock entries can be checked.
The project `skills-lock.json` v1 format uses a different, content-based hash;
Mob does not load project-scoped skills or compare that hash to a Git tree SHA.
Invalid and unsupported locks are reported rather than overwritten. GitHub
requests currently use its unauthenticated API and can hit its rate limit;
failures are shown rather than treated as an up-to-date result.

## Not yet

The `mob skills add` CLI, applying updates in place, private repositories,
project-scoped skills, the agent installing skills itself, and skills served by
MCP servers.
