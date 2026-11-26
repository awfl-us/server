# Diagnose OpenAI prompt-cache misses

The Jobs OpenAI adapter writes private request captures to `gs://awfl-us-openai-context-capture/YYYY-MM-DD/<capture_id>.json` and emits an `openai_context_capture_usage` Cloud Logging event containing the same ID and the reported `cached_tokens`.

`openai_cache_diff.py` correlates those two sources, compares consecutive **exact API request messages**, and prints safe structural differences rather than request bodies. Use a time window covering only one workflow/session to avoid interleaving unrelated model calls.

```bash
python3 scripts/openai_cache_diff.py \
  --project awfl-us \
  --start 2026-11-18T17:05:00Z \
  --end 2026-11-18T17:08:00Z \
  --model gpt-6.1-terra \
  --token-file /path/to/google-oauth-access-token
```

The tool also supports offline analysis:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="jobs" AND jsonPayload.event="openai_context_capture_usage" AND timestamp>="2026-11-18T17:05:00Z" AND timestamp<="2026-11-18T17:08:00Z"' \
  --project=awfl-us --format=json > /secure/usage.json
python3 scripts/openai_cache_diff.py --usage-file /secure/usage.json \
  --bucket awfl-us-openai-context-capture --token-file /path/to/token --json
```

Or use `--capture-dir /secure/captures` instead of GCS: files should be named `<date>/<capture_id>.json` or `<capture_id>.json`. Without `--token-file`, the script also accepts `AWFL_GOOGLE_ACCESS_TOKEN_FILE`, `GOOGLE_OAUTH_ACCESS_TOKEN`, or a gcloud-authenticated environment. `tiktoken` is optional; when available, it estimates `o200k_base` tokens for unchanged **serialized JSON message prefixes**, which is not equivalent to OpenAI's actual prompt-token accounting or eligible cached breakpoint. Without it, estimates use JSON characters/4.

The output identifies which messages were appended, deleted or rewritten, whether tool schemas/model parameters changed, the first divergence, and the **observed** cached-token counts from OpenAI. It does **not** output message content or tool arguments. Be aware that the private GCS objects themselves contain full context and expire after seven days.

## November 18 Project Manager: six Terra requests

The baseline after chronological TopicContext ordering was **13,172 cached / 90,316 input tokens (14.58%)**. All 11 tool definitions and model-level request settings were unchanged across the six requests.

| Request pair | First change | Cache tokens reported for later request |
|---|---|---:|
| 1 → 2 | Append-only, previous 18 messages identical | 3,293 |
| 2 → 3 | Previous `Tool calls completed` marker replaced by new call and results | 3,293 |
| 3 → 4 | Same rolling marker replacement; new week summary appended | 3,293 |
| 4 → 5 | Previously returned 25,337-character tool result replaced with synthetic `Tool call failed to respond` | 3,293 |
| 5 → 6 | Context intro and four earlier summaries deleted; second tool result also replaced | **0** |

### Investigation priorities

1. `workflows/context/filters/dropToolCallsCompleted.js` deliberately retains only the latest `Tool calls completed` message, so the earlier terminal marker disappears as history grows. This invalidates a previous trailing implicit cache breakpoint. Consider preserving these messages until a compaction boundary, or placing explicit breakpoints at stable earlier messages.
2. `workflows/context/filters/sizeLimiter.js` selects messages from newest to oldest (prioritizing users by default), so it can remove early summary/context messages. In request 6, this apparently removed the introduction, two term summaries and two week summaries. Preserve stable instructions outside the history budget and compact in larger increments if cache reuse matters.
3. `workflows/context/filters/toolCallBackfill.js` synthesizes `Tool call failed to respond` when an assistant tool call has no retained response. It caused historical tool-message rewrites when earlier tool results were pruned. Check the interaction with `sizeLimiter` and `fileContentsLimiter` to avoid backfilling messages previously sent with actual outputs.
4. **Not everything is explained by the diffs.** Requests 2 and 3 had about 15k estimated identical JSON-message tokens before the first change, but OpenAI reported only 3,293 cached tokens. Cache reads happen at eligible stored breakpoints on the machines handling requests, not automatically at every shared token. Current GPT-5.6+ implicit caching defaults to the last eligible message, so moving/removing a trailing marker can prevent reuse of the newer, longer prefix even if an earlier segment still matches. Evaluate stable explicit breakpoints with telemetry before attributing all misses to historical edits.

No production config changes are made by the script.

## Responses API captures

The diagnostic accepts both Chat Completions `messages` and Responses `input` items. Reported message counts refer to wire items for Responses, including function calls and outputs. Cross-protocol comparisons are explicitly labeled as protocol changes; cache-prefix estimates must not be interpreted as a directly comparable token prefix. The adapter retains normalized usage fields and exact request captures. See `docs/plans/2026-11-26-agent-response-streaming.md` for the migration gate.

### November 26 live protocol comparison

A synthetic 3,668-token Terra input was sent three times per API with an unchanged system prefix and a changing trailing user trial. Both protocols reported 0, 3,654, 3,654 cached input tokens. This verifies within-protocol warm cache accounting; it is not a production cache benchmark and does not prove cross-protocol cache sharing.
