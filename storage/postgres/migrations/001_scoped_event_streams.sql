-- Migration 001: retire globally contended document change cursor.
-- Apply explicitly to an isolated PostgreSQL database after new adapter rollout.
-- Existing cursor/history tables remain untouched for archival/read migration.
BEGIN;
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
CREATE OR REPLACE FUNCTION awfl_document_change_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE changed_path text;
BEGIN
  changed_path := CASE WHEN TG_OP = 'DELETE' THEN OLD.path ELSE NEW.path END;
  PERFORM pg_notify('awfl_storage_change', changed_path);
  RETURN NULL;
END;
$$;
COMMIT;
