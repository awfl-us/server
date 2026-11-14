// Load FIRST, before any Firebase Admin/Firestore import. Zero instrumentation
// and no exporter SDK loading when the feature is disabled.
export const firestoreTracingEnabled = process.env.AWFL_FIRESTORE_TRACE_ENABLED === '1';

if (firestoreTracingEnabled) {
  // Firestore's beta tracer reads this when constructing its client.
  process.env.FIRESTORE_ENABLE_TRACING = 'ON';

  const rate = Number(process.env.AWFL_FIRESTORE_TRACE_SAMPLE_RATE ?? '1');
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error('AWFL_FIRESTORE_TRACE_SAMPLE_RATE must be between 0 and 1');
  }

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { TraceIdRatioBasedSampler },
    { resourceFromAttributes },
    { GrpcInstrumentation },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-proto'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/instrumentation-grpc'),
  ]);

  const service = process.env.AWFL_NATIVE_PERSISTENT_WORKER === '1'
    ? 'awfl-native-worker'
    : (process.env.SERVICE_TARGET === 'start:api' ? 'awfl-api' : 'awfl-jobs');

  // No automatic HTTP instrumentation: it can record URL query parameters.
  // The request middleware emits deliberately sanitized root request spans.
  // OTLP HTTP/protobuf directly to the Telemetry API. Token refresh happens
  // lazily on every export, without a sidecar or a deprecated GCP exporter.
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const exporter = new OTLPTraceExporter({
    url: 'https://telemetry.googleapis.com/v1/traces',
    headers: async () => {
      const client = await auth.getClient();
      const tokenHeaders = await client.getRequestHeaders();
      return typeof tokenHeaders.entries === 'function'
        ? Object.fromEntries(tokenHeaders.entries())
        : { ...tokenHeaders };
    },
  });
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': service,
      'gcp.project_id': process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'awfl-us',
    }),
    sampler: new TraceIdRatioBasedSampler(rate),
    traceExporter: exporter,
    instrumentations: [new GrpcInstrumentation()],
  });
  await sdk.start();
  console.info('[firestore-tracing] enabled', { service, sampleRate: rate });

  // Cloud Run SIGTERM should continue to use the existing application
  // lifecycle. We batch asynchronously rather than delaying every DB call.
  process.once('beforeExit', () => { void sdk.shutdown().catch(() => {}); });
}
