# Firestore document Storage adapter

This implements the provider-independent `Storage` interface in `storage/document/contract.js`, alongside the PostgreSQL JSONB adapter. Firestore Admin SDK is isolated in `storage/firestore/storage.js`; `storage/factory.js` is the common composition root, and the native memory workflow experiment uses `storage/nativeMemory.js`.

## Contract and compatibility

- Hierarchical `collection/document/...` paths; JSON document snapshots with `id`, `path`, `data`, `revision`, `createdAt`, and `updatedAt`.
- CRUD, create-only conflicts, shallow merge/replace, dotted-field updates, numeric increments, delete fields, server timestamps (ISO string), batch writes, serializable/retried Firestore transactions, basic filtered collections and collection groups, name cursors, counts, and child-collection discovery.
- `__awflStorageMeta` is reserved for the adapter's internal monotonically increasing revision. Legacy documents without the field are read with revision 1; the first updated write sets revision 2. This metadata is stripped from user-visible `data`.
- An initial snapshot and future query/document changes are supported through Firestore `onSnapshot` with unsubscribe and error isolation. Firestore does **not** expose an application-retained, durable, commit-ordered change log. `subscribe(...,{afterCursor})` therefore rejects explicitly with `UNSUPPORTED` rather than pretending to provide PostgreSQL's durable replay.
- The common contract is deliberately **strict JSON**: Firestore Timestamp/GeoPoint/Blob/DocumentReference and non-JSON legacy values are not yet transcoded. Application migration must audit these values and add portable codecs. The adapter is not a universal drop-in replacement for all current direct Firebase SDK calls yet.
- Query grammar is a subset of Firestore and PostgreSQL features, not exhaustive Firestore index/query parity. Complex filters, range/order combinations, non-name cursors, null/missing ordering, projections, listener diff semantics and large-scale change-log retention need explicit conformance work before moving all server modules.

## Instantiation

```js
import { getFirestore } from 'firebase-admin/firestore';
import { createStorage } from './storage/factory.js';

// Existing initialized Firebase Admin app from service composition root.
const store = createStorage({ firestoreDb: getFirestore() });
const doc = await store.get('users/example/projects/project-one');
```

`AWFL_DOCUMENT_STORAGE_BACKEND=firestore` is the default. `postgres` selects the injected PostgreSQL pool. Invalid or missing clients fail closed. Instantiating the factory by itself does **not** change production routing or existing Firestore collections.

## Native memory execution opt-in

`storage/nativeMemory.js` composes the same `Storage` table/collection via `DocumentAtomicRecords` and `NativeMemoryExecutionPilotStore` (no separate SQL table). There is an additional **experimental** service-wide feature flag:

```
AWFL_NATIVE_DOCUMENT_STORE_ENABLED=1
AWFL_NATIVE_MEMORY_EXECUTION_ENABLED=1
AWFL_DOCUMENT_STORAGE_BACKEND=firestore|postgres
# When postgres: AWFL_POSTGRES_URL or PGHOST, PGUSER, PGDATABASE, ...
```

When enabled, Workflows creation, Jobs execution, and native status/cancel use the selected document store. Only **native memory-root** execution is supported; durable journal workflows, detached child recovery and existing in-flight Firestore executions are not migrated. Incompatible new durable roots fail closed. The flag must be set **consistently across Workflows, Jobs and persistent GKE workers**, and only in isolated tests/empty deployments until the migration and recovery model have been verified. Do not enable on existing production instances or switch a running execution between databases.

Current production remains entirely on the pre-existing Firestore paths. Existing `NativeExecutionStore` durable state and Firebase `/firebase/*` endpoint have not been migrated.

## Testing

```bash
node --test test/storage/storageFactory.test.mjs test/storage/documentContract.test.mjs \
  test/storage/nativeRouting.test.mjs
# Real Firestore tests in isolated random namespaces (with automatic cleanup).
# Firestore emulator also supported via FIRESTORE_EMULATOR_HOST.
GOOGLE_ACCESS_TOKEN_FILE=/path/to/injected/token \
  node --test test/storage/firestoreDocuments.integration.test.mjs \
  test/storage/nativeComposition.integration.test.mjs
# PG test of same composition requires a running SQL proxy and a test database.
PGTEST_URL='postgresql://<username>@127.0.0.1:5433/awfl_bench' \
  node --test test/storage/nativeComposition.integration.test.mjs
```

The GKE lightweight consumer uses Node 20, but AWFL production specifies Node 22. Ensure tests also pass under Node 22 in the normal CI environment before production enablement. Integration tests do **not** run against live databases unless explicitly provided a test URL or token file. A passed test against a managed instance is not evidence that every legacy Firestore call site has been migrated.
