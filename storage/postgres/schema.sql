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
-- Single transactional cursor: the row lock guarantees committed event ordering,
-- unlike unconstrained BIGSERIAL values or notifications alone.
CREATE TABLE IF NOT EXISTS awfl_storage_cursor (name text PRIMARY KEY, position bigint NOT NULL);
INSERT INTO awfl_storage_cursor(name, position) VALUES ('all',0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS awfl_storage_changes (
  position bigint PRIMARY KEY,
  path text NOT NULL,
  action text NOT NULL,
  state jsonb,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE awfl_storage_changes ADD COLUMN IF NOT EXISTS state jsonb;
CREATE INDEX IF NOT EXISTS awfl_storage_changes_path ON awfl_storage_changes(path,position);
-- The trigger runs in the document transaction, so an insert/update/delete,
-- its ordered change record and LISTEN/NOTIFY are atomic without extra client
-- round trips. The cursor lock serializes commits as well as events.
CREATE OR REPLACE FUNCTION awfl_document_change_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE next_position bigint;
DECLARE changed_path text;
DECLARE action_name text;
DECLARE snapshot jsonb;
BEGIN
  changed_path := CASE WHEN TG_OP = 'DELETE' THEN OLD.path ELSE NEW.path END;
  action_name := CASE WHEN TG_OP = 'INSERT' THEN 'create'
    WHEN TG_OP = 'UPDATE' THEN 'update' ELSE 'delete' END;
  IF TG_OP = 'DELETE' THEN
    snapshot := NULL;
  ELSE
    snapshot := jsonb_build_object(
      'id', NEW.document_id, 'path', NEW.path, 'data', NEW.data,
      'revision', NEW.revision,
      'createdAt', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(NEW.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  END IF;
  UPDATE awfl_storage_cursor SET position=position+1
    WHERE name='all' RETURNING position INTO next_position;
  IF next_position IS NULL THEN
    RAISE EXCEPTION 'AWFL storage cursor missing';
  END IF;
  INSERT INTO awfl_storage_changes(position,path,action,state)
    VALUES (next_position,changed_path,action_name,snapshot);
  PERFORM pg_notify('awfl_storage_change',next_position::text);
  RETURN NULL; -- AFTER trigger ignores the return value
END;
$$;
DROP TRIGGER IF EXISTS awfl_documents_changed ON awfl_documents;
CREATE TRIGGER awfl_documents_changed AFTER INSERT OR UPDATE OR DELETE
  ON awfl_documents FOR EACH ROW EXECUTE FUNCTION awfl_document_change_trigger();
