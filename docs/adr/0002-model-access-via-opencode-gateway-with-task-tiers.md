# ADR 0002 — Model access via OpenCode gateway, ranked by task tier

- Status: Accepted
- Date: 2026-06-19
- Deciders: fdkevin (grilling session)

## Context

Mob runs many LLM calls per deliberation (personas × turns × rounds, plus orchestration
and synthesis), so cost and model choice are load-bearing. We want per-role model control
without hardcoding a specific model or provider into the deliberation logic, and we want to
swap/A-B models centrally.

## Decision

1. **Model access goes through OpenCode as a provider-agnostic gateway** (product name
   "OpenCode Go" — a SKU name, *not* the Go language). The Python/LangChain backend
   (ADR 0001) calls models through OpenCode; OpenCode handles provider routing, auth, and
   the model catalog.
2. **The app references task tiers, not concrete models.** Tier → concrete model is bound in
   OpenCode config and swappable without redeploying the backend. Four tiers, ranked by the
   capability each task needs:

   | Tier | Task / role | Rationale | Volume |
   |------|-------------|-----------|--------|
   | **T1 — Flagship** | Synthesis (final answer + tensions + dissents) | The deliverable; highest stakes; once per deliberation | Lowest |
   | **T2 — High** | Orchestrator / moderator (turn-taking, pacing, convergence) | Drives debate quality; runs every turn | Medium |
   | **T3 — Standard** | Persona debate turns | Personality + reasoning; volume-heavy, cost-sensitive | Highest |
   | **T4 — Fast** | Utility (titles, "suggest a cast", light classification, cheap "gut-reaction" persona) | Low-stakes, latency-sensitive | Bursty |

3. **Persona's `model` field names a tier** (default T3), overridable to T4 (fast contrarian)
   or T1 (heavyweight expert). Orchestrator is pinned to T2, synthesizer to T1, independent
   of the cast.
4. **Suggested default bindings** (configurable in OpenCode, can be Claude or other):
   T1 → a flagship model (e.g. Claude Opus 4.8), T2 → high (e.g. Claude Opus 4.8 / Sonnet 4.6),
   T3 → standard (e.g. Claude Sonnet 4.6), T4 → fast (e.g. Claude Haiku 4.5).
5. **Streaming is required** end-to-end (the director UI streams agent tokens live).

## Consequences

- Deliberation logic is decoupled from any model/provider — swap models by editing OpenCode
  config, not code.
- The persona editor and UI must expose tier selection (not raw model IDs).
- Testing must cover mixed-tier casts (a debate spanning T1/T3/T4 models).
- We depend on OpenCode's availability and model catalog; an OpenCode outage or a model it
  can't route to is a new failure mode to handle.
- Cost is steerable per role: the flagship model sits only where it matters (synthesis,
  orchestration), while the bulk debate runs on a cheaper standard tier.

## Alternatives considered

- **Call Anthropic directly via `langchain-anthropic`, single model everywhere** — rejected:
  no per-role cost control, and locks Mob to one provider.
- **Per-persona hardcoded model IDs** — rejected: couples the app to specific models; tiers
  give the same control with central, swappable binding.
