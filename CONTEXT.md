# Mob — Context

The domain language and core product decisions for Mob. Keep this current as terms get
resolved; skills read it to stay consistent. Architectural decisions live in `docs/adr/`.

## What Mob is

Mob is a **multi-agent deliberation app**: a user convenes a group of personality-driven
AI agents to argue a problem from their distinct viewpoints, and walks away with a better,
synthesized answer than any single agent would give. The user is a **director** — they watch
the debate stream live and steer it (interject, redirect, constrain, end it) rather than
fire-and-forget.

Architecture: a **LangChain backend** runs the agents and orchestration; a **native desktop
app** (SwiftUI) is the live, interruptible UI.

## Glossary

- **Mob** — a group of agents convened for one deliberation. (Not "the app" — the app is "Mob"
  the product; a "mob" is one assembled cast in session.) *(working definition; revisit if it
  causes confusion)*
- **Persona** — a first-class, persisted, user-editable character: name, traits, system prompt,
  (later) avatar. Personas are reused across deliberations. Mob ships a curated **starter cast**;
  users author their own. Personas are the product's lead pillar ("personality").
- **Cast** — the set of personas chosen for a given deliberation.
- **Deliberation** — one live session: a problem posed to a cast, the agents' streamed debate,
  user steering, and a synthesized outcome. *(working definition)*
- **Director** — the user's role: an in-the-room participant-observer who steers but does not
  themselves argue.

## Decisions settled so far (grilling, 2026-06-19)

1. Product is a **multi-agent "mob"**, not a single companion or task assistant.
2. Purpose is **productive deliberation** — output is a better answer/artifact, not entertainment.
3. User is a **director** — live, token-streamed, interruptible steering (not fire-and-forget).
4. **Personas are first-class persisted objects**, user-authored, seeded with a curated starter cast.

## Architecture (settled — see ADR 0001)

- **Client**: native macOS app (SwiftUI), Apple Silicon + macOS Tahoe (26)+ only.
- **Backend**: LangChain, shipped as one **Linux container image** on **Docker Hub**.
- **Self-host (default)**: the macOS app manages the backend container locally via Apple's
  **containerization framework API**; user brings their own LLM key (stored in Keychain).
- **Hosted (optional)**: same image runs in our cloud; we hold the key. Location is an
  endpoint switch.
- **Transport**: **gRPC**, bidirectional streaming — server streams agent tokens, client
  streams director steering.

## Glossary additions

- **Orchestrator / Moderator** — a hidden "chair" agent that decides which persona speaks
  next, paces the debate, and signals convergence. Director can override (call on / cut off).
- **Synthesis** — the moderator's final authored answer: recommendation + key tensions +
  dissents. A deliberation ends on moderator-converged OR director-called OR round-cap.

## Persistence (settled)

- **Backend is stateless compute.** The macOS app owns all state in a **local SwiftData store**
  (personas, casts, deliberation transcripts). Each deliberation, the app sends the chosen cast
  to the backend; the backend streams results back and persists nothing.
- Self-host and hosted differ only in *where compute runs*, never where data lives.
- **Multi-device sync is deferred** (single-Mac for v1).

## Models (settled — see ADR 0002)

- Model access goes through **OpenCode** as a provider-agnostic gateway (product name
  "OpenCode Go" — a name, not the Go language). The Python/LangChain backend calls models
  through it. Streaming required end-to-end.
- The app references **task tiers**, not concrete models; tier → model is bound in OpenCode
  config and swappable without redeploying:
  - **T1 Flagship** → Synthesis
  - **T2 High** → Orchestrator / moderator
  - **T3 Standard** → Persona debate turns (default)
  - **T4 Fast** → Utility (titles, cast suggestions, light classification, cheap personas)
- **Persona's `model` field names a tier** (default T3), overridable to T1/T4. Orchestrator
  pinned to T2, synthesizer to T1.

## Open questions (being grilled)

- gRPC contract specifics (service/message shape for streaming + steering).
- Deliberation state machine details.
