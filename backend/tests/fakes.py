"""Deterministic test doubles for the OpenCode model gateway (Seam 2).

Later slices reuse these rather than reaching a live model: backend service tests
inject `RecordingGateway` so the deliberation event stream is reproducible with
no network, and assert on the recorded call to prove tier resolution happened at
the boundary.
"""

from __future__ import annotations

from typing import Iterator, List

from mob_backend.opencode import ModelGateway


class RecordingGateway(ModelGateway):
    """A `ModelGateway` that streams scripted tokens and records each call."""

    def __init__(self, tokens: List[str]) -> None:
        self._tokens = tokens
        self.calls: List[dict] = []

    def stream_turn(
        self, *, tier: int, system_prompt: str, problem: str
    ) -> Iterator[str]:
        self.calls.append(
            {"tier": tier, "system_prompt": system_prompt, "problem": problem}
        )
        for token in self._tokens:
            yield token


class _FakeChunk:
    """Mimics a LangChain chat chunk: only `.content` is read by the gateway."""

    def __init__(self, content: str) -> None:
        self.content = content


class FakeChatClient:
    """A fake LangChain chat client: records messages, streams fake chunks."""

    def __init__(self, model: str, tokens: List[str]) -> None:
        self.model = model
        self._tokens = tokens
        self.streamed_messages = None

    def stream(self, messages):
        self.streamed_messages = list(messages)
        for token in self._tokens:
            yield _FakeChunk(token)
