"""Container HEALTHCHECK probe: queries the standard grpc.health.v1 service.

Exits 0 when the Deliberation service reports SERVING, non-zero otherwise.
"""

from __future__ import annotations

import os
import sys

import grpc
from grpc_health.v1 import health_pb2, health_pb2_grpc


def main() -> int:
    port = int(os.environ.get("MOB_PORT", "50051"))
    try:
        with grpc.insecure_channel(f"localhost:{port}") as channel:
            stub = health_pb2_grpc.HealthStub(channel)
            resp = stub.Check(
                health_pb2.HealthCheckRequest(service="mob.v1.Deliberation"),
                timeout=2.0,
            )
    except grpc.RpcError as exc:  # pragma: no cover - exercised in the container
        print(f"health check failed: {exc}", file=sys.stderr)
        return 1

    if resp.status == health_pb2.HealthCheckResponse.SERVING:
        return 0
    print(f"not serving: {resp.status}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
