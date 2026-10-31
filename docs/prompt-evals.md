# Prompt evaluations

`apps/mob/scripts/prompts/cases.ts` holds 20 synthetic scenarios with behavior
rubrics: language, missing context, tool failures, uncertain side effects,
external instructions, denial, tool discovery, delegation and summarization.
Capture the baseline **before** changing prompts, then capture the candidate:

```bash
bun apps/mob/scripts/prompt-eval.ts > /tmp/mob-prompts-before.json
# Edit prompts, then:
bun apps/mob/scripts/prompt-eval.ts > /tmp/mob-prompts-after.json
```

Capture uses the real engine, summary builder and tool definitions with an
in-memory store and a fake model. It calls no external service or tool. The
fixture environment offers sandbox and tool search; manager cases also offer
coding-agent tools. Email turn cases offer the production email tools and
their prompt guidance, but cannot access email configuration or execute sends.
This is a controlled fixture, not a user's live setup.
The host tests check deterministic capture and that replay never runs tools.

Replay is opt-in and uses an OpenAI-compatible Chat Completions endpoint:

```bash
bun apps/mob/scripts/prompt-eval.ts --input /tmp/mob-prompts-before.json --url http://localhost:1234/v1 --model MODEL > /tmp/mob-results-before.json
bun apps/mob/scripts/prompt-eval.ts --input /tmp/mob-prompts-after.json --url http://localhost:1234/v1 --model MODEL > /tmp/mob-results-after.json
```

For an authenticated endpoint, add `--key-file /path/to/key`; keys are not
included in reports. Replay sends fixture requests to the named endpoint and
may incur model charges. Each case makes one model decision or one summary;
proposed tool calls are recorded, never executed. It does not test ACP agents,
multi-step task completion or resumption after a generated summary.

Grade each rubric item as pass/fail with a short evidence note; do not infer a
pass from a tool's name alone or exact response wording. Compare paired cases
with the same model and settings and repeat runs to expose variability.
Reports record the source revision, a hash of each exact request, responses,
tool arguments, latency and provider-reported usage. Request hashes distinguish
uncommitted prompt changes too. Failed requests are recorded alongside the
other cases and make the command exit unsuccessfully; they are not behavior
scores, and their usage may be incomplete. Compare tokens and latency alongside rubric
results; calculate money only with the endpoint's applicable prices. Keep
reports outside the repository. Add a regression scenario when a real failure
reveals a missing constraint, using synthetic data rather than user transcripts.
