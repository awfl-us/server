import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeImageResult, formatToolResult, MAX_IMAGE_BYTES } from '../image.js';

// Small valid PNG fixture. Verify actual wire format, not extension-only matching.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOn+XXcAAAAASUVORK5CYII=',
  'base64',
);
function fileResponse(data, path = '/workspace/capture.png') {
  return {
    text: data.toString('base64'), encoding: 'base64', path,
    size: data.length, next_offset: data.length, truncated: false,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

test('PNG screenshot becomes a genuine MCP image block without base64 text', () => {
  const result = normalizeImageResult(fileResponse(png));
  assert.equal(result.kind, 'image');
  assert.equal(result.mimeType, 'image/png');
  const mcp = formatToolResult(result);
  assert.equal(mcp.isError, false);
  assert.deepEqual(mcp.content.map(x => x.type), ['text', 'image']);
  assert.equal(mcp.content[1].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(mcp.content[1].data, 'base64'), png);
  assert.equal(mcp.content[0].text.includes(png.toString('base64')), false);
});

test('JPEG and WebP magic bytes are recognized, regardless of extension', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  assert.equal(normalizeImageResult(fileResponse(jpeg, '/workspace/a.bin')).mimeType, 'image/jpeg');
  assert.equal(normalizeImageResult(fileResponse(webp, '/workspace/a.bin')).mimeType, 'image/webp');
});

test('partial, oversized, unsupported and tampered image bytes never become MCP images', () => {
  const f = fileResponse(png);
  assert.equal(normalizeImageResult({ ...f, truncated: true }).error.code, 'image_too_large');
  assert.equal(normalizeImageResult({ ...f, size: MAX_IMAGE_BYTES + 1 }).error.code, 'image_too_large');
  assert.equal(normalizeImageResult({ ...f, size: 3 }).error.code, 'invalid_image');
  assert.equal(normalizeImageResult({ ...f, sha256: 'a'.repeat(64) }).error.code, 'invalid_image');
  assert.equal(normalizeImageResult({ ...f, text: '!not base64' }).error.code, 'invalid_image');
  assert.equal(normalizeImageResult(fileResponse(Buffer.from('hello'))).error.code, 'unsupported_image');
  const error = normalizeImageResult({ state: 'failed', error: { code: 'permission_denied' } });
  assert.equal(formatToolResult(error).isError, true);
});

test('an invalid stored image result cannot emit an image block', () => {
  const mcp = formatToolResult({ kind: 'image', mimeType: 'text/html', data: '<script/>' });
  assert.equal(mcp.isError, true);
  assert.deepEqual(mcp.content.map(c => c.type), ['text']);
});
