"""gRPC server entrypoint for the Mob backend container."""

from __future__ import annotations

import os
from concurrent import futures

import grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc

from mob.v1 import deliberation_pb2_grpc as pb_grpc

from .servicer import DeliberationServicer

DEFAULT_PORT = 50051


def build_server(port: int = DEFAULT_PORT) -> tuple[grpc.Server, int]:
    """Build (but do not start) the gRPC server. Returns (server, bound_port)."""
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=8))
    pb_grpc.add_DeliberationServicer_to_server(DeliberationServicer(), server)

    # Standard gRPC health service so the app can health-check the container.
    health_servicer = health.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
    health_servicer.set("", health_pb2.HealthCheckResponse.SERVING)
    health_servicer.set(
        "mob.v1.Deliberation", health_pb2.HealthCheckResponse.SERVING
    )

    bound = server.add_insecure_port(f"[::]:{port}")
    return server, bound


def serve() -> None:
    port = int(os.environ.get("MOB_PORT", DEFAULT_PORT))
    server, bound = build_server(port)
    server.start()
    print(f"Mob backend serving Deliberate on port {bound}", flush=True)
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
