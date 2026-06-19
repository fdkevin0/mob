# Mob backend — single Linux container image (ADR 0001).
# Stateless compute: serves the Deliberate gRPC service. The macOS app pulls a
# pinned tag, runs it via the containerization framework, health-checks it, and
# tears it down on quit.
#
# Build from the REPO ROOT so the shared proto/ contract is in context:
#   docker build -f backend/Dockerfile -t mob-backend:dev .
FROM python:3.12-slim

WORKDIR /app

# Install deps first for layer caching.
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Shared proto contract (single source of truth) + backend sources.
COPY proto/ ./proto/
COPY backend/mob_backend/ ./mob_backend/

# Regenerate stubs from the proto inside the image so the contract drives codegen
# (the committed gen/ is a local-dev convenience).
RUN rm -rf mob_backend/gen && mkdir -p mob_backend/gen \
    && touch mob_backend/gen/__init__.py \
    && python -m grpc_tools.protoc \
        --proto_path=proto \
        --python_out=mob_backend/gen \
        --grpc_python_out=mob_backend/gen \
        proto/mob/v1/deliberation.proto \
    && touch mob_backend/gen/mob/__init__.py mob_backend/gen/mob/v1/__init__.py

ENV MOB_PORT=50051
EXPOSE 50051

# Health check via the standard grpc.health.v1 service.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD python -m mob_backend.healthcheck || exit 1

CMD ["python", "-m", "mob_backend.server"]
