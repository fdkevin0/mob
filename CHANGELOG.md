# Changelog

## [0.3.0](https://github.com/fdkevin0/mob/compare/v0.2.0...v0.3.0) (2026-10-24)


### ⚠ BREAKING CHANGES

* migrate Mob to TypeScript and Electron, remove Go ([#104](https://github.com/fdkevin0/mob/issues/104))

### Features

* **agents:** add Claude Agent and Telegram task notices ([#80](https://github.com/fdkevin0/mob/issues/80)) ([5c58879](https://github.com/fdkevin0/mob/commit/5c588796faf83d3f63efdf552cc00a8579dc2c1f))
* **agents:** add DeepSeek Harness and CodeBuddy Code over ACP ([#88](https://github.com/fdkevin0/mob/issues/88)) ([d2d415e](https://github.com/fdkevin0/mob/commit/d2d415efe379fd65b31d6af97b56b0d4dde8bb5c))
* **agents:** hand coding tasks to Codex over ACP ([#77](https://github.com/fdkevin0/mob/issues/77)) ([9148bb4](https://github.com/fdkevin0/mob/commit/9148bb42adfea7bce60222cf71d3cc9dd9d65aba))
* **agents:** let tasks start sub-tasks over MCP, summarize ended tasks ([#96](https://github.com/fdkevin0/mob/issues/96)) ([24d20ee](https://github.com/fdkevin0/mob/commit/24d20eea6ed396a65dbd54dee7a48d686b17dcf4))
* **agents:** readers: read-only tasks in another task's worktree ([#99](https://github.com/fdkevin0/mob/issues/99)) ([7fd564c](https://github.com/fdkevin0/mob/commit/7fd564c2d8719b0b867935c70704977f6132941b))
* **agents:** review squads: parallel read-only reviewers, checked by Mob ([#103](https://github.com/fdkevin0/mob/issues/103)) ([697c969](https://github.com/fdkevin0/mob/commit/697c9690818c336b213f023a1f59863d3c3663ee))
* **agents:** show who started whom in an agent tree ([#84](https://github.com/fdkevin0/mob/issues/84)) ([272f427](https://github.com/fdkevin0/mob/commit/272f427002b6034328e1a2f02fa9d14c13e609e4))
* **agents:** task_result: agents report how their work ended ([#100](https://github.com/fdkevin0/mob/issues/100)) ([28c3dd4](https://github.com/fdkevin0/mob/commit/28c3dd4a4dceed0a858b68a8a1fed3dc8d9ad8b7))
* **docs:** publish the documentation at /docs with Starlight ([#76](https://github.com/fdkevin0/mob/issues/76)) ([e1eeb3a](https://github.com/fdkevin0/mob/commit/e1eeb3a87f6d303f2f5216089b4292b5de552d4f))
* **landing:** magnetic paging for the story: one page per wheel gesture, native snap for touch ([#95](https://github.com/fdkevin0/mob/issues/95)) ([aeab263](https://github.com/fdkevin0/mob/commit/aeab263058a865c5ff8ac2fc1c65c051c0f88842))
* **landing:** tell the story as Mob running a team of coding agents ([#101](https://github.com/fdkevin0/mob/issues/101)) ([3bb8d1e](https://github.com/fdkevin0/mob/commit/3bb8d1e2de80a8f52eee40f8194d91b600fb8c7b))
* **mcp:** let the model find and install remote servers from a catalog ([#73](https://github.com/fdkevin0/mob/issues/73)) ([4d565c5](https://github.com/fdkevin0/mob/commit/4d565c526910cc65418d929e706e599fbacc0d7e))
* retry model requests, cache Anthropic prompts, share the owner's saved facts ([#82](https://github.com/fdkevin0/mob/issues/82)) ([18715ae](https://github.com/fdkevin0/mob/commit/18715ae0c0e3e52e796f4e933cdad7f46c6e5fa1))
* **runner:** add account-paired end-to-end encrypted remote control ([#69](https://github.com/fdkevin0/mob/issues/69)) ([4b39192](https://github.com/fdkevin0/mob/commit/4b391924c4c8761cfd528cde0e4a4f28f2cc139a))
* **runner:** deploy a runner to Render's free tier from the connect dialog ([#74](https://github.com/fdkevin0/mob/issues/74)) ([7e1ba2a](https://github.com/fdkevin0/mob/commit/7e1ba2ada37d53d88aa8aeed2d9255c3976deb36))
* **skills:** let the model load Agent Skills by name ([#59](https://github.com/fdkevin0/mob/issues/59)) ([1a6264d](https://github.com/fdkevin0/mob/commit/1a6264d7581b2800804e604d35cc862b4f3163ca))
* task snapshot, task_diff/task_check, automatic task review, schedules ([#86](https://github.com/fdkevin0/mob/issues/86)) ([02e8109](https://github.com/fdkevin0/mob/commit/02e8109f545b580d094d0d61d837f00f31dee05a))
* **usage:** record token usage and add a usage page ([#83](https://github.com/fdkevin0/mob/issues/83)) ([8bb76b8](https://github.com/fdkevin0/mob/commit/8bb76b84c09ed860b2ebca37a81d026b82791482))
* **web:** /demo page: one replayed scene, a conversation and the agents working beside it ([#97](https://github.com/fdkevin0/mob/issues/97)) ([0982ecc](https://github.com/fdkevin0/mob/commit/0982eccc8d5862cab2bd057f7ea946df9798ed3d))
* **web:** add an account page and passkey sign-in ([#75](https://github.com/fdkevin0/mob/issues/75)) ([d517825](https://github.com/fdkevin0/mob/commit/d5178250a8c85e706cef80d03341dcc7178e6e45))
* **web:** decide, stop and instruct agents from the agent tree ([#90](https://github.com/fdkevin0/mob/issues/90)) ([93eb40c](https://github.com/fdkevin0/mob/commit/93eb40c8918c32dce3af6ba0866ee824004a2f1d))
* **web:** landing page with GitHub sign-in in front of the public web UI ([#67](https://github.com/fdkevin0/mob/issues/67)) ([c931fc0](https://github.com/fdkevin0/mob/commit/c931fc01c8159e23db2ec83a21e191dcf215b7fa))
* **web:** line icons instead of pixel icons; calves stay pixel art ([#98](https://github.com/fdkevin0/mob/issues/98)) ([a268cdf](https://github.com/fdkevin0/mob/commit/a268cdf94e2d742490551698c11cbdf1663fb4ac))
* **web:** link preview image and Open Graph tags; move to usemob.app ([#93](https://github.com/fdkevin0/mob/issues/93)) ([e5e4842](https://github.com/fdkevin0/mob/commit/e5e48421d4945bd00750c0dde7a864a929388be2))
* **web:** open /app without a runner and redesign the chat workspace ([#72](https://github.com/fdkevin0/mob/issues/72)) ([67c6ea2](https://github.com/fdkevin0/mob/commit/67c6ea2c4103465ec541d7a6c6eab512431fd2ff))
* **web:** open with what the browser kept, then catch up ([#94](https://github.com/fdkevin0/mob/issues/94)) ([db082d0](https://github.com/fdkevin0/mob/commit/db082d07a82ae5da7dbeaddc5781525a2ef26f3d))
* **web:** redraw the calf logo and office calves after the 牛来的 meme ([#79](https://github.com/fdkevin0/mob/issues/79)) ([d9d515a](https://github.com/fdkevin0/mob/commit/d9d515adf43062dc4f848aa66e36f86a3372f9dc))
* **web:** run Mob in the browser, and move conversations to and from runners ([#106](https://github.com/fdkevin0/mob/issues/106)) ([cbfd742](https://github.com/fdkevin0/mob/commit/cbfd7428ce879026e02b421c6b1d4c6bc782e472))
* **web:** scroll the landing page through the calves' office in pages ([#71](https://github.com/fdkevin0/mob/issues/71)) ([054d5c9](https://github.com/fdkevin0/mob/commit/054d5c91b7fbfe990b60241b868a6013283b141b))
* **web:** system, light and dark colour schemes across the site ([#102](https://github.com/fdkevin0/mob/issues/102)) ([3add933](https://github.com/fdkevin0/mob/commit/3add933bd425ac7d792d73ec1d298b360db759c3))
* **web:** unify workspace with the public site design ([#70](https://github.com/fdkevin0/mob/issues/70)) ([941ee5e](https://github.com/fdkevin0/mob/commit/941ee5e7a32eb2f61e9117abd23d3e955fcd07af))


### Bug Fixes

* **deps:** update go dependencies ([#64](https://github.com/fdkevin0/mob/issues/64)) ([a72b645](https://github.com/fdkevin0/mob/commit/a72b64540a2e3eca58ce09f153f33fb1698851bc))
* **deps:** update js dependencies ([#65](https://github.com/fdkevin0/mob/issues/65)) ([5d94344](https://github.com/fdkevin0/mob/commit/5d9434420b5dc7ab56397783c69e7b1bfadea9e1))
* **web:** configure usemob.app for production and previews ([#78](https://github.com/fdkevin0/mob/issues/78)) ([4de96cc](https://github.com/fdkevin0/mob/commit/4de96cc6ac5eb896cc16900e18f18f30a0807d7c))
* **web:** draw the Turnstile widget in the page's colour scheme ([#107](https://github.com/fdkevin0/mob/issues/107)) ([647d32f](https://github.com/fdkevin0/mob/commit/647d32f219bc831db5ecc255add2df54200e3589))
* **web:** make the calf logo mirror-symmetric ([#81](https://github.com/fdkevin0/mob/issues/81)) ([0bf812c](https://github.com/fdkevin0/mob/commit/0bf812c3f7b3ad585a1d8e25a651c499ed1b9a42))


### Performance

* **web:** smoother web UI: lighter first load, targeted re-renders, pushed changes instead of polling ([#92](https://github.com/fdkevin0/mob/issues/92)) ([479ed41](https://github.com/fdkevin0/mob/commit/479ed4145093ac3c2a64f56991d64d22798e6da2))


### Refactoring

* migrate Mob to TypeScript and Electron, remove Go ([#104](https://github.com/fdkevin0/mob/issues/104)) ([577a230](https://github.com/fdkevin0/mob/commit/577a23024511e566c7f194528ea2e91c1a5475fe))

## [0.2.0](https://github.com/fdkevin0/mob/compare/v0.1.1...v0.2.0) (2026-10-18)


### ⚠ BREAKING CHANGES

* **config:** unify file, flag and environment configuration

### Features

* **app:** let native plugins register turn and tool hooks ([7970528](https://github.com/fdkevin0/mob/commit/79705283bdaa3d7f05f5514cf89420b6d718e84d))
* **chat:** defer MCP tools until tool_search loads them ([f46b1c6](https://github.com/fdkevin0/mob/commit/f46b1c64039d3e383ecf33410aefe2398e5ad9e8))
* **client:** add shared headless client and generated contracts ([fd688b0](https://github.com/fdkevin0/mob/commit/fd688b00bdded4ed7c49883f2772ca988bdada5f)), closes [#49](https://github.com/fdkevin0/mob/issues/49)
* **config:** unify file, flag and environment configuration ([d4ddb25](https://github.com/fdkevin0/mob/commit/d4ddb2572f4a57e9cb6ca63ff078dac261e84142))
* **dsh:** run DeepSeek Harness tool plugins over MCP ([3a1b54e](https://github.com/fdkevin0/mob/commit/3a1b54eccfd3dc974ec33ae392e9f7bbf4761265))
* **extension:** start and reload background extensions in dependency order ([6991929](https://github.com/fdkevin0/mob/commit/69919291f4af881cfdb7eb95f57565ee316ccc80))
* **mcp:** sign in to URL servers with OAuth ([8a980ff](https://github.com/fdkevin0/mob/commit/8a980ff603d9f7a1e470c6ec90820b2011283e31))
* **telegram:** offer buttons in place of typed commands ([7e6c182](https://github.com/fdkevin0/mob/commit/7e6c182fd18353cc85fbd9cf4e39d2030d19b5a2))
* **tui:** add experimental shared-client terminal ([3724441](https://github.com/fdkevin0/mob/commit/37244411b467e65eccfbd4f274bfed91b76c4e50)), closes [#49](https://github.com/fdkevin0/mob/issues/49)
* **tui:** select terminal implementation with MOB_TUI ([b247ecc](https://github.com/fdkevin0/mob/commit/b247ecc07f949faee1c281aae4c146067a892b52))
* **web:** choose this conversation's model from a header picker ([eaa6793](https://github.com/fdkevin0/mob/commit/eaa67931eeb098c4a205ddbf254e9039826d5809))


### Bug Fixes

* **chat:** declare loaded tools and their prompts from the next step ([f3156e0](https://github.com/fdkevin0/mob/commit/f3156e0507e21c7f63070234c48609b6df480d2e))
* **chat:** settle approvals whose result was never saved ([e59b9d6](https://github.com/fdkevin0/mob/commit/e59b9d630e392f0923e2a2880f36b45e1dd8959e))
* **client:** keep an unverifiable send's text while the service is unreachable ([10e0822](https://github.com/fdkevin0/mob/commit/10e0822e6ba2f90738e483b1ff5f300da35605de))
* **client:** publish completed snapshots under slow polling ([#49](https://github.com/fdkevin0/mob/issues/49)) ([ea66230](https://github.com/fdkevin0/mob/commit/ea66230374c8c6c2b75cd91f0cf860f1d7b4835b))
* **client:** reconcile uncertain sends and reject stale snapshots ([#49](https://github.com/fdkevin0/mob/issues/49)) ([5ffd6fa](https://github.com/fdkevin0/mob/commit/5ffd6fa1794e5251ec16194072b0a21172862914))
* **gateway:** preserve relayed response status, headers and streams ([35486de](https://github.com/fdkevin0/mob/commit/35486de32462279798d02789002ec03383e2373f))
* **mcp:** send an empty argument object for tools without parameters ([973e7c1](https://github.com/fdkevin0/mob/commit/973e7c1194ed5e962aa2902f25fa4d19ad60188d))
* **telegram:** keep approval buttons bound to their original conversation ([6359627](https://github.com/fdkevin0/mob/commit/6359627d10ab6af42850b21054f0fa31848d2f15))
* **telegram:** list every remembered approval and clear the picker after New ([f721670](https://github.com/fdkevin0/mob/commit/f721670af57355395237d73d37142e05fcf079ef))
* **tui:** preserve send recovery across conversation navigation ([#49](https://github.com/fdkevin0/mob/issues/49)) ([7283efb](https://github.com/fdkevin0/mob/commit/7283efb3f38b20d5149dc857421b5bbb55aa1392))
* **wechat:** keep the polling cursor behind unsaved receipts ([71460fd](https://github.com/fdkevin0/mob/commit/71460fd9395700fd537c614fd114a13b4e826b38))

## [0.1.1](https://github.com/fdkevin0/mob/compare/v0.1.0...v0.1.1) (2026-10-13)


### Bug Fixes

* **release:** correct Homebrew tap token template ([8e6afb7](https://github.com/fdkevin0/mob/commit/8e6afb7b5483098b06fcef9542be7d8246529fd0))

## 0.1.0 (2026-10-12)


### Features

* **auth:** sign browsers in with one-time links and rotate the token ([425e339](https://github.com/fdkevin0/mob/commit/425e339f3f7bcb49a3e1003168625be403bf30dc))
* **channels:** answer with the turn's conclusion, not its commentary ([d668eae](https://github.com/fdkevin0/mob/commit/d668eaeb8eb1f0be2215f960be4051ccc499715d))
* **chat:** add /compact to summarize the conversation on request ([d4b94a6](https://github.com/fdkevin0/mob/commit/d4b94a6232bf6978586eadb7bbb5f9d66aa3a24e))
* **chat:** clear old tool outputs to fit the window ([50598c9](https://github.com/fdkevin0/mob/commit/50598c9af553e389cf990e9c1de3239d8301a689))
* **chat:** configurable tool step limit and expired approvals ([1d14b4d](https://github.com/fdkevin0/mob/commit/1d14b4d52239434654941712c4cc7bcb18563b83)), closes [#29](https://github.com/fdkevin0/mob/issues/29)
* **chat:** count the context as the provider does ([19b50d9](https://github.com/fdkevin0/mob/commit/19b50d92b386791bee217c9bb189b0e9aef96cb5))
* **chat:** keep turns running after their client leaves and resume them ([2eb6e30](https://github.com/fdkevin0/mob/commit/2eb6e30a889bb98bb573eae889c93bfb579d9141))
* **chat:** let a denial say why and have the model answer it ([adf76cb](https://github.com/fdkevin0/mob/commit/adf76cb29719a782884f08544992eb207c459a80)), closes [#29](https://github.com/fdkevin0/mob/issues/29)
* **chat:** let limits follow the model instead of fixed numbers ([269438f](https://github.com/fdkevin0/mob/commit/269438f68214c3d4770daeff5261d460b8fe9ca4))
* **chat:** one policy for large tool output ([20b482b](https://github.com/fdkevin0/mob/commit/20b482b9c172619a35df6d3311f83f7ed223829e))
* **chat:** remember approvals for a conversation or always ([5790b91](https://github.com/fdkevin0/mob/commit/5790b91c430cdbbe6f4c2ca2efe4345de4a6a833)), closes [#29](https://github.com/fdkevin0/mob/issues/29)
* **chat:** retry once when a provider refuses a prompt as too long ([698f32a](https://github.com/fdkevin0/mob/commit/698f32a3610293375db0ad7eb4ee4fa32f93d504))
* **chat:** summarize older history instead of omitting it ([a3eef35](https://github.com/fdkevin0/mob/commit/a3eef35386ffa5c0b1680631f4263bc332103671))
* **email:** answer the owner's mail as a channel ([e22c010](https://github.com/fdkevin0/mob/commit/e22c010f9a53aef0b42f5163e43b209fc7645c76))
* **mcp:** offer the tools of configured MCP servers to the model ([cbf1bd4](https://github.com/fdkevin0/mob/commit/cbf1bd4e2450f1dc085d1f47d7db5a06df8d528e))
* **plugins:** let the model use email and Cloudflare as tools ([794c9be](https://github.com/fdkevin0/mob/commit/794c9bef7cd2d3d04e2e6859cae1a53d7d0f6f1e))
* **plugins:** run a single D1 SELECT without approval ([2354e48](https://github.com/fdkevin0/mob/commit/2354e48bf73c8bef78f5a777d63e783d4000fa76)), closes [#29](https://github.com/fdkevin0/mob/issues/29)
* **providers:** add a magpie preset that finds the local gateway ([961226d](https://github.com/fdkevin0/mob/commit/961226d707874bb3188214dcd1dc092da6d766ce))
* **sandbox:** optional gVisor isolation on Linux ([23c6b84](https://github.com/fdkevin0/mob/commit/23c6b847611f7eed3173fa2c46a8a63430dee509))
* **telegram:** answer while polling, with a stop button and formatted replies ([22516be](https://github.com/fdkevin0/mob/commit/22516beea0854da672e73f6ce0336d1de1a6c8c1))
* **web:** offer to continue a reply that stopped at the step limit ([ab9ce72](https://github.com/fdkevin0/mob/commit/ab9ce72e23759a04b29f223dd8d6f309bef47031))
* **web:** public web UI at mob.fdkevin.cloud, signed in by mob open --web ([d2eb235](https://github.com/fdkevin0/mob/commit/d2eb2356c04041a41abc150a75f2fec3a9b288b2))


### Bug Fixes

* **auth:** end old-token requests on rotation and sign the browser out ([626393c](https://github.com/fdkevin0/mob/commit/626393cd78f92103cc5ba37b58169a5ae09b23fc))
* **auth:** release revocation watches and ignore stale 401s ([b9ae86f](https://github.com/fdkevin0/mob/commit/b9ae86fad3e84803b72b3a14b59f470ebcf104eb))
* **auth:** revalidate tokens under the rotation lock and never rotate offline on a 401 ([e4e9768](https://github.com/fdkevin0/mob/commit/e4e97685df397f4e669a279a8031ed2981b2b4ae))
* **auth:** serialize offline token rotation with service startup ([931d4bd](https://github.com/fdkevin0/mob/commit/931d4bd2c2ba236e000c7da05c88181a99273996))
* **channels:** count the approval prompt toward the reply limit ([e0a67a3](https://github.com/fdkevin0/mob/commit/e0a67a3156fc55df2646d03fae8411177c8d8996))
* **channels:** show what an approval would do on Telegram and WeChat ([3ae4169](https://github.com/fdkevin0/mob/commit/3ae41693f98bba236d4ab3f96bd3fa4e7f54bd39)), closes [#29](https://github.com/fdkevin0/mob/issues/29)
* **chat:** confine saved outputs and keep previews within budget ([526b354](https://github.com/fdkevin0/mob/commit/526b354326349bf18ca70743c79365f32dae50a1))
* **chat:** do nothing for withdrawn authority and pace web follows ([3ea68a1](https://github.com/fdkevin0/mob/commit/3ea68a190bda36883f81e9724cc7d6149168e830))
* **chat:** end a streamed turn at the step limit as finished, not failed ([72134c5](https://github.com/fdkevin0/mob/commit/72134c526b756e1567d744200d99e02f0669faa0))
* **chat:** expire approvals in snapshots and show follow-up approvals on WeChat ([9747dbb](https://github.com/fdkevin0/mob/commit/9747dbbc21dda06267947f446884f8924b59c71f)), closes [#29](https://github.com/fdkevin0/mob/issues/29)
* **chat:** fit summaries around the latest message ([8283fe7](https://github.com/fdkevin0/mob/commit/8283fe799b44a02d30c0d7c152ed70cf53875ea4))
* **chat:** keep the summary for models whose window is unknown ([a220712](https://github.com/fdkevin0/mob/commit/a220712dd16eb500b95a695d56b3d3b1be5099c7))
* **chat:** keep thinking within the reserved reply and send long pastes whole ([b7e49bc](https://github.com/fdkevin0/mob/commit/b7e49bc51a814fcd437faec3382c20dd5d61dce0))
* **chat:** keep unread outputs when retrying and record a stopped /compact ([f2330c1](https://github.com/fdkevin0/mob/commit/f2330c1a9b3c193a243dc524e5c4549da2b465ce))
* **chat:** name each cleared output's own file and credit clearing by measurement ([371f9bb](https://github.com/fdkevin0/mob/commit/371f9bb45eff3b8eec8848592a1782abde0a390d))
* **chat:** refit summary parts as the summary grows and set aside summaries too large for the model ([792a9fa](https://github.com/fdkevin0/mob/commit/792a9fa186253279a4aa1e23677989c7c0ab7dbb))
* **chat:** report a failed save after the tool step limit ([09e6db4](https://github.com/fdkevin0/mob/commit/09e6db47dd04d5e0f7e00ef618e11f6fb264f769))
* **chat:** reserve the omission notice and approval note when fitting history ([5aa52f2](https://github.com/fdkevin0/mob/commit/5aa52f2045451fc80db5d6ef8ea98b5ffab2e36a))
* **chat:** reserve the sandbox tool name and refuse duplicate tools ([cbeafd3](https://github.com/fdkevin0/mob/commit/cbeafd377665a5eb4b55d76fe0a21019478fbcdd))
* **chat:** reuse summaries that fit and drop those a changed call outdates ([002c878](https://github.com/fdkevin0/mob/commit/002c878818af04bd89b60e11ac6351823ee1840e))
* **chat:** stop revoked turns from admission and follow running turns afresh ([b800fd5](https://github.com/fdkevin0/mob/commit/b800fd596a8842ea8c5e941bc5861d10fc21953e))
* **deps:** update js dependencies ([5fcb296](https://github.com/fdkevin0/mob/commit/5fcb296ee4636e5e984d80482514776cf7f1083d))
* **email:** handle new mail oldest first and never download large mail ([a2159f3](https://github.com/fdkevin0/mob/commit/a2159f37a9be8c29cc6e226c491b1f23fa76e876))
* **extension:** refuse plugin request bodies past the size limit ([9130626](https://github.com/fdkevin0/mob/commit/9130626e820da162057deb3f38f40753b9a064b0))
* **mcp:** keep the server and tool boundary unambiguous in tool names ([0368dfa](https://github.com/fdkevin0/mob/commit/0368dfa6fd7bc412fd4ef1f64527f6652d336fb3))
* **mcp:** pin approvals to the whole server configuration and keep headers on their origin ([5f0f3ec](https://github.com/fdkevin0/mob/commit/5f0f3ecf42a051da6551c52caac54d7f2bf59fce))
* **plugins:** pin approved calls to their target and omit empty required ([1153538](https://github.com/fdkevin0/mob/commit/1153538ca4fc005b1fd006f20290ddd997aa10f4))
* **plugins:** run an approved Cloudflare call with the checked configuration ([dc0fdf9](https://github.com/fdkevin0/mob/commit/dc0fdf9a3fab8abdcf03896538de47e5b3d34df2))
* **telegram:** decode link destinations and keep settled keyboards settled ([6a4354f](https://github.com/fdkevin0/mob/commit/6a4354f95681713423ea0395c9d574c04c893840))
* **telegram:** keep replies to the app off the polling path ([d733e18](https://github.com/fdkevin0/mob/commit/d733e18bf6b98cbf4b8837879e7c77d7b38d21e8))
* **telegram:** read line endings in code spans as spaces ([9ef9084](https://github.com/fdkevin0/mob/commit/9ef9084cbe8eb03e3acca8d4f4a666560623569b))
* **telegram:** settle buttons on recorded decisions, end placeholders with the answer ([673fb88](https://github.com/fdkevin0/mob/commit/673fb88c2eed117725989f57f2b07c49ddbbb76f))
* **telegram:** start messages at admission and stop only the tapped reply ([9d61bed](https://github.com/fdkevin0/mob/commit/9d61bed7dbac583073d50223ef9e7511225a6640))
* **tui:** keep every paste whole however pastes add up ([1c738e9](https://github.com/fdkevin0/mob/commit/1c738e92bac474e8b8a9bdeda22dd45cc34e75d4))
* **tui:** tag paste placeholders so look-alike text never takes a paste ([660f6d9](https://github.com/fdkevin0/mob/commit/660f6d964edec571adcf2b0e7bbc166a8bceeb57))
* **webapp:** keep a token another tab saved when signing out ([b5b34a8](https://github.com/fdkevin0/mob/commit/b5b34a86ba6e49f4be68baa647c1c6b7240dd331))
* **web:** keep the token on this computer and honor an empty MOB_WEB_URL ([0871e7c](https://github.com/fdkevin0/mob/commit/0871e7c0017221dd1f6b149e228a469f447de7d0))
* **web:** show the step limit as a note beside Continue, not an error ([9b98e34](https://github.com/fdkevin0/mob/commit/9b98e34eef95c4cecfe65ce923bdd2667ec52d83))
