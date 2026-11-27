# Model-first provider routing

2026-11-27: AWFL chooses a model independently from its inference provider.
Credentials stay per user/provider in Settings; workflows submit the canonical
model ID, e.g. deepseek-v4.1-flash. Former opencode/<model> IDs are aliases,
not a provider override. Saved web selections migrate automatically.

## Routing
1. Resolve model aliases and exact provider model IDs from the curated catalog.
2. Exclude providers whose implemented adapter cannot satisfy the request.
3. Rank candidates by estimated standard inference price, read the user's
   encrypted credentials in that order, and use the first configured key.
4. Do not retry with another provider after dispatch. Return provider and
   canonical model metadata alongside the existing response. Direct provider
   wins exact price ties to avoid an extra hop and preserve its existing cache.

Prices are USD per million tokens, taken from the public OpenCode catalog and
direct provider pricing on 2026-11-27. Ranking uses estimated uncached input
(UTF-8 bytes / 4) and expected output (10% of input, limited by the requested
completion cap). This is a deterministic estimate, not an exact prediction of
cache hits or output length. Rates support GPT long-context tiers, DeepSeek
weekday UTC peak periods, and published Gemini price changes. Chinese holidays,
gateway payment fees, negotiated rates and future promotional changes are not
modeled. Prices are a snapshot; live refresh is a future improvement.
OpenCode accounting uses upstream usage.cost; direct prices are estimates using
reported token usage and applicable rates. Do not invent a gateway cost if
missing. Direct DeepSeek Flash maps to deepseek-flash (1017); V4 Pro is an
unpinned model name and provider revisions may differ.

## Compatibility
- The existing native Anthropic/Gemini adapters only implement text. For the
  overlapping catalog, exclude them for tools, tool history or non-text
  response formats. OpenCode translates those requests through Responses.
- Direct DeepSeek uses non-thinking mode on new Flash/Pro routes, since AWFL
  history does not preserve reasoning items; direct adapter is non-streaming.
- GPT-6.2 Sol and GPT-6 Luna are enabled for direct Responses by default.
- GPT-5 and GPT-6 Sol are also in the overlapping OpenCode catalog. Existing
  GPT-6.1 Terra, GPT-4.1 and GPT-4o remain direct-only; do not assume a gateway
  supports a model that is absent from its list.
- Existing legacy direct routes retain their behavior.

## Validation
- 39/39 targeted server tests passed, including mocked provider routing and HTTP integration; no paid calls.
- Web uses one model option per canonical ID and offers credentials for all
  implemented providers. Typecheck and 31/31 web tests passed.
- Live multi-turn tool and stream testing with user credentials, native
  workflow E2E, and CI deployment verification remain outstanding.

Sources:
- https://opencode.ai/inference/v1/models
- https://opencode.ai/docs/console/models/
- https://developers.openai.com/api/docs/pricing
- https://api-docs.deepseek.com/quick_start/pricing/
- https://platform.claude.com/docs/en/about-claude/pricing
- https://ai.google.dev/gemini-api/docs/pricing
