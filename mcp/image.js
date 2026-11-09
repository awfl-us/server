import { createHash } from 'node:crypto';

// A 640 KiB image encodes to <= 854 KiB of base64, below the existing
// 1 MiB callback request limit and Firestore's 1 MiB document limit.
export const MAX_IMAGE_BYTES = 640 * 1024;

function mimeTypeOf(bytes) {
  if (bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (bytes.length >= 4 &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function failure(code, message) {
  return { state: 'failed', error: { code, message, retryable: false } };
}

// Convert the existing READ_FILE base64 result to a validated media response.
// Never expose partial file bytes as a seemingly valid screenshot.
export function normalizeImageResult(result) {
  if (result?.error || result?.state === 'failed') return result;
  if (!result || typeof result !== 'object' ||
      result.encoding !== 'base64' || typeof result.text !== 'string' ||
      !Number.isSafeInteger(result.size) || result.size < 1 ||
      result.size > MAX_IMAGE_BYTES || result.truncated) {
    if (result?.truncated || result?.size > MAX_IMAGE_BYTES) {
      return failure('image_too_large',
        'Image exceeds 640 KiB. Recapture with Playwright as JPEG at quality 75-85, or use a smaller viewport.');
    }
    return failure('invalid_image', 'No complete image was returned by the consumer.');
  }
  // Reject malformed or noncanonical base64 before decoding or storage.
  if (result.text.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(result.text)) {
    return failure('invalid_image', 'Invalid screenshot encoding.');
  }
  const bytes = Buffer.from(result.text, 'base64');
  if (bytes.toString('base64') !== result.text || bytes.length !== result.size ||
      result.next_offset !== bytes.length) {
    return failure('invalid_image', 'Screenshot content is incomplete or inconsistent.');
  }
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (result.sha256 !== actualHash) {
    return failure('invalid_image', 'Screenshot checksum does not match.');
  }
  const mimeType = mimeTypeOf(bytes);
  if (!mimeType) {
    return failure('unsupported_image', 'Only PNG, JPEG and WebP image files are supported.');
  }
  return {
    kind: 'image', mimeType, data: result.text,
    path: typeof result.path === 'string' ? result.path : null,
    size: bytes.length, sha256: actualHash,
  };
}

// The normal MCP response stays JSON text. Image tool results and recovered
// request_result outputs contain a genuine MCP ImageContent block instead.
export function formatToolResult(result) {
  if (result?.kind === 'image') {
    if (typeof result.data !== 'string' ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(result.mimeType)) {
      return { isError: true, content: [{ type: 'text', text: 'Invalid image response' }] };
    }
    const { path, size, mimeType, sha256 } = result;
    return {
      content: [
        { type: 'text', text: JSON.stringify({ path, size, mimeType, sha256 }) },
        { type: 'image', data: result.data, mimeType },
      ],
      isError: false,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: Boolean(result?.error &&
      (typeof result.error === 'object' || result.state === 'failed')),
  };
}
