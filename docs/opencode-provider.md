# OpenCode Console provider (initial integration)

2026-11-27 — initial server integration, using the existing encrypted per-user
credential store. No change to direct-provider routing or default agent models.

## Configuration

In AWFL Web, open Settings → Credentials → OpenCode API key and save
a paid Console API key. The existing authenticated credential route
(POST /workflows/creds/opencode) stores the value encrypted per user. Never put the key in workflow source or logs. Select an
allowlisted model using the opencode/ prefix; the transport removes it before
calling OpenCode. Both models endpoints advertise the same curated catalog.

Initial models: GPT-6.2 Sol, GPT-6 Luna, Claude Sonnet 5.5, Claude Opus 5.5,
Gemini 4 Argon, Gemini 3.8 Flash, DeepSeek V4.1 Flash, DeepSeek V4 Pro,
GLM 5.3 and Kimi K2.7 Code. This is a curated selection, not a usage ranking.
The public Console model list was checked for the exact IDs and context limits.

## Transport and accounting

OpenCode's Console models documentation states that text models can be called
through its translated APIs. Use the Responses endpoint
https://opencode.ai/inference/openai/v1/responses to reuse AWFL's existing
stateless text and function-tool conversion and terminal streaming contract.
Do not retry with another provider after an inference request. Current AWFL
history does not preserve reasoning items; live multi-turn tool-loop testing
is required, especially for translated non-GPT models.

AWFL reserves up to 32,768 completion tokens initially and uses its existing
17K history budget; these are conservative AWFL caps, not provider limits.
Use the returned usage.cost in USD rather than a static price estimate; this
handles discounts, long-context tiers, and cache writes. If unavailable, cost
is unknown, not zero. Free chat variants are not offered to external clients.

## Validation and rollout

- [x] Inspect model routing, credentials, Responses adapter and usage accounting.
- [x] Verify model IDs and context limits from the public Console catalog.
- [x] Add explicit allowlist, routing, adapter and both model discovery routes.
- [x] Run local regression tests (including mocked tool and stream responses).
  Result: 26/26 targeted tests passed (mock upstream; Node 20 in the local
  consumer). No paid provider call or compiled native E2E yet.
- [x] Add OpenCode to web credential and model selection. Web typecheck and
  24/24 existing tests pass.
- [ ] Verify native workflow consumers accept namespaced IDs end to end.
- [ ] Configure a paid user credential and test each model with real text,
  tool calls and tool-result replay, live streaming and cost accounting.
- [ ] Deploy the opt-in provider and settings via CI, leaving existing model
  defaults unchanged. A paid user credential is required for real upstream
  validation; no key is provisioned or shared by this rollout.

References:
https://opencode.ai/docs/console/models/
https://opencode.ai/docs/console/api/inference/
