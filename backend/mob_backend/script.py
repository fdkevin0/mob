"""The canned deliberation script for the walking skeleton (Slice 1, issue #2).

No model is reached. The server replays this scripted sequence of events so the
gRPC seam, container supervision, streaming, and client render can all be proven
before any real model work. Later slices replace `canned_events` with a
model-driven orchestrator behind the same DeliberationServicer.
"""

from __future__ import annotations

from typing import Iterator

from mob.v1 import deliberation_pb2 as pb

# Reserved persona id for the moderator/orchestrator (see proto).
MODERATOR_ID = "__moderator__"


def _status(status: "pb.DeliberationStatus.V") -> pb.DeliberationEvent:
    return pb.DeliberationEvent(status_changed=pb.StatusChanged(status=status))


def _speaker(persona_id: str) -> pb.DeliberationEvent:
    return pb.DeliberationEvent(speaker_changed=pb.SpeakerChanged(persona_id=persona_id))


def _tokens(persona_id: str, text: str) -> Iterator[pb.DeliberationEvent]:
    """Stream `text` word-by-word as separate TokenDelta events."""
    words = text.split(" ")
    for i, word in enumerate(words):
        chunk = word if i == len(words) - 1 else word + " "
        yield pb.DeliberationEvent(
            token_delta=pb.TokenDelta(persona_id=persona_id, text=chunk)
        )


def canned_events(start: pb.StartDeliberation) -> Iterator[pb.DeliberationEvent]:
    """Yield the full scripted event stream for a deliberation.

    Uses the first two personas of the supplied cast as the two debaters, so the
    canned debate is attributed to the client's actual StartDeliberation. Falls
    back to placeholder ids when the cast is short.
    """
    cast = list(start.cast)
    first = cast[0].id if len(cast) >= 1 else "persona-1"
    second = cast[1].id if len(cast) >= 2 else "persona-2"

    yield _status(pb.DELIBERATION_STATUS_ASSEMBLING)
    yield _status(pb.DELIBERATION_STATUS_DEBATING)

    yield _speaker(first)
    yield from _tokens(first, "I think we should weigh the long-term cost first.")

    yield _speaker(second)
    yield from _tokens(second, "Disagree. Speed of learning matters more right now.")

    yield _speaker(MODERATOR_ID)
    yield from _tokens(MODERATOR_ID, "You are converging on a trade-off. Let me synthesize.")

    # The streamed synthesis prose mirrors the terminal Synthesis.recommendation
    # below (the proto contract: prose "also streams as TokenDelta from the
    # moderator persona_id"), so the live stream and the structured result agree.
    recommendation = (
        "Optimize for learning speed now; revisit cost discipline once the "
        "approach is validated."
    )

    yield _status(pb.DELIBERATION_STATUS_SYNTHESIZING)
    yield from _tokens(MODERATOR_ID, f"Recommendation: {recommendation}")

    yield pb.DeliberationEvent(
        synthesis=pb.Synthesis(
            recommendation=recommendation,
            tensions=["Long-term cost vs. speed of learning"],
            dissents=["A minority view holds that ignoring cost early compounds into hard-to-reverse debt."],
        )
    )

    yield _status(pb.DELIBERATION_STATUS_DONE)
