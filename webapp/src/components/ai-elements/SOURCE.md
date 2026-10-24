# AI Elements components

Selected source from [Vercel AI Elements](https://github.com/vercel/ai-elements), retrieved 2026-10-05 under the accompanying Apache-2.0 LICENSE:

- [conversation.tsx](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/conversation.tsx)
- [message.tsx](https://github.com/vercel/ai-elements/blob/main/packages/elements/src/message.tsx)

Local changes: retain conversation scrolling, empty state, message layout and Streamdown response; omit unused branching, download, action and optional math/diagram plugins; use the shared accessible scroll button and class utility. MessageResponse uses React's default memo comparison and the shared Streamdown code plugin. Reasoning uses the same renderer; JsonResponse renders serialized tool data as a static JSON code block. These are adapted source components, not a dependency on a hosted service.

The scroll button now uses the shared Button component, and message surfaces
follow the site's theme and square corners. The class utility is shared with
the other UI controls.
