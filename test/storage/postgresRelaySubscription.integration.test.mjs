import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const enabled = Boolean(process.env.PGTEST_URL);

// Reproduce a live project that accumulated over 1,000 relay records.
// A bounded ascending query watches only historical events and never
// observes newly appended MCP/agent commands.
test('PostgreSQL relay sees a new event with 1005 existing project events',
  { skip: !enabled, timeout: 45000 }, async () => {
    const { default: pg } = await import('pg');
    const { PostgresStorage } = await import('../../storage/postgres/storage.js');
    const pool = new pg.Pool({ connectionString: process.env.PGTEST_URL, max: 4 });
    const storage = new PostgresStorage({ pool, ownPool: false, pollIntervalMs: 200 });
    await storage.initialize();
    process.env.AWFL_DOCUMENT_STORAGE_BACKEND = 'postgres';

    const { configureDocumentStorageClients, getDocumentStorage } =
      await import('../../storage/service.js');
    configureDocumentStorageClients({ postgresPool: pool });
    const { pickBackend } = await import('../../workflows/events/model.js');
    const backend = pickBackend('relay-unit-user', randomUUID().replaceAll('-', ''));
    const collection = backend.projectCollection();

    let stop;
    try {
      await pool.query(`INSERT INTO awfl_documents
        (path, collection_path, collection_id, document_id, data)
        SELECT $1 || '/historical_' || lpad(n::text, 5, '0'),
          $1, 'relayEvents', 'historical_' || lpad(n::text, 5, '0'),
          jsonb_build_object('id', 'historical_' || lpad(n::text, 5, '0'),
            'create_time', '2025-01-01T00:00:00.000Z',
            'projectId', 'historical', 'type', 'message', 'data', '{}'::jsonb)
        FROM generate_series(1, 1005) AS n`, [collection]);

      const received = [];
      stop = await backend.subscribeProject(event => received.push(event.id));
      const id = 'fresh_' + randomUUID().replaceAll('-', '');
      await backend.append({ id, create_time: new Date().toISOString(),
        projectId: 'historical', type: 'message', source: 'mcp',
        data: { mcp: { execution_id: 'test' } } });

      const deadline = Date.now() + 7000;
      while (!received.includes(id) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 35));
      }
      assert.ok(received.includes(id),
        'fresh MCP event must not be excluded by an ascending 1000-row limit');
    } finally {
      await stop?.();
      await pool.query('DELETE FROM awfl_documents WHERE collection_path=$1', [collection]);
      await (await getDocumentStorage()).close();
      await pool.end();
    }
  });
