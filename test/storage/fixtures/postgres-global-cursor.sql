-- Benchmark fixture ONLY: restore pre-migration global cursor serialization.
-- Use in isolated CI database, never on production.
CREATE TABLE IF NOT EXISTS awfl_storage_cursor(name text PRIMARY KEY,position bigint NOT NULL);
INSERT INTO awfl_storage_cursor(name,position) VALUES('all',0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS awfl_storage_changes(
  position bigint PRIMARY KEY,path text NOT NULL,action text NOT NULL,
  state jsonb,changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION awfl_document_change_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE next_position bigint;
DECLARE changed_path text;
DECLARE action_name text;
DECLARE snapshot jsonb;
BEGIN
  changed_path := CASE WHEN TG_OP='DELETE' THEN OLD.path ELSE NEW.path END;
  action_name := CASE WHEN TG_OP='INSERT' THEN 'create'
    WHEN TG_OP='UPDATE' THEN 'update' ELSE 'delete' END;
  IF TG_OP='DELETE' THEN snapshot := NULL;
  ELSE
    snapshot := jsonb_build_object('id',NEW.document_id,'path',NEW.path,
      'data',NEW.data,'revision',NEW.revision,
      'createdAt',to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt',to_char(NEW.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  END IF;
  UPDATE awfl_storage_cursor SET position=position+1 WHERE name='all'
    RETURNING position INTO next_position;
  INSERT INTO awfl_storage_changes(position,path,action,state)
    VALUES(next_position,changed_path,action_name,snapshot);
  PERFORM pg_notify('awfl_storage_change',next_position::text);
  RETURN NULL;
END;
$$;
