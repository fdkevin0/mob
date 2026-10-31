# Public site

How https://usemob.app is built and deployed. What its users see is in
[Remote access](features/remote-access.md) and
[Mob in the browser](features/browser-runner.md).

The site is deployed to Cloudflare Workers, so web changes reach users when
they merge, without a release. The Worker in `apps/web/worker/` serves it.

## Pages

- `/` is the landing page, scrolled through in pages over one pinned isometric
  voxel office. Each load lays out a new square open-plan floor of shared
  desks and seats calves on about 70% of them; every calf comes from one
  template (the 牛来的 face of the logo: flat brows, a staring look, a big pale
  muzzle and pointed ears) with a generated skin. Most sit working at their desks; a few at a
  time walk the lanes to high-five, hand
  each other blocks of work, fetch milk tea or coffee, pin notes on the
  whiteboard, try things in the glass booth, put a hand up for the gold
  leader's nod and nap on the sofa, until the leader comes over and cracks its
  whip. `?office=<seed>` pins a layout. The first page is the title over the
  office; the second plays one task step by step in a chat window while the
  calves involved are lit up; the third moves the office left and lists the
  features, and clicking a calf jumps to the feature its activity stands for.
  With reduced motion the pages stack without animation. It is drawn with
  WebGPU (Canvas 2D where WebGPU is missing). The office and the conversation
  are idealised, not a picture of what Mob does today.
- Links to the site show a preview card in Telegram, Slack, X and other apps:
  the landing page and every docs page carry Open Graph and Twitter card tags
  with the 1200×630 image `apps/web/public/og.png` (served at `/og.png`, straight
  from static assets). `/app` and `/account` send visitors without a session,
  crawlers included, to the landing page, so their links preview the same.
  Telegram caches a preview per URL; after changing the image or tags, send
  the link to @WebpageBot to refresh it.
- `/logo.svg` is the transparent brand artwork; `/logo.png` is its 512×512
  rendering with a transparent background. Both and `/og.png` are served
  directly from static assets; pages still pass through the Worker for
  sign-in checks and content security policies. Unknown paths return 404
  instead of redirecting to the landing page.
- `/docs` is the documentation, built with Starlight from `apps/docs`. Its
  pages are this repository's Markdown (`README.md`, `CONTRIBUTING.md` and
  `docs/`), copied in at build time, so they change when those files merge.
  It needs no sign-in and has local search.

## Shared header and navigation

The landing, demo, documentation and account pages share one header
(`apps/web/src/site/`): Home, Demo, Docs and GitHub, a theme picker,
Open Mob, and a Log in button or the visitor's avatar. On the React pages the
avatar opens a menu with Account and Sign out; the documentation loads no
framework, so there it links to the account page, which has Sign out too. On
narrow screens the links, docs search and theme picker move into a side drawer
(in the documentation, above the documentation tree).

Each page is a separate document with its own policy, so moving between them is
a full load. Two browser features soften that where they are supported. Every
page sends a `Speculation-Rules` header naming `/speculation-rules.json`, which
prerenders `/`, `/demo` and the documentation when the pointer rests on a link
to them (never `/app`, `/account` or a link with a query), so the click shows
the page at once. The pages also opt into cross-document view transitions: the
header stays in place while the content cross-fades, unless the visitor asks
for reduced motion. Every page preloads its Latin Geist face, and hashed build
files (`/assets/*`, `/docs/_astro/*`) are cached as immutable
(`apps/web/public/_headers`), so later pages paint in Geist straight away instead
of swapping from a fallback font.

## Workspace look

The landing page and workspace share the theme (System, Light or Dark), Geist
fonts and the calf logo; the UI rules are in [UI style](ui-style.md). The workspace uses calmer, rounded controls in the local browser, the
desktop app and `/app`: one rounded message box holds the text, the model
picker and a round send (or stop) button; replies have no role labels; each
tool call is one line with its status that opens to show input and output,
and a pending approval opens as a card with Approve, Allow in this
conversation, Always allow and Deny (which then asks for an optional reason). On narrow screens, Conversations opens a side panel; choosing
a conversation closes it. Model selection and sign-in dialogs contain keyboard
focus and return it when closed. Plugin tabs support arrow-key navigation and
keep unsaved configuration edits when switching tabs.

## Content security

The documentation shares the origin, so it runs only scripts its build emitted:
each page carries a policy `<meta>` with hashes of its scripts and styles, and
the Worker adds a header policy that allows only the site itself (plus
WebAssembly for search) and no framing. It loads no third-party scripts,
fonts or embeds; anything that needs them would move the documentation to a
separate origin.

The landing page and the workspace have separate entries and network policies. Sharing presentation
does not load the landing page's authentication client, Turnstile or voxel scenes
into the workspace.

## Deployment

- `bun run build:web` builds `apps/web/dist` (Vite `--mode public`): the
  landing, demo and account pages and the web UI's `app.html` (from
  `@mob/app`), then the documentation (`apps/docs`) into `apps/web/dist/docs`.
  Hashed documentation assets (`/docs/_astro/`, `/docs/pagefind/`) are served
  without running the Worker. Cloudflare Workers Builds deploys
  `apps/web/wrangler.jsonc` with root directory `apps/web`, build command
  `bun install --frozen-lockfile && bun run build` and deploy command
  `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`.
  The custom domain route serves production at `usemob.app` and, with
  `previews_enabled: true`, previews at `<preview-name>.usemob.app`.
  Deploy production once to apply the domain configuration before creating previews.
- PR builds use deploy command
  `npx wrangler d1 migrations apply DB --remote --config wrangler.preview-migrations.jsonc && npx wrangler preview`.
  This automatically applies pending preview database migrations before deployment;
  a migration failure stops deployment, and applied migrations are skipped.
  Wrangler requires the explicit
  `previews` block in `apps/web/wrangler.jsonc`: public variables and the `DB` binding
  do not inherit their production values. Previews share the separate
  `mob-auth-preview` database.
  Keep that file's database ID aligned with `previews.d1_databases`.
  Set the auth secrets in Cloudflare's Previews Base configuration;
  production secrets are not inherited. Preview URLs are public unless access
  controls are configured. GitHub OAuth callbacks and Turnstile hostnames must
  also allow the preview hostname to exercise sign-in there, and so must the
  Cloudflare OAuth client's redirect URLs.
- Secrets: `BETTER_AUTH_SECRET`, `TURNSTILE_SECRET_KEY`,
  `GITHUB_CLIENT_SECRET` and `CLOUDFLARE_CLIENT_SECRET`. The public
  `TURNSTILE_SITE_KEY`, `GITHUB_CLIENT_ID` and `CLOUDFLARE_CLIENT_ID` are
  vars in `apps/web/wrangler.jsonc`. The OAuth callback URLs are
  `https://usemob.app/api/auth/callback/github` and
  `https://usemob.app/api/auth/callback/cloudflare`. Cloudflare always asks
  for `user-details.read`; the `CLOUDFLARE_SCOPES` var (space-separated scope
  IDs as the Cloudflare OAuth client lists them) adds account read, Workers
  AI and `offline_access`, which Workers AI in the browser needs.
- Locally, put the secrets in `apps/web/.dev.vars`, which overrides the vars too
  (Turnstile's test keys work), and in `apps/web` run
  `npx wrangler d1 migrations apply DB --local`, `bun run build` and
  `npx wrangler dev --port 8799 --local-upstream 127.0.0.1:8799` (the flag
  keeps the request host local instead of the production domain; port 8787 is
  Mob's own). The GitHub OAuth app then needs the local callback URL.
- D1 migrations live in `apps/web/worker/migrations/` (Better Auth, runner
  ownership, passkeys); the deploy commands above apply them before the Worker
  deploys. Runners also use the `RUNNERS` Durable Object, whose SQLite class
  migration is in `apps/web/wrangler.jsonc`. `bun run test:runner` runs the
  real Worker, D1 and Durable Object against the built `mob` binary.
