# 15. Built-in tools and chat-scoped semantic memory

Status: Superseded — records the retired Cloudflare Worker, kept at the `legacy-worker` tag; the Go runtime does not follow it.

Assemble built-in tools in one factory with injected dependencies, then pass the
tool set to the AI SDK turn loop. Capability and configuration gates decide which
tools are available; the model should not be offered an unusable integration.

The memory module keeps facts and vector IDs in per-chat DO SQLite, with
Vectorize as the retrieval index. SQLite is needed both as the source of truth
and to enumerate IDs for deletion. Every vector query is chat-filtered.
`@cf/baai/bge-m3` provides multilingual embeddings for Chinese and English;
the index uses 1024 dimensions and cosine distance. Changing embeddings requires
an index and re-embedding plan, not just a model-name edit.

`remember` and `recall` coexist with [extraction and auto-recall](0038-layered-memory-auto-recall-and-fact-extraction.md).
`/forget` wipes facts from both stores; `/clear` clears conversation state.
Vectorize is eventually consistent, so immediate recall may miss a new fact.

`fetch_url` requests Markdown directly and otherwise converts HTML with the
chat's selected parser. This avoids requiring a browser-rendering service for
ordinary URL reads. Parser behavior is described in the
[architecture guide](../architecture.md#models-and-tools); tool APIs live in
[the factory](../../src/features/agent/tools/index.ts).
