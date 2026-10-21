# Coding agents

Mob hands coding work to outside coding agents and keeps track of it. Mob's
own model acts as the owner's project manager: it starts a task in a project,
reports how tasks are going and what waits for a decision, and passes on
instructions. The agent writes the code. Agents speak the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP); the code is in
`internal/agents`, on the official Go SDK `github.com/coder/acp-go-sdk`.

## Agents

| Agent | Started with | Signing in |
| --- | --- | --- |
| `codex` (default) | `codex-acp` when installed, otherwise `npx -y @zed-industries/codex-acp@0.16.0` | the ChatGPT subscription `codex login` saved on that computer (`codex login --device-auth` where it has no browser), or `OPENAI_API_KEY` / `CODEX_API_KEY` in the service's environment |
| `claude` (Claude Agent) | `claude-agent-acp` when installed, otherwise `npx -y @agentclientprotocol/claude-agent-acp@0.94.0` | the Claude subscription `claude` saved on that computer (run `claude` and `/login`), or `ANTHROPIC_API_KEY` in the service's environment |
| `dsh` (DeepSeek Harness) | `npx -y @deepseek-ai/dsh@0.2.1-rc.2 --profile acp` (only through `npx`, since other programs are also called `dsh`) | the DeepSeek API key saved in DeepSeek Harness (`npx @deepseek-ai/dsh web`, Models page), or `DEEPSEEK_API_KEY` in the service's environment |
| `codebuddy` (CodeBuddy Code) | `codebuddy --acp` when installed, otherwise `npx -y @tencent-ai/codebuddy-code@2.171.0 --acp` | the Tencent account `codebuddy` logged in with on that computer (WeChat for the China edition, Google or GitHub for the international one; the same account as WorkBuddy), or `CODEBUDDY_API_KEY` in the service's environment, with `CODEBUDDY_INTERNET_ENVIRONMENT=internal` for the China edition |

The agent runs on the computer Mob runs on, as the same user, with Mob's
environment minus its `MOB_*` variables. Mob keeps no agent credentials: the
agent uses its own sign-in. When it asks to sign in, Mob tries an
environment-variable method whose variable is set, and otherwise fails the
turn with how to sign in. Claude Agent only finds out it is not signed in
when it answers a prompt; that turn fails the same way. DeepSeek Harness asks
for no sign-in; without a key, its first prompt fails and says where to save
one. Mob never reads or passes on a DeepSeek key, including the one in its own
DeepSeek provider. Amp is planned next.

Mob starts DeepSeek Harness with its DeepSeek session-log upload plugin
disabled (a `--patch` layer in a temporary file only the service's user can
read, removed when the agent ends) and `DSH_TELEMETRY_MODE=DISABLED`, so what
the agent does is not sent to DeepSeek beyond the model requests themselves.
Its model is the ACP profile's default, `deepseek-v4-flash`.

Tencent's WorkBuddy desktop app offers no programmatic interface; CodeBuddy
Code, the command-line agent built on the same agent core, is how Mob reaches
it. Its login methods are interactive, so without a login (or
`CODEBUDDY_API_KEY`) starting a session fails with how to log in.

## Projects and tasks

- A project is a git repository on that computer, saved in the `projects`
  setting. `/projects add PATH [NAME]` saves one (named after its directory by
  default), `/projects remove NAME` forgets it, and `/projects` lists them.
  `task_start` also accepts the absolute path of a repository and saves it.
- A task is one piece of work for one agent. It gets its own branch,
  `mob/<title>-<id>`, checked out from the project's `HEAD` in a new worktree
  under `data_dir/worktrees/`, so tasks never touch the project's own checkout
  or each other. Stopping or finishing a task leaves its branch and worktree;
  merging and cleaning up are the owner's.
- Each task is a conversation, titled `<agent>: <title>`, listed with the
  others. The agent's replies stream into it like a model's: text, reasoning,
  and one line per tool call (`codex_execute`, `claude_edit`, `codex_read` and
  so on, after the agent and the call's ACP kind) that opens to show its input and output.
  The owner can write to it directly; only the owner can.
- Tasks are saved in the `tasks` table with their status: `running`,
  `waiting` (for the owner's approval), `review` (the agent finished what it
  was asked), `stopped` or `failed`, the agent's latest plan, and the
  conversation that started the task (`parent_id`; empty when none did).

## Mob as project manager

Owner-only tools:

- `task_start` (project, prompt, optional title and agent) asks the owner to
  approve, then creates the worktree and task and hands the prompt to the
  agent in a turn that runs on its own. Always allow covers the same project
  and agent. Its prompt tells the model to hand coding work to agents rather
  than do it itself.
- `tasks` lists the projects and tasks with status, branch, plan, the end of
  each task's latest reply and what its agent used (see Usage below).
- `task_message` passes instructions to a task's agent. While the agent is
  at work they are added to its conversation and sent once its current
  prompt ends. `task_stop` stops its turn and ends the agent.
- `task_diff` shows what a task changed since its branch began: its commits
  (up to 30), each changed file with lines added and removed (committed and
  not), untracked files, and on request the patch, whole or for one file, up
  to 24000 bytes. The patch includes new files the agent has not added to
  git, in full. The branch began where it meets the project's `HEAD`, so
  the project moving on does not show up as the task's change. It reads
  without approval.
- `task_check` runs a shell command, such as the tests or the build, in a
  task's worktree on the computer Mob runs on (`sh -c`, `cmd /C` on Windows),
  with Mob's environment minus its `MOB_*` variables, and returns the exit
  code and the last 32 KiB of its output. Every command asks for approval;
  Always allow covers the same command in the same project. A command still
  running after ten minutes is ended.

`task_start` is offered while an agent's command (or `npx`) is installed, or
once there is a project or task; the others once there is a project or task.
`/tasks [PROJECT]` shows the tasks in any client as a list nested by who
started whom, with each task's status, agent, title, project and branch.

## Agent tree

`GET /api/tasks[?project=NAME]` lists the tasks, each with the conversation
that started it, its agent's display name, the model it runs, what it used
(the conversation's [usage](#usage) summary), the decisions waiting in it, the kinds of tool its agent used (`read`, `edit`, `execute`,
`fetch` and so on) and the task itself. A Mob conversation that started tasks
is listed too, as agent `mob`: `waiting` while a decision waits in it (such
as `task_start` itself), `running` while it answers, otherwise `idle`. The
model is the one a running agent's session options select, otherwise the
model that used the most of the conversation's tokens; `/tasks` adds what
each one used.

The web UI's **Agents** page draws this as a tree: Mob's conversation on top,
the tasks it started fanned out in a row below it, and anything those tasks
started hanging under them. Lines with arrows run from each agent to the ones
it started, coloured by the started agent's status, with work flowing along
the line while it runs or waits. Each card shows the runtime's logo (Codex,
Claude Agent; Mob's calf for Mob), the model's logo and name, status (Running,
Needs you, Done, Failed, Stopped), the tools it used, the task's title,
project and branch, its cost and tokens (broken down by cache and model on
hover), its plan's progress and how long it took. Clicking a card
that started agents folds them away (it then shows how many are hidden) and
clicking again unfolds them; its arrow button opens its conversation.

A card that needs the owner shows up to two of its waiting decisions, each
with what is asked, and **Approve**, **Always allow** and **Deny…** (which
takes an optional reason); more are left to the conversation. A running or
waiting card has **Stop**, and a task's card has **Instruct**, which sends the
agent one more line while it runs. They use:

- `POST /api/conversations/{id}/decide` with `{id, approved, reason?,
  remember?}`: answers a waiting decision as the owner and resumes the turn
  (202; 409 when the decision is no longer waiting).
- `POST /api/tasks/{id}/stop`: stops the task (404 when there is none).
- `POST /api/tasks/{id}/message` with `{text}`: sends the running agent an
  instruction (202; 409 when the task is not running).

Mob's own card stops with `POST /api/conversations/{id}/stop`. The
header counts the agents, filters to what runs, needs the owner or failed,
and adds up what they all cost. The page reads the tree again every three seconds while it is shown.
Logos come from LobeHub's MIT-licensed `@lobehub/icons-static-svg`, inlined
into the page.

The owner's turns also read a snapshot of the tasks in their instructions, so
the model knows what is going on without calling `tasks` first: up to 15
tasks that are running, waiting, or ended (in review or failed) in the last
seven days, each with its status, title, ID, agent, project and branch.
Stopped tasks and other callers' turns get none. The snapshot changes when a
task does, which misses the prompt cache once.

## Reviewing finished work

A task remembers the conversation that started it (`tasks.parent_id`, also
used for the agent tree). When a task Mob's model started ends its turn in
review with something written, the model reviews the work in that
conversation before
the owner hears about it: a turn starts there with a note, saved as the
turn's message, saying it is an automatic update and asking the model to
check the work with `task_diff` and `task_check`, then tell the owner whether
it looks ready to merge, what is missing, and what they need to decide. It
may send the agent more work with `task_message` only when the task is
clearly not done.

When that turn ends, the owner gets one notice, "Task reviewed", with the
model's conclusion and any approval it waits for (such as a `task_check`
command), instead of the agent's own words. At most three reviews start on
their own for one task while Mob runs. A task with no parent, one another
task started (its agent checks it), one past its three reviews, or one whose
conversation is busy or has no model gets the agent's words in a "Task done"
notice as before. Failed tasks are not reviewed.

## Approvals

- Codex starts each session in its `auto` mode: it edits files and runs
  commands in the worktree without asking, and asks before using the network
  or writing elsewhere. Claude Agent starts in its `acceptEdits` mode: it
  edits files without asking and asks before running commands, so its
  commands are approvals in the task. CodeBuddy Code starts in its
  `acceptEdits` mode too. DeepSeek Harness has no modes: its own
  `workspace-write` sandbox lets it write in the worktree and asks before going
  further, offering only one-time answers. Mob also answers yes, without asking, to any edit,
  delete or move whose files are all inside the task's worktree once links
  are followed, so a link in the repository cannot lead an edit out of it.
- Every other permission the agent asks for is an approval in the task's
  conversation, decided like any other: Approve, Allow in this conversation,
  Always allow, or Deny with an optional reason, from any client. Allow and
  Always allow are remembered as grants for the call's tool name and title,
  and the agent is answered with its own "always" option. DeepSeek Harness
  and CodeBuddy Code send requests that name only the call they showed
  before; theirs are remembered for that call's title with its whole input,
  so remembering one command never allows another. A request with neither a
  title nor an input is allowed that once but never remembered.
- Unlike a model's tool call, the agent keeps waiting while an approval is
  pending. The turn that asked ends, and the decision starts a turn that
  follows the agent on; the approved call shows how it ended there. A denial with
  a reason cancels the agent's current prompt and sends the reason as its
  next one, so it does not work around the denial without knowing why.
- Writing to the task instead of deciding denies what waits and sends the
  message after the agent has dealt with the denial.
- An approval left for an hour expires, and the agent is told it was
  cancelled.

## Notices

When a task's turn ends waiting for an approval, done (unless Mob reviews it,
above) or failed, Mob raises a
`chat.Notice` (`ConversationService.Notify`): the task's agent and title, the
agent's last words (up to 1200 characters), its branch and what it used when
done, the error
when failed or stopped early (such as at the agent's limit, with how to
continue), and the approvals that wait. Stopping a task, even while its agent
is starting, raises none and leaves it stopped.
Messaging channels pass notices on; [Telegram](channels.md) sends them with
approval buttons, so the owner can follow and decide tasks from the phone. A
turn started from a channel, such as a decision tapped there, sends that
channel no notice, since its reply already says how the turn ended.

## Usage

What a task's agent used is recorded with Mob's own
[token usage](turns-and-context.md#token-usage) when each of its prompts ends,
so `/usage` in the task's conversation, the `Used` column of `/tasks`, the
`tasks` tool and the done notice show it.

- An agent that reports a prompt's usage in its response (ACP's unstable
  `usage`) is recorded as it says. Claude Agent does, with cache reads and
  writes, and its `_meta.quota.model_usage` splits it by model. Input is
  counted with the cache, as for Mob's own models; an agent whose total adds
  the cache to its input, as Claude Agent's does, is counted that way.
- Claude Agent also reports what its run has cost so far (`usage_update`);
  what it added since the last prompt is recorded as that prompt's cost.
- Codex (`codex-acp` 0.16) reports no tokens over ACP. Its ACP session is a
  Codex thread of the same ID, so Mob reads the thread's rollout file
  (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl`, `CODEX_HOME`
  defaulting to `~/.codex`): the last `token_count` total, less what the task
  already recorded for that session, is the prompt's (a session that replaces
  one that could not be loaded counts from zero, and the old one's usage
  stays), under the model of the last
  `turn_context`. Codex reports no cost.
- An agent that reports neither shows no usage, and a prompt stopped from
  Mob may record none. The code is in `internal/agents/usage.go`.

## Lifetime

- An agent process starts with the first turn that needs it and runs until the
  task is stopped or Mob stops; it runs in a process group of its own (a
  process tree on Windows), so what `npx` starts ends with it. Stopping a turn
  cancels the agent's prompt; an agent that does not end it within ten
  seconds is ended.
- When Mob starts, tasks still marked running or waiting are marked stopped:
  their agents ended with Mob. Deciding an approval no agent waits for any
  more starts nothing; the call is marked failed and the reply says to send
  the task a message to continue.
- When Mob starts an agent for a task that already has a session, it loads that
  session (Codex, Claude Agent and CodeBuddy Code support this), so the agent remembers the work; the history
  the agent replays while loading is not shown again. An agent that cannot
  load sessions but can resume them, as DeepSeek Harness, resumes it instead,
  without a replay.
- Delegated conversations reuse `ConversationService`: `SetDelegate` hands the
  turns of the conversations a `chat.Delegate` owns to it instead of the model
  loop, and `chat.DelegateTurn` writes and saves the reply as the engine does.
