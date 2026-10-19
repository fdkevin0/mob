# Skills

Skills are [Agent Skills](https://agentskills.io/specification): a directory
holding a `SKILL.md` of instructions for one kind of task, with optional
`scripts/`, `references/` and `assets/`. Mob reads the same format as other
agents, so a skill written for them works here. The package is
`internal/plugins/skills`.

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
- `/skills` lists the skills found and every warning.

## How the model uses them

- While any skill is found, the owner's turns are offered the `skill` tool, and
  the system prompt lists each skill's name and description. Only the listed
  names are accepted.
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

## Not yet

Installing skills from a source (`mob skills add`), the agent searching for and
installing skills itself, and skills served by MCP servers; the plan is in the
pull request that added this page.
