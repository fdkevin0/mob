# ADR 0001 — macOS app supervises a containerized backend over gRPC

- Status: Accepted
- Date: 2026-06-19
- Deciders: fdkevin (grilling session)

## Context

Mob is a native macOS app (SwiftUI) driving a LangChain backend that runs a live,
steerable multi-agent deliberation. The backend needs Python/LangChain; the client is
Apple-native. We need a way to run and talk to the backend that works both **self-hosted
on the user's Mac (default)** and **hosted in our cloud (optional)** without two codebases.

## Decision

1. **Backend ships as a single Linux container image**, published to **Docker Hub** with
   versioned tags the app pins to. The same image runs locally (self-host) or in our cloud
   (hosted) — location is just an endpoint switch.
2. **Default mode is self-host.** The macOS app **manages the backend container locally**
   using Apple's **containerization framework API** (not CLI shell-out): pull → run →
   discover the gRPC endpoint → health-check → tear down on quit.
3. **Transport is gRPC.** Bidirectional streaming carries the live debate (server → client
   token streams) and director steering (client → server injections) over one contract,
   identical for local and hosted.
4. **LLM key handling is mode-dependent.** Self-host: user brings their own key, stored in
   the macOS Keychain, passed to the local container at launch. Hosted: we hold the key.

## Consequences

- **Hard system requirement:** Apple Silicon + macOS Tahoe (26)+ for the containerization
  framework. No Intel Macs, no older OS. Accepted as a deliberate depth-over-reach v1 audience.
- **Network required on first run** to pull the image from Docker Hub; truly offline /
  air-gapped use is out of scope for v1.
- **One backend artifact** for both modes — big simplification; no embedded Python runtime,
  no PyInstaller, no fat `.app`.
- We depend on a **young framework API** (containerization). Risk accepted for robustness over
  CLI-flag fragility; revisit if the API proves unstable.
- The app owns a **container lifecycle** (pull progress, run failures, port/endpoint discovery,
  crash supervision) — real surface area to design and error-handle.

## Alternatives considered

- **Bundle a CPython runtime inside the `.app`** — rejected: codesigning/notarization pain
  with native deps, fat bundle, ships an interpreter to every Mac.
- **Compile backend to a standalone binary (PyInstaller/Nuitka)** — rejected for v1: fiddly
  with LangChain; container image is cleaner and doubles as the hosted artifact.
- **Drive `container` via CLI shell-out** — rejected: fragile (depends on CLI install + stable
  flags); framework API is more robust.
- **Local-first with no hosted path** — rejected: hosted remains a wanted optional mode; the
  container approach gets it nearly for free.
