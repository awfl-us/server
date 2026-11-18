import { randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';

const MAX_PENDING = 32;
const pending = new Set();
let storage;

export function captureOpenAiRequest(payload) {
  const bucket = process.env.AWFL_OPENAI_CONTEXT_CAPTURE_BUCKET;
  if (process.env.AWFL_OPENAI_CONTEXT_CAPTURE_ENABLED !== 'true' || !bucket) return null;
  if (pending.size >= MAX_PENDING) {
    console.warn(JSON.stringify({ event: 'openai_context_capture_dropped', reason: 'queue_full' }));
    return null;
  }
  // Snapshot the exact API payload before sending. Do not capture credentials or headers.
  const id = randomUUID();
  const date = new Date().toISOString().slice(0, 10);
  const object = `${date}/${id}.json`;
  const job = new Promise(resolve => setImmediate(resolve)).then(async () => {
    const json = JSON.stringify(payload);
    storage ||= new Storage();
    await storage.bucket(bucket).file(object).save(json, {
      resumable: false,
      contentType: 'application/json',
      validation: 'crc32c',
      metadata: { cacheControl: 'private, no-store' }
    });
    console.info(JSON.stringify({ event: 'openai_context_capture_saved', capture_id: id, bucket, object, bytes: Buffer.byteLength(json) }));
  }).catch(error => {
    console.error(JSON.stringify({ event: 'openai_context_capture_failed', capture_id: id, error_code: error?.code || 'unknown' }));
  }).finally(() => pending.delete(job));
  pending.add(job);
  return { id, bucket, object };
}

export function logOpenAiCacheUsage(capture, response, durationMs) {
  if (!capture) return;
  const usage = response?.usage;
  console.info(JSON.stringify({
    event: 'openai_context_capture_usage',
    capture_id: capture.id,
    model: response?.model,
    openai_request_id: response?._request_id,
    prompt_tokens: usage?.prompt_tokens ?? null,
    cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    duration_ms: durationMs
  }));
}
