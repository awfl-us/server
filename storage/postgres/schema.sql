-- AWFL document store M0. Apply via an explicit migration; never run on the
-- production database automatically during process startup.
CREATE TABLE IF NOT EXISTS awfl_documents (
  path text PRIMARY KEY,
  collection_path text NOT NULL,
  collection_id text NOT NULL,
  document_id text NOT NULL,
  data jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS awfl_documents_collection ON awfl_documents(collection_path, document_id);
CREATE INDEX IF NOT EXISTS awfl_documents_group ON awfl_documents(collection_id, path);
-- Required for prefix lookups (listCollections) with non-C database collations.
-- The ordinary btree index cannot optimize parameterized LIKE under en_US.
CREATE INDEX IF NOT EXISTS awfl_documents_collection_path_pattern
  ON awfl_documents (collection_path text_pattern_ops, collection_id);
-- Durable ordering applies only to actual event streams, never document writes.
-- Concurrent streams do not contend for a global cursor row.
CREATE TABLE IF NOT EXISTS awfl_storage_stream_cursors (
  scope text NOT NULL CHECK (scope IN ('session','project')),
  stream_id text NOT NULL,
  position bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, stream_id)
);
CREATE TABLE IF NOT EXISTS awfl_storage_stream_events (
  scope text NOT NULL CHECK (scope IN ('session','project')),
  stream_id text NOT NULL,
  position bigint NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, stream_id, position),
  UNIQUE (scope, stream_id, event_id)
);
-- Legacy global cursor/change tables are left intact by upgrades, but are no
-- longer touched. Migrate old consumers before retiring those tables.
-- NOTIFY is a commit-delivered wakeup hint, not a durable replay cursor.
-- Subscribers re-read state; no shared row lock is acquired by ordinary writes.
CREATE OR REPLACE FUNCTION awfl_document_change_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE changed_path text;
BEGIN
  changed_path := CASE WHEN TG_OP = 'DELETE' THEN OLD.path ELSE NEW.path END;
  PERFORM pg_notify('awfl_storage_change', changed_path);
  RETURN NULL; -- AFTER trigger ignores the return value
END;
$$;
DROP TRIGGER IF EXISTS awfl_documents_changed ON awfl_documents;
CREATE TRIGGER awfl_documents_changed AFTER INSERT OR UPDATE OR DELETE
  ON awfl_documents FOR EACH ROW EXECUTE FUNCTION awfl_document_change_trigger();
