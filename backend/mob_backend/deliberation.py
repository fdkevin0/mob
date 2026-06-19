"""The deliberation flow (Slice 2, issue #3).

Slice 1 replayed a fully canned event stream. Slice 2 makes the **persona debate
turn real**: one persona's tokens now come from a live model reached through the
OpenCode gateway (Seam 2), streamed back over the same `Deliberate` channel as
`SpeakerChanged` + `TokenDelta`. Only the *source* of the persona tokens changed.

The moderator turn and the synthesis are still canned placeholders here; later
slices (orchestrator turn-taking #5, synthesis on end conditions #6) make those
real behind this same boundary. Keeping a terminal synthesis preserves the
end-to-end shape the client renders and the state machine the proto defines.
"""

from __future__ import annotations

from typing import Iterator, List

from mob.v1 import deliberation_pb2 as pb

from .opencode import ModelGateway

# Reserved persona id for the moderator/orchestrator (see proto).
MODERATOR_ID = "__moderator__"

# The single hardcoded persona for this slice when the cast carries no usable
# system prompt. The orchestrator and a real multi-persona cast arrive in later
# slices; for now one voice speaks, driven by a real model.
#
# NB: the backend is stateless compute (CONTEXT.md) — the app owns the cast and
# ships it on every StartDeliberation. This default is only a slice-2 fallback so
# a turn can still run when the test/placeholder cast has no system prompt; it is
# not a durable persona and should disappear once a real cast always arrives.
DEFAULT_PERSONA = pb.Persona(
    id="the-pragmatist",
    name="The Pragmatist",
    traits=["practical", "decisive", "cost-aware"],
    system_prompt=(
        "You are The Pragmatist, one voice in a deliberation. Argue from a "
        "practical, decisive, cost-aware viewpoint. Be concise and take a clear "
        "position on the problem you are given."
    ),
    tier=pb.TASK_TIER_T3_STANDARD,
)


def _status(status: "pb.DeliberationStatus.V") -> pb.DeliberationEvent:
    return pb.DeliberationEvent(status_changed=pb.StatusChanged(status=status))


def _speaker(persona_id: str) -> pb.DeliberationEvent:
    return pb.DeliberationEvent(speaker_changed=pb.SpeakerChanged(persona_id=persona_id))


def _token(persona_id: str, text: str) -> pb.DeliberationEvent:
    return pb.DeliberationEvent(
        token_delta=pb.TokenDelta(persona_id=persona_id, text=text)
    )


def _speaking_persona(cast: List[pb.Persona]) -> pb.Persona:
    """Pick the single persona who speaks this slice.

    Prefer the first persona of the client's cast (it carries the system prompt
    and chosen tier); fall back to the built-in default when the cast is empty or
    its first persona has no system prompt to drive a real turn.
    """
    if cast and cast[0].system_prompt:
        return cast[0]
    if cast:
        # Keep the client's identity/tier but supply a usable system prompt.
        persona = pb.Persona()
        persona.CopyFrom(cast[0])
        persona.system_prompt = DEFAULT_PERSONA.system_prompt
        return persona
    return DEFAULT_PERSONA


def run_deliberation(
    start: pb.StartDeliberation, gateway: ModelGateway
) -> Iterator[pb.DeliberationEvent]:
    """Yield the deliberation event stream for one `StartDeliberation`.

    The persona turn streams from `gateway`; everything else follows the proto
    state machine (assembling -> debating -> synthesizing -> done).
    """
    persona = _speaking_persona(list(start.cast))

    yield _status(pb.DELIBERATION_STATUS_ASSEMBLING)
    yield _status(pb.DELIBERATION_STATUS_DEBATING)

    # --- Real persona turn through OpenCode (Seam 2) -------------------------
    yield _speaker(persona.id)
    for text in gateway.stream_turn(
        tier=persona.tier,
        system_prompt=persona.system_prompt,
        problem=start.problem,
    ):
        yield _token(persona.id, text)

    # --- Canned moderator + synthesis (real in later slices) ----------------
    recommendation = (
        "One voice has weighed in; convene more personas to pressure-test this "
        "before committing."
    )

    yield _status(pb.DELIBERATION_STATUS_SYNTHESIZING)
    yield _speaker(MODERATOR_ID)
    yield _token(MODERATOR_ID, f"Recommendation: {recommendation}")

    yield pb.DeliberationEvent(
        synthesis=pb.Synthesis(
            recommendation=recommendation,
            tensions=["A single viewpoint cannot surface the trade-offs a mob would"],
            dissents=["Pending: more personas are needed to register genuine dissent"],
        )
    )

    yield _status(pb.DELIBERATION_STATUS_DONE)
