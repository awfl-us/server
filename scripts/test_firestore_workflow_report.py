"""Run with: python3 -m unittest discover -s scripts -p 'test_firestore_workflow_report.py'."""
import unittest
from datetime import datetime, timedelta, timezone
from firestore_workflow_report import collect, summarize, union_ms, endpoint_name

ORIGIN = datetime(2026, 11, 14, 4, 25, 0, tzinfo=timezone.utc)

def at(ms):
    return (ORIGIN + timedelta(milliseconds=ms)).isoformat().replace('+00:00','Z')

def span(sid,name,a,b,parent=None,service=None,family=None):
    result={'spanId':sid,'name':name,'startTime':at(a),'endTime':at(b)}
    if parent:result['parentSpanId']=parent
    if service or family:result['labels']={k:v for k,v in [('service.name',service),('awfl.request.family',family)] if v}
    return result

class TestReport(unittest.TestCase):
    def test_union_handles_concurrent_spans(self):
        self.assertEqual(union_ms([(100,300),(180,350),(400,500)]),350)

    def test_normalize_dynamic_route_segments(self):
        self.assertEqual(endpoint_name('/tasks/by-session/9727bf02-d478-4806-bb65-ca3679fcae69'),'/tasks/by-session/:id')

    def test_parent_route_nested_sdk_and_background(self):
        traces=[{'traceId':'test','spans':[
            span('route','/context/topicContextYoj/run',0,1100),
            span('http','awfl.http',0,1000,'route',service='awfl-jobs',family='context'),
            span('read','DocumentReference.Get',100,300,'http',service='awfl-jobs'),
            span('q','Query.Get',180,350,'http',service='awfl-jobs'),
            span('write','DocumentReference.Create',400,550,'http',service='awfl-jobs'),
            span('batch','Batch.Commit',440,510,'write',service='awfl-jobs'),
            span('later','Transaction.Run',1200,1300,'http',service='awfl-jobs'),
            span('worker','DocumentReference.Get',1300,1450,service='awfl-native-worker'),
            span('out','Transaction.Run',2500,2800,'http',service='awfl-jobs'),
        ]}]
        reqs,methods,raw,missed,nspans,bysvc,durs,orphan=collect(traces,at(0),at(2000))
        self.assertEqual(len(reqs),1)
        d=summarize(reqs,methods,raw,missed,1,nspans,bysvc,durs,orphan)
        r=d['routes'][0]
        self.assertEqual(r['route'],'/context/topicContextYoj/run')
        self.assertEqual(r['sdk_total'],3)
        self.assertEqual(r['db_covered_sum_ms'],400)
        self.assertEqual(d['all_logical_sdk_by_service']['awfl-jobs']['Transaction.Run'],1)
        self.assertNotIn('Batch.Commit',d['all_logical_sdk_by_service']['awfl-jobs'])
        self.assertEqual(missed['after-http-response:awfl-jobs:Transaction.Run'],1)
        self.assertEqual(missed['no-http-ancestor:awfl-native-worker:DocumentReference.Get'],1)

if __name__=='__main__':unittest.main()
