# Diff OpenAI prompt-cache captures

`scripts/openai_cache_diff.py` compares the **captured OpenAI request bodies**
chronologically, reporting where successive requests first differ, whether tool
schemas or request settings changed, how many message objects remain identical
at the beginning, and each request's actual `cached_tokens` usage.

Use a time window covering just one Project Manager test session so concurrent
agent traffic does not get interleaved. Requires Python 3 and read access to
Cloud Logging and the private seven-day `awfl-us-openai-context-capture` bucket.

```bash
python3 scripts/openai_cache_diff.py \
  --since 2026-11-18T17:04:00Z --until 2026-11-18T17:09:00Z \
  --model gpt-6.1-terra
```

When credentials are supplied by the AWFL cloud environment rather than local
`gcloud auth`, supply `--token-file /path/to/token-file`. Never commit that file.
Alternatively, compare an already exported Cloud Logging JSON array:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="jobs" AND jsonPayload.event="openai_context_capture_usage" AND timestamp>="2026-11-18T17:04:00Z"' \
  --project awfl-us --format=json > /tmp/openai-usage.json
python3 scripts/openai_cache_diff.py --usage-json /tmp/openai-usage.json \
  --model gpt-6.1-terra --json-out /tmp/cache-diff.json
```

Or use `--requests first.json second.json ...` for locally held capture files;
this mode makes no network calls. Inputs contain complete prompts and should
be kept private. All default output and `--json-out` reports exclude raw
message content and tool arguments; they include content lengths, categories,
changed field names, and abbreviated hashes.

If the optional `tiktoken` package is available, the script estimates how many
JSON-serialized message tokens are preserved using `o200k_base`. Without it,
rough characters/4 estimates are used. **Neither estimate is the exact
model-side cached prefix.** Actual OpenAI cache usage always comes from the
`cached_tokens` values returned by the provider. Implicit caching need not
reuse the full identical prefix.

Typical things to look for:

- An old tool response becoming `Tool call failed to respond` often means
  `sizeLimiter` pruned its content and `toolCallBackfill` inserted a synthetic
  replacement, resetting the prefix at that position.
- Loss or reordering of an intro, topic, or summary system message near the
  beginning usually points to `sizeLimiter` / context reconstruction.
- Repeated `Tool calls completed` sentinels can be replaced by a new assistant
  tool-call message, which changes the tail rather than the stable beginning.
- Unchanged messages and tools but only a small `cached_tokens` count indicate
  a provider-side cache reuse limit or breakpoint issue requiring separate
  investigation; they do **not** prove a changed prompt.

The capture bucket has a seven-day retention policy. Avoid printing or
committing unredacted payloads.
