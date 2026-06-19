"""The OpenCode model gateway — Seam 2 (PRD #1, ADR 0002).

Every model call in the backend goes through this boundary. The deliberation
logic never names a concrete model: it asks the gateway to stream a turn for a
**task tier**, and the gateway resolves tier -> model from OpenCode config. That
indirection is the whole point of ADR 0002 (swap models without touching code)
and it is the seam backend tests stub so deliberation logic stays deterministic
with no network or live-model call.

- `ModelGateway` is the abstract boundary the servicer depends on.
- `OpenCodeGateway` is the real implementation: it resolves the model via
  `resolve_model`, then streams tokens through a LangChain chat client pointed at
  the OpenCode gateway. LangChain is imported lazily so importing this module (and
  injecting a stub) never requires the LLM stack to be installed.
"""

from __future__ import annotations

import abc
import os
from typing import Callable, Iterator, List, Optional, Tuple

from mob.v1 import deliberation_pb2 as pb

# ADR 0002 default tier -> model bindings. These live in OpenCode config in
# production (swappable without redeploying); the dict is the in-process default
# the backend falls back to, overridable per-tier via MOB_MODEL_T{1..4} env vars.
DEFAULT_TIER_MODELS = {
    pb.TASK_TIER_T1_FLAGSHIP: "claude-opus-4-8",
    pb.TASK_TIER_T2_HIGH: "claude-opus-4-8",
    pb.TASK_TIER_T3_STANDARD: "claude-sonnet-4-6",
    pb.TASK_TIER_T4_FAST: "claude-haiku-4-5",
}

# Unspecified tier resolves to the persona default (T3) per the proto/PRD.
DEFAULT_TIER = pb.TASK_TIER_T3_STANDARD

# A chat message as (role, content); "system" / "human" are the roles we send.
# Kept as plain tuples so this module needs no LangChain types at import time —
# LangChain's chat clients accept this tuple form directly.
ChatMessage = Tuple[str, str]


class OpenCodeConfig:
    """Resolved OpenCode connection + tier->model bindings.

    `tier_models` maps a `TaskTier` value to a concrete model id. `base_url` and
    `api_key` point the LangChain client at the OpenCode gateway; the key is
    handed to the backend out of band (env, sourced from the macOS Keychain) and
    never persisted.
    """

    def __init__(
        self,
        tier_models: Optional[dict[int, str]] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> None:
        self.tier_models = dict(DEFAULT_TIER_MODELS)
        if tier_models:
            self.tier_models.update(tier_models)
        self.base_url = base_url
        self.api_key = api_key

    @classmethod
    def from_env(cls, env: Optional[dict] = None) -> "OpenCodeConfig":
        env = os.environ if env is None else env
        overrides = {}
        for tier, key in (
            (pb.TASK_TIER_T1_FLAGSHIP, "MOB_MODEL_T1"),
            (pb.TASK_TIER_T2_HIGH, "MOB_MODEL_T2"),
            (pb.TASK_TIER_T3_STANDARD, "MOB_MODEL_T3"),
            (pb.TASK_TIER_T4_FAST, "MOB_MODEL_T4"),
        ):
            if env.get(key):
                overrides[tier] = env[key]
        return cls(
            tier_models=overrides,
            base_url=env.get("OPENCODE_BASE_URL"),
            api_key=env.get("OPENCODE_API_KEY"),
        )


def resolve_model(tier: "pb.TaskTier.V", config: OpenCodeConfig) -> str:
    """Resolve a task tier to a concrete model id via OpenCode config.

    Deliberation logic must call models *through* this, never by naming a model.
    An unspecified tier resolves to the persona default (T3).
    """
    if tier == pb.TASK_TIER_UNSPECIFIED:
        tier = DEFAULT_TIER
    try:
        return config.tier_models[tier]
    except KeyError:
        return config.tier_models[DEFAULT_TIER]


class ModelGateway(abc.ABC):
    """The boundary the deliberation logic calls to stream a persona turn.

    Backend service tests inject a stub implementation; the real path is
    `OpenCodeGateway`.
    """

    @abc.abstractmethod
    def stream_turn(
        self,
        *,
        tier: "pb.TaskTier.V",
        system_prompt: str,
        problem: str,
    ) -> Iterator[str]:
        """Yield the persona's turn token-by-token in response to `problem`."""
        raise NotImplementedError


# A factory: (model_id, config) -> a chat client exposing
# `.stream(messages) -> Iterable[chunk]` where each chunk has `.content: str`.
ChatClientFactory = Callable[[str, OpenCodeConfig], object]


def _default_chat_factory(model: str, config: OpenCodeConfig) -> object:
    """Build a streaming LangChain chat client pointed at OpenCode.

    Imported lazily so this module (and the stub-injected test path) never
    requires langchain to be installed.
    """
    from langchain_openai import ChatOpenAI  # noqa: PLC0415 (lazy by design)

    return ChatOpenAI(
        model=model,
        base_url=config.base_url,
        api_key=config.api_key,
        streaming=True,
    )


class OpenCodeGateway(ModelGateway):
    """Real gateway: resolve tier -> model, then stream tokens via LangChain.

    The `chat_factory` seam lets tests substitute a fake chat client (asserting
    the config-resolved model and streaming) without LangChain or the network.
    """

    def __init__(
        self,
        config: Optional[OpenCodeConfig] = None,
        chat_factory: ChatClientFactory = _default_chat_factory,
    ) -> None:
        self.config = config or OpenCodeConfig.from_env()
        self._chat_factory = chat_factory

    def stream_turn(
        self,
        *,
        tier: "pb.TaskTier.V",
        system_prompt: str,
        problem: str,
    ) -> Iterator[str]:
        model = resolve_model(tier, self.config)
        chat = self._chat_factory(model, self.config)
        messages: List[ChatMessage] = [
            ("system", system_prompt),
            ("human", problem),
        ]
        for chunk in chat.stream(messages):
            text = getattr(chunk, "content", "")
            if text:
                yield text
