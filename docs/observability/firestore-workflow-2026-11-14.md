# AWFL workflow Firestore latency: production audit (November 14, 2026)

This is a **read-only, quantified baseline** for the 30-minute production window 04:25–04:55 UTC (11:25–11:55 PM ET, November 13). The trace collection started when 100% sampling was deployed. The workload is bursty: most context-building requests in the observed window happened in the first eight minutes. Results describe observed behavior, **not guaranteed savings**.

### Workflow-focused priority assessment

| Priority | Code path / anti-pattern | Observed production impact | Action |
|---|---|---|---|
| **1. Investigate** | `workflows/native/executionStore.js` and detached/background execution | Jobs emitted **919 `Transaction.Run` spans** (p50 **170 ms**, p95 **733 ms**); **815** started after the original HTTP span ended. Persistent GKE worker emitted **170 more transactions** (p50 73 ms). | Instrument named store operations (`claim`, `prepareEffect`, `recordEffect`, `complete`, `fork`) before changing durability. The SDK trace lacks method-level call-site attribution. Preserve atomicity where required. |
| **2. Optimize** | `workflows/context/topicContextYoj.js` + `context/filters/collapseGroupReplacer.js` | **11 context builds**, p50 **752 ms**, p95 **1,117 ms**, 299 logical SDK operations (**222 individual gets + 77 queries**). p50 DB-active **719 ms**. | Parallelize independent context queries while preserving output order; deduplicate overlapping reads; use Firestore `getAll` for mapping doc refs (rather than hundreds of `doc.get` promises) and skip missing collapse metadata. |
| **3. Optimize** | `workflows/events/model.js` writes project and legacy session copies sequentially | **38 events requests**, **76 document sets**, ~138–155 ms median per request across routed/unrouted spans. | Batch both writes as a single commit, or remove legacy copy after consumer audit. This cuts round trips, not billed document writes. |
| **4. Optimize** | `jobs/workflows.exec.js` status updates | **7 requests**, **4 operations/request** (get + set + query + set), p50 **169 ms**, p95 **296 ms**. | Avoid a query to discover the registration record and avoid status duplication where possible; preserve created time via create-only/merge logic. |
| **5. Review frequency** | `jobs/firebaseDbApi.js` lock and cache primitives | **36 lock acquisitions** (1 transaction each), p50 **116 ms**, p95 **491 ms**; **20 Jobs `ListCollections` calls** p50 **101 ms** despite generic cache/document reads not needing child collection names. | Keep atomic locks, remove needless lock acquisitions; make subcollection lookup opt-in for `Firebase.read`/`Cache.scala`. |
| **6. Lower priority** | `jobs/producer/start.js` and `jobs/firebaseDbApi.js` segment scans | Producer: **19 calls**, 3 SDK operations/request, p50 **224 ms**. Segment scans: **20 calls**, p50 **53 ms**, p95 **322 ms**; the query reads all message timestamps. | Avoid redundant start queries; maintain segment index or derived metadata when scan volume grows. |

**What cannot yet be ranked reliably:** SDK spans on native/background workers only report operation types, not the corresponding `NativeExecutionStore` method or Firestore collection. Also, many API request spans lack a sanitized route template. The next tracing change should add **fixed operation names** (without user IDs or document paths) around native state mutations and context/filter stages, plus route templates on HTTP spans. This is required to turn broad transaction counts into an actionable method-by-method optimization plan.

**Measurement semantics:** ``DB-covered`` is the union of SDK-active intervals *within each request*. It avoids double-counting parallel/nested SDK calls within a request, but it **is not an estimate of saved milliseconds**. Summing coverage across concurrent HTTP requests can still overlap in real time. Firestore SDK operation counts are not billable document counts.

**Reproduce:** `python3 scripts/firestore_workflow_report.py --start 2026-11-14T04:25:00Z --end 2026-11-14T04:55:00Z --out /tmp/awfl-workflow-firestore` from `server`; requires `requests`, `gcloud` auth, and Cloud Trace read permissions. Generates a redacted aggregate `.md` and `.json`; no raw traces or credentials are written. Use `python3 -m unittest discover -s scripts -p 'test_firestore_workflow_report.py'` for offline tests.

---

# AWFL Firestore workflow latency report
Window UTC: `2026-11-14T04:25:00Z` — `2026-11-14T04:55:00Z` (Cloud Trace; complete pagination)

Traces: **2177**, source spans: **26409** (some source trace spans fall outside window), HTTP requests **starting in window**: **1634**.

## Interpretation
- Request and SDK start timestamps are filtered to the stated UTC window. Source traces can include later asynchronous activity that is excluded from operation counts.
- **DB-covered ms** = union of top-level Firestore SDK operation intervals within an HTTP request, **not a proven reduction in latency**. Nested SDK spans are counted once; concurrent operations overlap rather than add.
- **Aggregate DB-covered sum** adds request-level coverage and may double-count concurrent requests; use for workload prioritization, not overall wall-clock saved.
- Method counts are logical SDK invocations, not billable Firestore reads/writes. No code-location/document-path tags are collected. An endpoint can contain unrelated work.
- Unattributed operations are tracked separately. Cross-request trace linkage may not always be complete; labels indicate sampled services and endpoints only.

## Services
| Service | HTTP requests | Top-level SDK operations | Sum DB-covered request time |
|---|---:|---:|---:|
| awfl-api | 1272 | 9226 | 229.0s |
| awfl-jobs | 362 | 820 | 48.5s |

## All top-level logical SDK calls by service (including background/unattributed)
- **awfl-native-worker:** DocumentReference.Get=337, Transaction.Run=170, Query.Get=115
- **awfl-api:** DocumentReference.Get=4447, DocumentReference.ListCollections=2250, Query.Get=1536, Transaction.Run=635, DocumentReference.Set=253, DocumentReference.Update=105
- **awfl-jobs:** Transaction.Run=919, DocumentReference.Get=876, Query.Get=299, DocumentReference.Set=105, DocumentReference.Create=94, DocumentReference.Update=24, DocumentReference.ListCollections=20

## SDK calls not contained within a live HTTP request
| Service | Why | Method | Count | p50/p95 SDK |
|---|---|---|---:|---:|
| awfl-jobs | after-http-response | `Transaction.Run` | 815 | 177/858ms |
| awfl-jobs | after-http-response | `DocumentReference.Get` | 587 | 60/190ms |
| awfl-native-worker | no-http-ancestor | `DocumentReference.Get` | 337 | 26/70ms |
| awfl-native-worker | no-http-ancestor | `Transaction.Run` | 170 | 72/162ms |
| awfl-native-worker | no-http-ancestor | `Query.Get` | 115 | 41/122ms |
| awfl-jobs | after-http-response | `Query.Get` | 115 | 93/232ms |

## Routes ranked by DB-covered request time (Jobs first)
| Service | Route | N requests | p50/p95 request | p50/p95 DB-covered | Calls/request p50/p95 | Total SDK ops | Sum DB-covered |
|---|---|---:|---:|---:|---:|---:|---:|
| awfl-jobs | `/context/topicContextYoj/run` | 11 | 752/1117ms | 719/1069ms | 32/41 | 299 | 6.9s |
| awfl-jobs | `/firebase/create` | 75 | 70/160ms | 68/158ms | 1/1 | 75 | 5.8s |
| awfl-jobs | `/firebase/locks/acquire` | 36 | 116/491ms | 113/489ms | 1/1 | 36 | 5.7s |
| awfl-jobs | `(unrouted:firebase)` | 50 | 72/405ms | 70/402ms | 1/1 | 70 | 5.5s |
| awfl-jobs | `/producer/start` | 19 | 224/323ms | 220/318ms | 3/3 | 57 | 4.3s |
| awfl-jobs | `/events` | 19 | 155/345ms | 153/342ms | 2/2 | 38 | 3.6s |
| awfl-jobs | `(unrouted:events)` | 19 | 138/314ms | 137/312ms | 2/2 | 38 | 2.8s |
| awfl-jobs | `/native/execute` | 1 | 23993/23993ms | 2464/2464ms | 35/35 | 35 | 2.5s |
| awfl-jobs | `/firebase/segmentsForSession` | 20 | 53/322ms | 51/313ms | 1/1 | 20 | 2.1s |
| awfl-jobs | `/firebase/update` | 18 | 73/126ms | 71/124ms | 1/1 | 18 | 1.3s |
| awfl-jobs | `/workflows/exec/status/update` | 7 | 169/296ms | 165/292ms | 4/4 | 28 | 1.2s |
| awfl-jobs | `/llm/chat` | 9 | 6525/11663ms | 132/187ms | 2/2 | 18 | 1.2s |
| awfl-jobs | `/tasks/by-session/:id` | 16 | 55/121ms | 52/118ms | 1/1 | 16 | 1.0s |
| awfl-jobs | `/firebase/locks/release` | 8 | 124/196ms | 122/192ms | 1/1 | 8 | 1.0s |
| awfl-jobs | `/callbacks` | 21 | 45/64ms | 43/62ms | 1/1 | 21 | 0.9s |
| awfl-jobs | `(unrouted:tasks)` | 8 | 65/92ms | 62/88ms | 1/1 | 8 | 0.5s |
| awfl-jobs | `(unrouted:workflows)` | 2 | 254/258ms | 245/254ms | 4/4 | 8 | 0.5s |
| awfl-jobs | `/agents/session/:id` | 7 | 52/106ms | 51/102ms | 1/1 | 7 | 0.4s |
| awfl-jobs | `(unrouted:other)` | 1 | 280/280ms | 274/274ms | 3/3 | 3 | 0.3s |
| awfl-jobs | `/tasks/:id` | 1 | 275/275ms | 272/272ms | 3/3 | 3 | 0.3s |
| awfl-jobs | `/agents/project-manager/tools` | 5 | 66/112ms | 52/59ms | 1/1 | 5 | 0.3s |
| awfl-jobs | `(unrouted:agents)` | 4 | 62/185ms | 48/102ms | 1/1 | 4 | 0.2s |
| awfl-jobs | `(unrouted:context)` | 4 | 46/57ms | 42/49ms | 1/1 | 4 | 0.2s |
| awfl-jobs | `/tasks` | 1 | 52/52ms | 47/47ms | 1/1 | 1 | 0.0s |
| awfl-api | `(unrouted:workflows)` | 1034 | 94/664ms | 91/625ms | 2/40 | 8302 | 175.7s |
| awfl-api | `(unrouted:mcp)` | 46 | 1604/11244ms | 699/1405ms | 16/22 | 631 | 34.1s |
| awfl-api | `/workflows/projects/:id/consumer-heartbeat` | 166 | 74/186ms | 71/181ms | 1/1 | 166 | 14.3s |
| awfl-api | `/workflows/exec/status/latest/:id` | 1 | 1378/1378ms | 1141/1141ms | 6/6 | 6 | 1.1s |
| awfl-api | `/workflows/context/topicContextYoj/run` | 1 | 967/967ms | 957/957ms | 32/32 | 32 | 1.0s |
| awfl-api | `(unrouted:other)` | 13 | 74/390ms | 21/312ms | 1/4 | 16 | 0.8s |
| awfl-api | `/mcp` | 1 | 1548/1548ms | 517/517ms | 18/18 | 18 | 0.5s |
| awfl-api | `/workflows/callbacks/:id` | 3 | 133/151ms | 128/147ms | 3/4 | 10 | 0.4s |
| awfl-api | `/workflows/context/sessions/list` | 2 | 142/155ms | 140/152ms | 19/19 | 38 | 0.3s |
| awfl-api | `/workflows/tasks/by-session/:id` | 1 | 924/924ms | 276/276ms | 1/1 | 1 | 0.3s |
| awfl-api | `/workflows/events/cursors` | 2 | 102/113ms | 98/110ms | 2/2 | 4 | 0.2s |
| awfl-api | `(unrouted:oauth)` | 1 | 307/307ms | 194/194ms | 1/1 | 1 | 0.2s |
| awfl-api | `/workflows/projects/:id/consumer-lock/acquire` | 1 | 178/178ms | 169/169ms | 1/1 | 1 | 0.2s |

## Jobs SDK operation latency (including background)
| Method | Count | p50 | p95 | max |
|---|---:|---:|---:|---:|
| `Transaction.Run` | 919 | 169.8ms | 732.6ms | 1802.9ms |
| `DocumentReference.Get` | 876 | 68.6ms | 191.5ms | 801.2ms |
| `Query.Get` | 299 | 73.2ms | 170.2ms | 554.2ms |
| `DocumentReference.Set` | 105 | 64.9ms | 164.6ms | 478.7ms |
| `DocumentReference.Create` | 94 | 66.2ms | 209.6ms | 513.8ms |
| `DocumentReference.Update` | 24 | 70.7ms | 122.3ms | 129.1ms |
| `DocumentReference.ListCollections` | 20 | 100.5ms | 107.0ms | 109.1ms |

## Top-level SDK operations (all services)
| Method | Count | p50 | p95 | max |
|---|---:|---:|---:|---:|
| `DocumentReference.Get` | 5660 | 69.6ms | 198.4ms | 1158.1ms |
| `DocumentReference.ListCollections` | 2270 | 41.7ms | 126.1ms | 278.1ms |
| `Query.Get` | 1950 | 49.4ms | 124.7ms | 1115.7ms |
| `Transaction.Run` | 1724 | 106.6ms | 440.7ms | 1802.9ms |
| `DocumentReference.Set` | 358 | 53.8ms | 131.0ms | 539.4ms |
| `DocumentReference.Update` | 129 | 47.7ms | 113.3ms | 310.1ms |
| `DocumentReference.Create` | 94 | 66.2ms | 209.6ms | 513.8ms |

## Top routes: method mix
- **awfl-api `(unrouted:workflows)`** (1034 requests): DocumentReference.Get=3999, DocumentReference.ListCollections=2214, Query.Get=1432, Transaction.Run=437, DocumentReference.Set=169, DocumentReference.Update=51
- **awfl-api `(unrouted:mcp)`** (46 requests): DocumentReference.Get=385, Query.Get=89, DocumentReference.Set=79, DocumentReference.Update=52, Transaction.Run=26
- **awfl-api `/workflows/projects/:id/consumer-heartbeat`** (166 requests): Transaction.Run=166
- **awfl-jobs `/context/topicContextYoj/run`** (11 requests): DocumentReference.Get=222, Query.Get=77
- **awfl-jobs `/firebase/create`** (75 requests): DocumentReference.Create=75
- **awfl-jobs `/firebase/locks/acquire`** (36 requests): Transaction.Run=36
- **awfl-jobs `(unrouted:firebase)`** (50 requests): DocumentReference.ListCollections=20, DocumentReference.Create=19, Transaction.Run=16, Query.Get=9, DocumentReference.Update=6
- **awfl-jobs `/producer/start`** (19 requests): Query.Get=38, Transaction.Run=19
- **awfl-jobs `/events`** (19 requests): DocumentReference.Set=38
- **awfl-jobs `(unrouted:events)`** (19 requests): DocumentReference.Set=38
- **awfl-jobs `/native/execute`** (1 requests): Transaction.Run=24, DocumentReference.Get=10, Query.Get=1
- **awfl-jobs `/firebase/segmentsForSession`** (20 requests): Query.Get=20
- **awfl-jobs `/firebase/update`** (18 requests): DocumentReference.Update=18
- **awfl-jobs `/workflows/exec/status/update`** (7 requests): DocumentReference.Set=14, DocumentReference.Get=7, Query.Get=7
- **awfl-jobs `/llm/chat`** (9 requests): DocumentReference.Get=9, DocumentReference.Set=9
- **awfl-api `/workflows/exec/status/latest/:id`** (1 requests): DocumentReference.Get=5, Query.Get=1
- **awfl-jobs `/tasks/by-session/:id`** (16 requests): Query.Get=16
- **awfl-jobs `/firebase/locks/release`** (8 requests): Transaction.Run=8
- **awfl-api `/workflows/context/topicContextYoj/run`** (1 requests): DocumentReference.Get=23, Query.Get=9
- **awfl-jobs `/callbacks`** (21 requests): DocumentReference.Get=21
- **awfl-api `(unrouted:other)`** (13 requests): DocumentReference.Get=16
- **awfl-api `/mcp`** (1 requests): DocumentReference.Get=10, DocumentReference.Set=3, Query.Get=2, DocumentReference.Update=2, Transaction.Run=1
- **awfl-jobs `(unrouted:tasks)`** (8 requests): Query.Get=8
- **awfl-jobs `(unrouted:workflows)`** (2 requests): DocumentReference.Set=4, DocumentReference.Get=2, Query.Get=2
- **awfl-api `/workflows/callbacks/:id`** (3 requests): DocumentReference.Get=7, Transaction.Run=3
- **awfl-jobs `/agents/session/:id`** (7 requests): DocumentReference.Get=7
- **awfl-api `/workflows/context/sessions/list`** (2 requests): DocumentReference.ListCollections=36, Query.Get=2
- **awfl-api `/workflows/tasks/by-session/:id`** (1 requests): Query.Get=1
- **awfl-jobs `(unrouted:other)`** (1 requests): Query.Get=2, Transaction.Run=1
- **awfl-jobs `/tasks/:id`** (1 requests): DocumentReference.Get=2, DocumentReference.Set=1
- **awfl-jobs `/agents/project-manager/tools`** (5 requests): DocumentReference.Get=5
- **awfl-jobs `(unrouted:agents)`** (4 requests): DocumentReference.Get=4
- **awfl-api `/workflows/events/cursors`** (2 requests): DocumentReference.Get=2, DocumentReference.Set=2
- **awfl-api `(unrouted:oauth)`** (1 requests): Transaction.Run=1
- **awfl-api `/workflows/projects/:id/consumer-lock/acquire`** (1 requests): Transaction.Run=1

## Largest individual requests
- awfl-jobs `/native/execute`: 23993ms total, 2465ms DB-covered, 35 SDK operations
- awfl-api `(unrouted:mcp)`: 11954ms total, 1760ms DB-covered, 16 SDK operations
- awfl-api `(unrouted:mcp)`: 3453ms total, 1646ms DB-covered, 19 SDK operations
- awfl-api `(unrouted:mcp)`: 1863ms total, 1405ms DB-covered, 19 SDK operations
- awfl-api `(unrouted:mcp)`: 2061ms total, 1403ms DB-covered, 21 SDK operations
- awfl-api `(unrouted:mcp)`: 11414ms total, 1374ms DB-covered, 16 SDK operations
- awfl-api `(unrouted:mcp)`: 1805ms total, 1341ms DB-covered, 19 SDK operations
- awfl-api `(unrouted:workflows)`: 3599998ms total, 1334ms DB-covered, 25 SDK operations
- awfl-api `(unrouted:mcp)`: 2214ms total, 1288ms DB-covered, 17 SDK operations
- awfl-api `(unrouted:mcp)`: 1285ms total, 1269ms DB-covered, 11 SDK operations
- awfl-api `(unrouted:workflows)`: 1269ms total, 1265ms DB-covered, 1 SDK operations
- awfl-api `(unrouted:workflows)`: 1332ms total, 1254ms DB-covered, 29 SDK operations
- awfl-api `(unrouted:workflows)`: 1723ms total, 1248ms DB-covered, 1 SDK operations
- awfl-api `(unrouted:workflows)`: 3600000ms total, 1243ms DB-covered, 15 SDK operations
- awfl-api `(unrouted:workflows)`: 1372ms total, 1183ms DB-covered, 6 SDK operations
- awfl-jobs `/context/topicContextYoj/run`: 1234ms total, 1181ms DB-covered, 32 SDK operations
- awfl-api `(unrouted:workflows)`: 2182ms total, 1158ms DB-covered, 1 SDK operations
- awfl-api `(unrouted:workflows)`: 1517ms total, 1156ms DB-covered, 1 SDK operations
- awfl-api `(unrouted:mcp)`: 11262ms total, 1145ms DB-covered, 16 SDK operations
- awfl-api `/workflows/exec/status/latest/:id`: 1379ms total, 1141ms DB-covered, 6 SDK operations

## Coverage caveats
- Endpoint attribution uses nearest ancestor `awfl.http` span. Missing exporter context or spans create unattributed data.
- SDK instrumented spans may include gRPC retries and Firestore transaction callback work. Per-request DB-covered time is not the same as network-only wait.
- These are observations from this specific production window; no counterfactual no-Firestore run was collected.
- Unattributed spans: `{"after-http-response:awfl-jobs:DocumentReference.Get": 587, "after-http-response:awfl-jobs:Query.Get": 115, "after-http-response:awfl-jobs:Transaction.Run": 815, "no-http-ancestor:awfl-native-worker:DocumentReference.Get": 337, "no-http-ancestor:awfl-native-worker:Query.Get": 115, "no-http-ancestor:awfl-native-worker:Transaction.Run": 170}`
