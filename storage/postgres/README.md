# AWFL PostgreSQL document Storage — M0 implementation

**Status:** Initial real PostgreSQL adapter; **not the active AWFL application backend**. Firestore remains the source of truth for existing user/project data and native executions. The target is `db-f1-micro` Cloud SQL PostgreSQL 15, with the same shared `Storage` interface for all document operations. See `docs/postgres-storage-migration-plan.md`.

## Implemented

- Independent `storage/document/contract.js` defines `Storage` methods (`get`, `create`, `put`, `update`, `delete`, `query`, `count`, `listCollections`, `batch`, `transaction`, `subscribe`, `close`), hierarchical document paths, normalized errors, JSON checks, numeric safety and typed field patches. It imports **no Firebase, GCP or SQL SDK**.
- `storage/postgres/storage.js` implements the interface using an injected `pg.Pool`: JSONB row storage, path-scoped collections, basic field predicates, collection-group queries, order/limit/name cursors, create-only writes, merge/replace, delete, atomic batches and `SERIALIZABLE` transactions with bounded retries.
- `storage/postgres/schema.sql` is a version-0 migration for `awfl_documents`, indexes, a transactionally ordered change log and an `AFTER` trigger using PostgreSQL `LISTEN`/`NOTIFY`. The trigger writes the change event in the **same transaction** as each document mutation. One global cursor row locks to establish commit order; this may become a throughput bottleneck, and must be measured before substantial production scale. Document change events retain their committed data snapshots; notification payloads contain only a cursor.
- `subscribe(target, listener, { afterCursor? })` delivers an initial snapshot, then ordered committed change events from an optional previously persisted cursor, using a shared listener connection plus polling fallback. Both document and query subscriptions exist. `DocumentAtomicRecords` bridges the existing memory-execution pilot into **the same** generic document table, rather than creating a separate PostgreSQL state store.

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

## Known gaps before any production switch

1. **Query equivalence:** The current query grammar covers basic scalar and array predicates and name cursors. Full Firestore composite-index semantics, type ordering, non-name cursors, field projection, reverse pagination, collection-group scoping and related edge cases require an application-callsite inventory, SQL indexes and conformance tests. Unsupported cursor modes fail closed.
2. **Subscriptions:** Document changes have precise committed snapshots. Query watchers re-evaluate the current query upon each event rather than computing exact Firestore `added/modified/removed` diffs. Retention/compaction, bounded history, listener reconnection faults, query readiness under concurrent writes and high-scale cursor partitioning need further testing/design.
3. **Data compatibility:** Only strict JSON values are supported. Legacy Firestore `Timestamp`, bytes, GeoPoint, reference types and Firestore-specific null/missing ordering need codecs before existing records are migrated. Service-layer project/tenant authorization is still mandatory; this general-purpose adapter does not grant or check user permissions.
4. **Runtime integration:** Neither `jobs/native.js`, Workflows execution creation nor native status/cancel yet constructs this adapter in production. The M1 next step is to compose a single backend choice **across all four paths**, prove real compiled native memory workflows, and handle existing Firestore executions rather than accidentally splitting their records.
5. **Operationalization:** Promote the benchmark SQL instance carefully through Terraform, add a versioned migration runner and evaluate backups/restore before trusting irreplaceable data. No new instance tier is planned; do not benchmark dedicated-core merely to fix the accepted p99 outliers.

These gaps are deliberate. A method existing on the interface does not mean all Firestore behavior is production-conformant. The M0 implementation is a tested foundation, not a completed full-platform migration.
