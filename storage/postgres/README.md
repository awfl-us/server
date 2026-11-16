# AWFL PostgreSQL document Storage — M0 implementation

**Status:** Initial real PostgreSQL adapter; **not the active AWFL application backend**. Firestore remains the source of truth for existing user/project data and native executions. The target is `db-f1-micro` Cloud SQL PostgreSQL 15, with the same shared `Storage` interface for all document operations. See `docs/postgres-storage-migration-plan.md`.

## Implemented

- Independent `storage/document/contract.js` defines `Storage` methods (`get`, `create`, `put`, `update`, `delete`, `query`, `count`, `listCollections`, `batch`, `transaction`, `subscribe`, `close`), hierarchical document paths, normalized errors, JSON checks, numeric safety and typed field patches. It imports **no Firebase, GCP or SQL SDK**.
- `storage/postgres/storage.js` implements the interface using an injected `pg.Pool`: JSONB row storage, path-scoped collections, basic field predicates, collection-group queries, order/limit/name cursors, create-only writes, merge/replace, delete, atomic batches and `SERIALIZABLE` transactions with bounded retries.
- `storage/postgres/schema.sql` defines a path-preserving document table, lightweight commit-time `LISTEN`/`NOTIFY` wakeups, and independent durable session/project event streams. Generic document writes no longer update a global cursor or write change-log snapshots.
- `subscribe(target, listener)` delivers an initial document/query snapshot, then coalesced refreshed state on relevant notifications, with periodic reconciliation to recover from missed notifications. **Document subscriptions are state watches, not event histories**: `afterCursor` now returns `UNSUPPORTED` explicitly. One SQL listener connection is shared across local watches; it is not one connection per session.

- PostgreSQL-specific `appendEvent({scope,streamId,eventId,payload})`, `replayEvents({scope,streamId,afterCursor,limit})`, and `subscribeEvents(target, listener, {afterCursor})` implement durable per-session or per-project replay with idempotent IDs, per-stream commit-safe cursors and wakeups. This is a separate feature from the provider-neutral document `Storage` interface; it is **not wired into the existing Firestore-backed SSE/event relay yet**.

## Use / tests

The caller manages pool size/identity. Cloud SQL benchmark user `awfl-consumer@awfl-us.iam` uses an authenticated local proxy (`--auto-iam-authn`) instead of a password. With 25 maximum server connections on shared-core, budget small pools across API/Jobs/GKE processes and do not allocate a connection per workflow/session.

For an isolated development/test database:

```js
import pg from 'pg';
import { PostgresStorage } from './storage/postgres/storage.js';
const pool = new pg.Pool({ connectionString: process.env.PGTEST_URL, max: 4 });
const storage = new PostgresStorage({ pool, ownPool: true });
await storage.initialize(); // tests/setup ONLY: executes schema.sql
await storage.create('users/example/projects/my-project', { status: 'ready' });
await storage.close();
```

Do **not** call `initialize()` at ordinary production service startup. Check in/review versioned SQL migrations and run them explicitly before rolling out a schema. Do not run DDL against the existing production Firestore database (it is a different service). The benchmark instance is a separate managed Cloud SQL database.

```bash
node --test test/storage/documentContract.test.mjs
node --test test/storage/*.test.mjs
PGTEST_URL='postgresql://awfl-consumer%40awfl-us.iam@127.0.0.1:5433/awfl_bench' \
  node --test test/storage/postgresDocuments.integration.test.mjs
```

`PGTEST_URL` is required for **real** database integration tests; otherwise those cases explicitly skip. Tests use randomized namespaces and remove test documents. The schema and change-log tables are intentionally retained in the benchmark database.

## Upgrade migration and contention verification

The standalone upgrade SQL is `storage/postgres/migrations/001_scoped_event_streams.sql`. Apply it explicitly in an isolated PostgreSQL environment after updating every process that depends on the old global-cursor replay contract:

```sh
psql "$PGTEST_URL" -v ON_ERROR_STOP=1 -f storage/postgres/migrations/001_scoped_event_streams.sql
```

The migration preserves old `awfl_storage_cursor` and `awfl_storage_changes` history for inspection, but new document changes are no longer appended there. It does **not** migrate old history into session/project streams; no production switch is implied. The `schema.sql` file is for fresh test databases only. Repeated snapshot notifications may be coalesced; use `subscribeEvents` only where every event must be retained and replayed.

To reproduce a before/after test on an **isolated database** (never production), run the legacy trigger fixture, the same benchmark, migration 001, then the benchmark again. CI does this against PostgreSQL 15 and reports p50/p95/p99 and throughput for independent concurrent create/put/serializable-update.

## Known gaps before any production switch

1. **Query equivalence:** The current query grammar covers basic scalar and array predicates and name cursors. Full Firestore composite-index semantics, type ordering, non-name cursors, field projection, reverse pagination, collection-group scoping and related edge cases require an application-callsite inventory, SQL indexes and conformance tests. Unsupported cursor modes fail closed.
2. **Subscriptions:** Document watches now converge on current state but deliberately do not replay every intermediate mutation. Query watches still re-evaluate the full query instead of emitting exact Firestore `added/modified/removed` diffs. Stream retention/compaction, high-scale watcher polling/reconnection and event-relay wiring remain. The full platform migration must route actual session/project SSE writes through durable streams before cutover.
3. **Data compatibility:** Only strict JSON values are supported. Legacy Firestore `Timestamp`, bytes, GeoPoint, reference types and Firestore-specific null/missing ordering need codecs before existing records are migrated. Service-layer project/tenant authorization is still mandatory; this general-purpose adapter does not grant or check user permissions.
4. **Runtime integration:** Neither `jobs/native.js`, Workflows execution creation nor native status/cancel yet constructs this adapter in production. The M1 next step is to compose a single backend choice **across all four paths**, prove real compiled native memory workflows, and handle existing Firestore executions rather than accidentally splitting their records.
5. **Operationalization:** Promote the benchmark SQL instance carefully through Terraform, add a versioned migration runner and evaluate backups/restore before trusting irreplaceable data. No new instance tier is planned; do not benchmark dedicated-core merely to fix the accepted p99 outliers.

These gaps are deliberate. A method existing on the interface does not mean all Firestore behavior is production-conformant. The M0 implementation is a tested foundation, not a completed full-platform migration.
