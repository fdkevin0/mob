# Coding agents

Mob hands coding work to outside coding agents and keeps track of it. Mob's
own model acts as the owner's project manager: it starts a task in a project,
reports how tasks are going and what waits for a decision, and passes on
instructions. The agent writes the code. The code is in `apps/mob/src/agents`.

Mob drives every agent through one port, `runtime.ts`: a session that takes
prompts and reports text, reasoning, tool calls updated by their ID, plans,
context use and how each prompt ended with what it used, and asks permission
before calls. Its shapes follow ACP v2's. Each agent's preset names the runtime
behind the port. The default runtime is the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP, `acp.ts`, on the
official TypeScript SDK `@agentclientprotocol/sdk`), which Claude Agent,
DeepSeek Harness and CodeBuddy Code speak. Codex has a runtime of its own,
`codex.ts`, on Codex's app server (`codex app-server`, the protocol every
Codex surface is built on), since that reports what each turn used and its
ACP adapter does not. An agent whose own protocol does more than its ACP
adapter gets a runtime of its own the same way, without changing tasks,
approvals, the agent tree or usage.

## Getting started

1. Sign in to an agent on the computer Mob runs on, such as `codex login` for
   Codex (see [Agents](#agents) for the others).
2. Save a git repository as a project: `/projects add /path/to/my-app`, and
   optionally a check Mob runs on finished work: `/projects check my-app bun test`.
3. Ask Mob for the work in a conversation, such as "fix the failing login test
   in my-app". Mob proposes a task; approve it.
4. Follow the task on the **Agents** page or in its own conversation, and
   answer what it asks. When it is ready, Mob tells you with the branch, the
   checks and a review.

How a task is checked, reviewed and split into sub-tasks is in
[Task workflow](task-workflow.md); several tasks approved at once are
[Plans](plans.md).

## Agents

| Agent | Started with | Signing in |
| --- | --- | --- |
| `codex` (default) | `codex app-server` when `codex` is installed, otherwise `npx -y @openai/codex@0.166.0 app-server` | the ChatGPT subscription `codex login` saved on that computer (`codex login --device-auth` where it has no browser), or `OPENAI_API_KEY` / `CODEX_API_KEY` in the service's environment |
| `claude` (Claude Agent) | `claude-agent-acp` when installed, otherwise `npx -y @agentclientprotocol/claude-agent-acp@0.94.0` | the Claude subscription `claude` saved on that computer (run `claude` and `/login`), or `ANTHROPIC_API_KEY` in the service's environment |
| `dsh` (DeepSeek Harness) | `npx -y @deepseek-ai/dsh@0.2.1-rc.2 --profile acp` (only through `npx`, since other programs are also called `dsh`) | the DeepSeek API key saved in DeepSeek Harness (`npx @deepseek-ai/dsh web`, Models page), or `DEEPSEEK_API_KEY` in the service's environment |
| `codebuddy` (CodeBuddy Code) | `codebuddy --acp` when installed, otherwise `npx -y @tencent-ai/codebuddy-code@2.171.0 --acp` | the Tencent account `codebuddy` logged in with on that computer (WeChat for the China edition, Google or GitHub for the international one; the same account as WorkBuddy), or `CODEBUDDY_API_KEY` in the service's environment, with `CODEBUDDY_INTERNET_ENVIRONMENT=internal` for the China edition |

The agent runs on the computer Mob runs on, as the same user, with Mob's
environment minus its `MOB_*` variables. Mob keeps no agent credentials: the
agent uses its own sign-in. When it asks to sign in, Mob tries an
environment-variable method whose variable is set, and otherwise fails the
turn with how to sign in. Codex is asked for its account first: with none
saved and neither `OPENAI_API_KEY` nor `CODEX_API_KEY` set, the turn fails
the same way, as does a turn Codex ends as unauthorized. Claude Agent only finds out it is not signed in
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
  default), `/projects remove NAME` forgets it, and `/projects` lists them
  with their blueprint and checks (see [Blueprints](task-workflow.md#blueprints)).
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

Mob's instructions distinguish work on host projects (delegated over ACP)
from isolated calculations and skill scripts (run in the sandbox). Each
delegated prompt is asked to include the goal and project, scope and user
constraints, known evidence and decisions, and acceptance checks. Earlier
constraints still apply unless the user changes them; analysis-only tasks
must explicitly forbid file changes. The agent does not automatically receive
the parent conversation. Later corrections go to the existing task.

The brief asks the agent to read applicable project instructions, including
`AGENTS.md`, and report changes, verification and unfinished work. Reading and
following those files remains the external agent's responsibility; Mob does
not load them into its own system prompt. These are model instructions, not
additional runtime permissions or a guarantee that an agent follows them.

Owner-only tools:

- `task_start` (project, prompt, optional title, agent and blueprint) asks
  the owner to approve, showing the blueprint and what it does, then creates
  the worktree and task and hands the prompt to the agent in a turn that runs
  on its own. Always allow covers the same project, agent and blueprint. Its prompt tells the model to hand coding work to agents rather
  than do it itself. With `share` (a task's ID) the agent instead works
  read-only in that task's worktree and branch (see [Readers](task-workflow.md#readers)); Always
  allow then covers only that task.
- `task_plan` (project, an optional summary, and up to six tasks) asks the
  owner to approve them all at once, then starts each as `task_start` would.
  The web draws it as a flow the owner can review and change before
  approving; see [Plans](plans.md).
- `tasks` lists the projects and tasks with status, branch, plan, the end of
  each task's latest reply, the outcome and result its agent reported (see
  [Results](task-workflow.md#results)) and what its agent used (see [Usage](#usage)).
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
- `task_review` asks the owner to approve a review squad for a finished task
  (see [Review squads](task-workflow.md#review-squads)).

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
with everything it asks (one `field: value` line per input field, so an
agent's command shows rather than only its title), and **Approve**, **Always
allow** and **Deny…** (which takes an optional reason); more are left to the
conversation. A request with a field too long to show whole (`whole: false`)
can only be denied there and is approved from its conversation. A running or
waiting card has **Stop**, and a task's card has **Instruct**, which sends the
agent one more line while it runs. They use:

- `POST /api/conversations/{id}/decide` with `{id, approved, reason?,
  remember?}`: answers a waiting decision as the owner and resumes the turn
  (202; 409 when the decision is no longer waiting).
- `POST /api/tasks/{id}/stop`: stops the task (404 when there is none).
- `POST /api/tasks/{id}/message` with `{text}`: sends the running agent an
  instruction (202; 409 when the agent is still starting). A turn it starts
  ends when the token that sent it is revoked.

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

## Approvals

- Codex starts each thread with its `workspace-write` sandbox and the
  `on-request` approval policy: it edits files and runs commands in the
  worktree without asking, and asks before using the network or writing
  elsewhere. Mob answers its command, file change and permission requests;
  it declines the forms an MCP server asks Codex to fill in, and answers
  Codex's questions to the user with none. Claude Agent starts in its `acceptEdits` mode: it
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

When a task's turn ends waiting for an approval, done (unless Mob
[reviews it](task-workflow.md#reviewing-finished-work)) or failed, Mob raises a
`Notice` (`ConversationService.notify`): the task's agent and title, the
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
- Codex reports its thread's running total (`thread/tokenUsage/updated`);
  a turn's usage is the total at its end less the total before its first
  request, under the thread's model. Its context meter is the last
  request's tokens against the model's context window. Codex reports no cost.
- An agent that reports neither shows no usage, and a prompt stopped from
  Mob may record none. Each runtime reads its own: `acp.ts` and `codex.ts`.

## Project forms

**Agents → Manage projects** opens Web's **Manage Mob → Projects**. Add a
repository using its absolute path on the connected Mob (spaces are supported),
choose a blueprint, and edit checks as an ordered list of commands. Each check
may contain multiple lines. Saving checks authorizes their automatic execution
in finished tasks' worktrees; the form explains this before saving. Removing a
project requires confirmation and keeps its tasks, branches and worktrees.
The form and `/projects` use the same project service and blueprint validation.
Adding an already-saved name or repository path in the form reports an error;
it does not rename or replace the existing project.

Telegram's `/tasks [PROJECT]` and **More → Tasks** show paged task summaries.
Selecting a task switches to its conversation; the list does not execute task
configuration changes.
