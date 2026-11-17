import hashlib
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import sys
import unittest

root=Path(__file__).parent
sys.path.insert(0,str(root))
spec=importlib.util.spec_from_file_location('group_migration',
    root/'firestore_group_migration.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class FakeReader:
    def __init__(self,paths):
        self.paths=paths
    def call(self,route,body=None):
        if route==':runAggregationQuery':
            return [{'result':{'aggregateFields':{'total':{
                'integerValue':str(len(self.paths))}}}}]
        self_group=body['structuredQuery']['from'][0]['collectionId']
        matched=[p for p in self.paths
            if p.split('/')[-2]==self_group]
        cursor=body['structuredQuery'].get('startAt',{}).get('values',[])
        if cursor:
            start_after=cursor[0]['referenceValue'].split('/documents/',1)[1]
            matched=[p for p in matched if p>start_after]
        limited=matched[:body['structuredQuery']['limit']]
        return [{'document':{
            'name':'projects/test/databases/(default)/documents/'+p,
            'fields':{'count':{'integerValue':'2'}},
            'createTime':'2026-11-01T00:00:00Z',
            'updateTime':'2026-11-01T00:00:00Z',
        }} for p in limited]

class QueryTests(unittest.TestCase):
    def test_collection_group_pagination_across_parents(self):
        paths=[
            'users/u/projects/p/convo.sessions/s1/messages/a',
            'users/u/projects/p/convo.sessions/s1/messages/b',
            'users/u/projects/q/convo.sessions/s2/messages/c',
            'users/u/projects/q/convo.sessions/s2/messages/d']
        reader=FakeReader(paths)
        listed=list(m.collection_group(reader,'messages',page_size=2))
        self.assertEqual([path for path,_ in listed],paths)
        self.assertEqual(m.group_count(reader,'messages'),4)
    def test_excludes_control_plane_paths_with_same_collection_id(self):
        paths=[
            'mcpWorkspaces/secret/messages/a',
            'users/u/projects/p/convo.sessions/s1/messages/b']
        seen=list(m.collection_group(FakeReader(paths),'messages',page_size=1))
        self.assertEqual([p for p,_ in seen],[paths[1]])
    def test_revision_and_timestamps_preserved(self):
        doc={'fields':{
            '__awflStorageMeta':{'mapValue':{'fields':{
                'revision':{'integerValue':'4'}}}}},
            'createTime':'2026-11-10T11:00:00Z',
            'updateTime':'2026-11-10T13:00:00Z'}
        path='users/u/projects/p'
        row=m.document_row(path,doc,{'name':'test'})
        self.assertEqual(row[5],4)
        self.assertEqual(row[-2:],
            ('2026-11-10T11:00:00Z','2026-11-10T13:00:00Z'))
    def test_missing_control_plane_counts_are_not_implicitly_migrated(self):
        self.assertIn('mcpWorkspaces',m.EXCLUDE_ROOT)
        self.assertIn('nativeWorkflowExecutions',m.EXCLUDE_ROOT)


class SQLFenceTests(unittest.TestCase):
    def test_cutover_timestamp_is_explicitly_timezone_aware(self):
        t=m.parse_cutover_timestamp('2026-11-17T04:00:00Z')
        self.assertEqual(t.tzinfo,timezone.utc)
        with self.assertRaises(ValueError):
            m.parse_cutover_timestamp('2026-11-17T04:00:00')
        with self.assertRaises(ValueError):
            m.parse_cutover_timestamp('bad')

    def test_sync_upsert_is_fenced_at_postgres_statement_execution(self):
        queries=[]
        class Cursor:
            def __enter__(self):return self
            def __exit__(self,*args):return False
            def execute(self,sql,params):queries.append((sql,params))
        class DB:
            def cursor(self):return Cursor()
            def commit(self):pass
        cutoff=m.parse_cutover_timestamp('2026-11-17T04:00:00Z')
        row=('users/u/projects/p','users/u/projects','projects','p',
            '{"name":"test"}',1,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')
        m.write_rows(DB(),[row],cutover_at=cutoff)
        self.assertIn('awfl_documents.updated_at < %s::timestamptz',queries[0][0])
        self.assertEqual(queries[0][1][-1],cutoff)

    def test_verify_exempts_new_pg_writes_but_detects_old_mismatch(self):
        path='users/u/projects/p/convo.sessions/s/messages/a'
        src=FakeReader([path])
        class Cursor:
            def __init__(self,rows):self.rows=rows
            def __enter__(self):return self
            def __exit__(self,*args):return False
            def execute(self,*args):pass
            def __iter__(self):return iter(self.rows)
        class DB:
            def __init__(self,time):self.time=time
            def cursor(self,**kwargs):
                return Cursor([(path,{'count':999},self.time)])
        cutoff=m.parse_cutover_timestamp('2026-11-17T04:00:00Z')
        newer=m.parse_cutover_timestamp('2026-11-17T04:00:01Z')
        older=m.parse_cutover_timestamp('2026-11-17T03:59:59Z')
        a=m.migrate_group(src,'messages','verify',DB(newer),
            page_size=1,cutover_at=cutoff)
        self.assertEqual((a['mismatched'],a['fenced']),(0,1))
        b=m.migrate_group(src,'messages','verify',DB(older),
            page_size=1,cutover_at=cutoff)
        self.assertEqual((b['mismatched'],b['fenced']),(1,0))
        self.assertEqual(b['unresolved_data_mismatch'],1)
        self.assertEqual(b['source_updated_since_copy'],0)

    def test_verify_classifies_live_source_drift_separately_from_missing_sql(self):
        path='users/u/projects/p/convo.sessions/s/messages/a'
        reader=FakeReader([path])
        class Cursor:
            def __enter__(self):return self
            def __exit__(self,*args):return False
            def execute(self,*args):pass
            def __iter__(self):
                return iter([(path,{'count':999},
                    m.parse_cutover_timestamp('2026-10-31T23:00:00Z'))])
        class DB:
            def cursor(self,**kwargs):return Cursor()
        record=m.migrate_group(reader,'messages','verify',DB(),page_size=1)
        self.assertEqual(record['mismatched'],1)
        self.assertEqual(record['source_updated_since_copy'],1)
        self.assertEqual(record['unresolved_data_mismatch'],0)
        self.assertEqual(record['absent'],0)
if __name__=='__main__':unittest.main()
