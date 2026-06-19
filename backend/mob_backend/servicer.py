"""The Deliberate gRPC servicer.

The first inbound ClientMessage must be a StartDeliberation; SteeringInput is
defined in the proto but not yet handled (a later slice wires it into the
orchestrator). Because the response is server-streaming, any further client
messages (e.g. SteeringInput) simply go unread for now — they do not block the
event stream.

The servicer depends on a `ModelGateway` (Seam 2): the persona turn streams from
the gateway, so backend service tests inject a deterministic stub while the real
container streams from a live model through OpenCode.
"""

from __future__ import annotations

from typing import Iterator, Optional

import grpc

from mob.v1 import deliberation_pb2 as pb
from mob.v1 import deliberation_pb2_grpc as pb_grpc

from .deliberation import run_deliberation
from .opencode import ModelGateway, OpenCodeGateway


class DeliberationServicer(pb_grpc.DeliberationServicer):
    def __init__(self, gateway: Optional[ModelGateway] = None) -> None:
        # Default to the real OpenCode-backed gateway; tests inject a stub.
        self._gateway = gateway or OpenCodeGateway()

    def Deliberate(
        self,
        request_iterator: Iterator[pb.ClientMessage],
        context: grpc.ServicerContext,
    ) -> Iterator[pb.DeliberationEvent]:
        # The opening message must be a StartDeliberation.
        first = next(request_iterator, None)
        if first is None:
            yield pb.DeliberationEvent(
                error=pb.Error(
                    code="empty_stream",
                    message="Deliberate stream closed before any message was sent.",
                )
            )
            return

        if first.WhichOneof("message") != "start":
            yield pb.DeliberationEvent(
                error=pb.Error(
                    code="expected_start",
                    message="First ClientMessage must be StartDeliberation.",
                )
            )
            return

        yield from run_deliberation(first.start, self._gateway)
