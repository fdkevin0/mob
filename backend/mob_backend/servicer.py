"""The Deliberate gRPC servicer.

For Slice 1 this replays the canned script (see script.py). The first inbound
ClientMessage must be a StartDeliberation; SteeringInput is defined in the proto
but not yet handled (a later slice wires it into the orchestrator). Because the
response is server-streaming, any further client messages (e.g. SteeringInput)
simply go unread for now — they do not block the canned event stream.
"""

from __future__ import annotations

from typing import Iterator

import grpc

from mob.v1 import deliberation_pb2 as pb
from mob.v1 import deliberation_pb2_grpc as pb_grpc

from .script import canned_events


class DeliberationServicer(pb_grpc.DeliberationServicer):
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

        yield from canned_events(first.start)
