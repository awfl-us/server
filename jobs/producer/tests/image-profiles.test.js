import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumerImageCatalog, normalizeImageProfile, resolveConsumerImage } from '../imageProfiles.js';

const env = {
  CONSUMER_K8S_IMAGE: 'registry/awfl-lightweight:source-a',
  CONSUMER_BROWSER_K8S_IMAGE: 'registry/awfl-browser:source-a',
  CONSUMER_SCALA_K8S_IMAGE: 'registry/awfl-scala:source-a',
};

test('the catalog advertises only published variants and defaults to lightweight', () => {
  assert.deepEqual(consumerImageCatalog(env).profiles.map(({ id, available }) => [id, available]), [
    ['lightweight', true], ['browser', true], ['scala', true],
  ]);
  assert.equal(consumerImageCatalog({}).profiles.every(p => !p.available), true);
  assert.equal(normalizeImageProfile(), 'lightweight');
});

test('each named image resolves to its own immutable source-addressed tag', () => {
  for (const profile of ['lightweight', 'browser', 'scala']) {
    const { image, imageProfile } = resolveConsumerImage({ imageProfile: profile, env });
    assert.equal(imageProfile, profile);
    assert.equal(image, env[{
      lightweight: 'CONSUMER_K8S_IMAGE',
      browser: 'CONSUMER_BROWSER_K8S_IMAGE',
      scala: 'CONSUMER_SCALA_K8S_IMAGE',
    }[profile]]);
  }
});

test('invalid or unpublished profiles fail closed; no silent fallback', () => {
  assert.throws(() => normalizeImageProfile('custom'), /Unknown image profile/);
  assert.throws(() => resolveConsumerImage({ imageProfile: 'scala', env: {} }), /not published/);
  assert.throws(() => resolveConsumerImage({ imageProfile: 'scala', imageOverride: 'x', env }), /either image or imageProfile/);
  assert.deepEqual(resolveConsumerImage({ imageOverride: 'legacy/image', env: {} }), {
    image: 'legacy/image', imageProfile: null,
  });
});
