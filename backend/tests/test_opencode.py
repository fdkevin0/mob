"""Unit tests for the OpenCode gateway boundary (Seam 2).

These prove the load-bearing ADR 0002 property: the backend resolves a model by
**task tier through OpenCode config**, never by a hardcoded model id, and the
real gateway streams those tokens — exercised here with a fake chat client so no
LangChain or network is involved.
"""

from __future__ import annotations

from mob.v1 import deliberation_pb2 as pb

from mob_backend.opencode import (
    DEFAULT_TIER_MODELS,
    OpenCodeConfig,
    OpenCodeGateway,
    resolve_model,
)

from .fakes import FakeChatClient


def test_resolve_model_uses_config_default_bindings():
    config = OpenCodeConfig()
    assert resolve_model(pb.TASK_TIER_T3_STANDARD, config) == "claude-sonnet-4-6"
    assert resolve_model(pb.TASK_TIER_T1_FLAGSHIP, config) == "claude-opus-4-8"


def test_unspecified_tier_resolves_to_persona_default_t3():
    config = OpenCodeConfig()
    assert resolve_model(pb.TASK_TIER_UNSPECIFIED, config) == resolve_model(
        pb.TASK_TIER_T3_STANDARD, config
    )


def test_resolution_follows_config_not_a_hardcoded_id():
    """Swapping the OpenCode config swaps the model with no code change — the
    whole point of the tier indirection."""
    config = OpenCodeConfig(tier_models={pb.TASK_TIER_T3_STANDARD: "some-other-model"})
    assert resolve_model(pb.TASK_TIER_T3_STANDARD, config) == "some-other-model"
    # The default binding is genuinely different, so this isn't a no-op.
    assert "some-other-model" != DEFAULT_TIER_MODELS[pb.TASK_TIER_T3_STANDARD]


def test_config_from_env_overrides_tier_binding():
    config = OpenCodeConfig.from_env(
        {"MOB_MODEL_T3": "env-model", "OPENCODE_BASE_URL": "http://oc"}
    )
    assert resolve_model(pb.TASK_TIER_T3_STANDARD, config) == "env-model"
    assert config.base_url == "http://oc"


def test_gateway_streams_tokens_via_config_resolved_model():
    config = OpenCodeConfig(tier_models={pb.TASK_TIER_T3_STANDARD: "the-chosen-model"})
    built = {}

    def fake_factory(model, cfg):
        client = FakeChatClient(model=model, tokens=["a", "b", "c"])
        built["client"] = client
        return client

    gateway = OpenCodeGateway(config=config, chat_factory=fake_factory)
    tokens = list(
        gateway.stream_turn(
            tier=pb.TASK_TIER_T3_STANDARD,
            system_prompt="be terse",
            problem="ship or wait?",
        )
    )

    assert tokens == ["a", "b", "c"]
    # The factory was handed the config-resolved model, not a hardcoded id.
    assert built["client"].model == "the-chosen-model"
    # System prompt + problem were sent as system/human messages.
    assert built["client"].streamed_messages == [
        ("system", "be terse"),
        ("human", "ship or wait?"),
    ]


def test_gateway_skips_empty_chunks():
    config = OpenCodeConfig()

    def fake_factory(model, cfg):
        return FakeChatClient(model=model, tokens=["x", "", "y"])

    gateway = OpenCodeGateway(config=config, chat_factory=fake_factory)
    tokens = list(
        gateway.stream_turn(
            tier=pb.TASK_TIER_T3_STANDARD, system_prompt="s", problem="p"
        )
    )
    assert tokens == ["x", "y"]
