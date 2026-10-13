# Changelog

## [0.2.0](https://github.com/fdkevin0/mob/compare/v0.1.1...v0.2.0) (2026-10-13)


### ⚠ BREAKING CHANGES

* **config:** unify file, flag and environment configuration

### Features

* **client:** add shared headless client and generated contracts ([fd688b0](https://github.com/fdkevin0/mob/commit/fd688b00bdded4ed7c49883f2772ca988bdada5f)), closes [#49](https://github.com/fdkevin0/mob/issues/49)
* **config:** unify file, flag and environment configuration ([d4ddb25](https://github.com/fdkevin0/mob/commit/d4ddb2572f4a57e9cb6ca63ff078dac261e84142))
* **telegram:** offer buttons in place of typed commands ([7e6c182](https://github.com/fdkevin0/mob/commit/7e6c182fd18353cc85fbd9cf4e39d2030d19b5a2))
* **tui:** add experimental shared-client terminal ([3724441](https://github.com/fdkevin0/mob/commit/37244411b467e65eccfbd4f274bfed91b76c4e50)), closes [#49](https://github.com/fdkevin0/mob/issues/49)
* **tui:** select terminal implementation with MOB_TUI ([b247ecc](https://github.com/fdkevin0/mob/commit/b247ecc07f949faee1c281aae4c146067a892b52))


### Bug Fixes

* **client:** keep an unverifiable send's text while the service is unreachable ([10e0822](https://github.com/fdkevin0/mob/commit/10e0822e6ba2f90738e483b1ff5f300da35605de))
* **client:** publish completed snapshots under slow polling ([#49](https://github.com/fdkevin0/mob/issues/49)) ([ea66230](https://github.com/fdkevin0/mob/commit/ea66230374c8c6c2b75cd91f0cf860f1d7b4835b))
* **client:** reconcile uncertain sends and reject stale snapshots ([#49](https://github.com/fdkevin0/mob/issues/49)) ([5ffd6fa](https://github.com/fdkevin0/mob/commit/5ffd6fa1794e5251ec16194072b0a21172862914))
* **telegram:** list every remembered approval and clear the picker after New ([f721670](https://github.com/fdkevin0/mob/commit/f721670af57355395237d73d37142e05fcf079ef))
* **tui:** preserve send recovery across conversation navigation ([#49](https://github.com/fdkevin0/mob/issues/49)) ([7283efb](https://github.com/fdkevin0/mob/commit/7283efb3f38b20d5149dc857421b5bbb55aa1392))

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
