// Controlled consumer image catalog. All variants contain the same AWFL CLI,
// startup entrypoint, lock protocol and credential refresh functionality.
// New consumers require an explicit profile. Existing running consumers keep
// their pinned image when another session attaches without choosing one.

const profiles = [
  { id: 'lightweight', label: 'Lightweight', description: 'Python, Node, Git, GitHub CLI and gcloud. Fastest and smallest environment.', env: 'CONSUMER_K8S_IMAGE' },
  { id: 'browser', label: 'Browser testing', description: 'Lightweight tools plus Chromium and Playwright.', env: 'CONSUMER_BROWSER_K8S_IMAGE' },
  { id: 'scala', label: 'Scala development', description: 'Lightweight tools plus Java 21 and sbt 1.11.', env: 'CONSUMER_SCALA_K8S_IMAGE' },
];

export function normalizeImageProfile(value) {
  if (value == null || value === '') {
    throw new Error('imageProfile is required when starting a new consumer');
  }
  const profile = String(value);
  if (!profiles.some(item => item.id === profile)) {
    throw new Error(`Unknown image profile: ${profile}. Choose lightweight, browser, or scala.`);
  }
  return profile;
}

export function consumerImageCatalog(env = process.env) {
  return {
    default: null,
    profiles: profiles.map(({ id, label, description, env: key }) => ({
      id, label, description, available: Boolean(env[key]),
    })),
  };
}

export function resolveConsumerImage({ imageProfile, imageOverride, env = process.env } = {}) {
  // Existing local/advanced image override remains supported, but is mutually
  // exclusive with a named profile to prevent accidental silent overrides.
  if (imageOverride) {
    if (imageProfile != null && imageProfile !== '') throw new Error('Choose either image or imageProfile, not both');
    return { image: imageOverride, imageProfile: null };
  }
  const profile = normalizeImageProfile(imageProfile);
  const entry = profiles.find(item => item.id === profile);
  const image = env[entry.env];
  if (!image) throw new Error(`The ${profile} image is not published/configured (${entry.env})`);
  return { image, imageProfile: profile };
}
