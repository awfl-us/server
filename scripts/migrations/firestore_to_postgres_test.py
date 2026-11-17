import collections
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location(
    'firestore_to_postgres',Path(__file__).with_name('firestore_to_postgres.py'))
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ConverterTest(unittest.TestCase):
    def test_nested_json_and_timestamp(self):
        c=collections.Counter()
        value={'mapValue':{'fields':{
            'name':{'stringValue':'hello'},
            'when':{'timestampValue':'2026-11-16T01:00:00+00:00'},
            'attrs':{'arrayValue':{'values':[{'integerValue':'5'},
                {'booleanValue':True},{'nullValue':None}]}}
        }}}
        self.assertEqual(m.decode(value,c),{
            'name':'hello','when':'2026-11-16T01:00:00Z',
            'attrs':[5,True,None]})
        self.assertEqual(c['mapValue'],1)
        self.assertEqual(c['timestampValue'],1)
    def test_reject_precision_loss_and_unsupported_types(self):
        for item in [{'integerValue':str(2**53)}, {'bytesValue':'YWJj'},
            {'doubleValue':'NaN'}, {'referenceValue':'bad'}]:
            with self.assertRaises(ValueError):
                m.decode(item,collections.Counter())
    def test_deterministic_digest(self):
        self.assertEqual(m.digest('users/a/projects/b',{'x':1,'y':2}),
            m.digest('users/a/projects/b',{'y':2,'x':1}))
        self.assertNotEqual(m.digest('users/a/projects/b',{'x':1}),
            m.digest('users/a/projects/c',{'x':1}))
    def test_missing_parent_user_retains_nested_project(self):
        class FakeReader:
            def collections(self, parent=None):
                return {'None':['users','mcpWorkspaces'],
                    'users/virtual':['projects','mcpCommandKeys'],
                    'users/virtual/projects/project':['convo.sessions']}.get(
                        str(parent),[])
            def documents(self, collection):
                docs={'users':[('users/virtual',None)],
                    'users/virtual/projects':[('users/virtual/projects/project',
                        {'name':{'stringValue':'project'}})],
                    'users/virtual/projects/project/convo.sessions':[
                        ('users/virtual/projects/project/convo.sessions/s',
                            {'title':{'stringValue':'session'}})]
                }
                for path,fields in docs.get(collection,[]):
                    item={'name':'https://firestore.googleapis.com/v1/x/documents/'+path}
                    if fields is not None:item['fields']=fields
                    yield item
        got=list(m.walk(FakeReader(),workers=2))
        self.assertEqual(len(got),2)
        self.assertEqual([p for p,_ in got],[
            'users/virtual/projects/project',
            'users/virtual/projects/project/convo.sessions/s'])
if __name__=='__main__':
    unittest.main()
