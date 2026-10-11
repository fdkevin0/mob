# AI Elements components

Selected source from [Vercel AI Elements](https://github.com/vercel/ai-elements), retrieved 2026-10-05 under the accompanying Apache-2.0 LICENSE:

- [conversation.tsx](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/conversation.tsx)
- [message.tsx](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/message.tsx)

Local changes: retain conversation scrolling, empty state, message layout and Streamdown response; omit unused branching, download, action and optional rendering plugins; use a native accessible scroll button and local class utility. MessageResponse uses React's default memo comparison. These are adapted source components, not a dependency on a hosted service.
