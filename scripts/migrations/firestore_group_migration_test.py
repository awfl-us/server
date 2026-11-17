import hashlib
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

if __name__=='__main__':unittest.main()
