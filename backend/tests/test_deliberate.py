"""Backend service test (PRD Seam 1).

Drives the real Deliberate RPC over an in-process gRPC channel and asserts the
observable DeliberationEvent sequence — never internal heuristics. The model
gateway (Seam 2) is injected as a deterministic stub so the persona turn is
reproducible with no network or live model.
"""

from __future__ import annotations

import grpc
import pytest

from mob.v1 import deliberation_pb2 as pb
from mob.v1 import deliberation_pb2_grpc as pb_grpc

from mob_backend.deliberation import MODERATOR_ID
from mob_backend.server import build_server

from .fakes import RecordingGateway

PERSONA_TOKENS = ["The ", "pragmatic ", "call ", "is ", "to ", "ship."]


@pytest.fixture()
def gateway():
    return RecordingGateway(tokens=PERSONA_TOKENS)


@pytest.fixture()
def stub(gateway):
    server, port = build_server(port=0, gateway=gateway)
    server.start()
    channel = grpc.insecure_channel(f"localhost:{port}")
    try:
        yield pb_grpc.DeliberationStub(channel)
    finally:
        channel.close()
        server.stop(grace=None)


def _start_msg():
    return pb.ClientMessage(
        start=pb.StartDeliberation(
            cast=[
                pb.Persona(
                    id="ada",
                    name="Ada",
                    system_prompt="You are Ada, argue for rigor.",
                    tier=pb.TASK_TIER_T3_STANDARD,
                ),
            ],
            problem="Should we optimize for cost or learning?",
            config=pb.RunConfig(round_cap=3),
        )
    )


def _collect(stub, messages):
    return list(stub.Deliberate(iter(messages)))


def test_event_sequence_follows_state_machine(stub):
    events = _collect(stub, [_start_msg()])

    statuses = [
        e.status_changed.status for e in events if e.HasField("status_changed")
    ]
    assert statuses == [
        pb.DELIBERATION_STATUS_ASSEMBLING,
        pb.DELIBERATION_STATUS_DEBATING,
        pb.DELIBERATION_STATUS_SYNTHESIZING,
        pb.DELIBERATION_STATUS_DONE,
    ]


def test_persona_turn_streams_real_tokens(stub):
    """The persona turn streams token-by-token from the gateway, attributed to
    the cast persona before the moderator takes over."""
    events = _collect(stub, [_start_msg()])

    # The persona speaks first, then the moderator.
    speakers = [
        e.speaker_changed.persona_id for e in events if e.HasField("speaker_changed")
    ]
    assert speakers == ["ada", MODERATOR_ID]

    # Tokens attributed to the persona are exactly the gateway's stream, in order,
    # and arrive as multiple deltas (streamed, not a single block).
    persona_tokens = [
        e.token_delta.text
        for e in events
        if e.HasField("token_delta") and e.token_delta.persona_id == "ada"
    ]
    assert persona_tokens == PERSONA_TOKENS
    assert len(persona_tokens) > 1


def test_gateway_called_with_persona_tier_and_prompt(gateway, stub):
    """Tier resolution happens at the OpenCode seam: the gateway is asked for the
    persona's tier (T3) and system prompt, never a concrete model id here."""
    _collect(stub, [_start_msg()])

    assert len(gateway.calls) == 1
    call = gateway.calls[0]
    assert call["tier"] == pb.TASK_TIER_T3_STANDARD
    assert call["system_prompt"] == "You are Ada, argue for rigor."
    assert call["problem"] == "Should we optimize for cost or learning?"


def test_terminal_synthesis_has_recommendation_tensions_dissents(stub):
    events = _collect(stub, [_start_msg()])

    syntheses = [e.synthesis for e in events if e.HasField("synthesis")]
    assert len(syntheses) == 1
    synthesis = syntheses[0]
    assert synthesis.recommendation
    assert len(synthesis.tensions) >= 1
    assert len(synthesis.dissents) >= 1

    # Synthesis is terminal: it is the last non-status event, followed by DONE.
    assert events[-1].status_changed.status == pb.DELIBERATION_STATUS_DONE


def test_health_service_reports_serving():
    from grpc_health.v1 import health_pb2, health_pb2_grpc

    server, port = build_server(port=0, gateway=RecordingGateway(tokens=["hi"]))
    server.start()
    try:
        with grpc.insecure_channel(f"localhost:{port}") as channel:
            health = health_pb2_grpc.HealthStub(channel)
            resp = health.Check(
                health_pb2.HealthCheckRequest(service="mob.v1.Deliberation")
            )
            assert resp.status == health_pb2.HealthCheckResponse.SERVING
    finally:
        server.stop(grace=None)


def test_missing_start_yields_error(stub):
    # First message is a SteeringInput instead of StartDeliberation.
    bad = pb.ClientMessage(steering=pb.SteeringInput(cut_off=pb.CutOff()))
    events = _collect(stub, [bad])

    assert len(events) == 1
    assert events[0].HasField("error")
    assert events[0].error.code == "expected_start"
