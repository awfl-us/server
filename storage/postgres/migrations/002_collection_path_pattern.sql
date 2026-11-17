-- Production fix: PostgreSQL document subcollection lookups must be index-backed
-- even under en_US.UTF-8 or other non-C collations.
-- Run independently, outside a transaction, as the awfl_documents table owner.
-- This index was created online on awfl_prod on 2026-11-17 and verified with
-- EXPLAIN ANALYZE (4,056ms full-table scan -> 2.33ms index-only scan).
CREATE INDEX CONCURRENTLY IF NOT EXISTS awfl_documents_collection_path_pattern
  ON public.awfl_documents (collection_path text_pattern_ops, collection_id);
