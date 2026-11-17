# PostgreSQL cutover incident checkpoint — 2026-11-17

AWFL PostgreSQL database `awfl_prod` was populated by the finite migration, and a production-identity Cloud Run canary passed. A later GKE update selected PostgreSQL while Cloud Run API/Jobs revisions were being prepared, but the AWFL management MCP endpoint subsequently returned HTTP 503, preventing independent traffic validation.

This checkpoint intentionally triggers the existing Firestore-default production deployment pipeline from `main`. It is a recovery action, **not confirmation of a completed PostgreSQL cutover**. Keep the PostgreSQL database and its imported records intact, preserve Firebase Auth and the legacy native execution journal in Firestore, and independently verify API/Jobs/GKE backend settings before attempting another switchover.

The PostgreSQL configuration proposal is in PR #144 and must not be merged until the rollout can be verified end-to-end. The old Cloud Run revisions previously serving Firestore were `api-00198-7gf` and `jobs-00193-vmv`. An unrelated concurrent change may have advanced these revisions; inspect actual Cloud Run traffic before rollback or further deployment.
