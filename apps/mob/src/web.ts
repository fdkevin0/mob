// The web UI's files embedded in a compiled mob, by URL path; empty when run
// from source, where assets.ts reads webapp/dist. scripts/build.ts replaces
// this module at build time.
export const files: Record<string, string> = {};
