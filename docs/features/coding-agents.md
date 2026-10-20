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

The agent runs on the computer Mob runs on, as the same user, with Mob's
environment minus its `MOB_*` variables. Mob keeps no agent credentials: the
agent uses its own sign-in. When it asks to sign in, Mob tries an
environment-variable method whose variable is set, and otherwise fails the
turn with how to sign in. Claude and Amp are planned next.

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
  and one line per tool call (`codex_execute`, `codex_edit`, `codex_read` and
  so on, after the call's ACP kind) that opens to show its input and output.
  The owner can write to it directly; only the owner can.
- Tasks are saved in the `tasks` table with their status: `running`,
  `waiting` (for the owner's approval), `review` (the agent finished what it
  was asked), `stopped` or `failed`, and the agent's latest plan.

## Mob as project manager

Owner-only tools:

- `task_start` (project, prompt, optional title and agent) asks the owner to
  approve, then creates the worktree and task and hands the prompt to the
  agent in a turn that runs on its own. Always allow covers the same project
  and agent. Its prompt tells the model to hand coding work to agents rather
  than do it itself.
- `tasks` lists the projects and tasks with status, branch, plan and the end of
  each task's latest reply.
- `task_message` passes instructions to a task's agent. While the agent is
  at work they are added to its conversation and sent once its current
  prompt ends. `task_stop` stops its turn and ends the agent.

`task_start` is offered while an agent's command (or `npx`) is installed, or
once there is a project or task; the others once there is a project or task.
`/tasks [PROJECT]` shows the same table in the web UI and TUI.

## Approvals

- Codex starts each session in its `auto` mode: it edits files and runs
  commands in the worktree without asking, and asks before using the network
  or writing elsewhere. Mob also answers yes, without asking, to any edit,
  delete or move whose files are all inside the task's worktree once links
  are followed, so a link in the repository cannot lead an edit out of it.
- Every other permission the agent asks for is an approval in the task's
  conversation, decided like any other: Approve, Allow in this conversation,
  Always allow, or Deny with an optional reason, from any client. Allow and
  Always allow are remembered as grants for the call's tool name and title,
  and the agent is answered with its own "always" option.
- Unlike a model's tool call, the agent keeps waiting while an approval is
  pending. The turn that asked ends, and the decision starts a turn that
  follows the agent on; the approved call shows how it ended there. A denial with
  a reason cancels the agent's current prompt and sends the reason as its
  next one, so it does not work around the denial without knowing why.
- Writing to the task instead of deciding denies what waits and sends the
  message after the agent has dealt with the denial.
- An approval left for an hour expires, and the agent is told it was
  cancelled.

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
  session (Codex supports this), so the agent remembers the work; the history
  the agent replays while loading is not shown again.
- Delegated conversations reuse `ConversationService`: `SetDelegate` hands the
  turns of the conversations a `chat.Delegate` owns to it instead of the model
  loop, and `chat.DelegateTurn` writes and saves the reply as the engine does.
