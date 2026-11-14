#!/usr/bin/env python3
"""Read-only AWFL Firestore trace profiler; produces aggregate JSON and Markdown.

Requires python3, requests, gcloud authentication with cloudtrace.traces.list.
Usage: python3 firestore_workflow_report.py --start 2026-11-14T04:25:00Z --end 2026-11-14T04:33:00Z --out /tmp/awfl-firestore-report

Important: SDK spans can be nested and concurrent. Count only top-level SDK
spans; overlapping durations are unioned per HTTP request. Neither raw span
counts nor covered durations are Firestore billing totals or causal speedups.
"""
import argparse
import collections
import datetime as dt
import json
import math
import os
import re
import subprocess
import sys
import time
import requests

SDK_METHODS = {'DocumentReference.Get', 'DocumentReference.Set', 'DocumentReference.Create',
               'DocumentReference.Update', 'DocumentReference.Delete',
               'DocumentReference.ListCollections', 'Query.Get', 'Query.Count',
               'Transaction.Run', 'Batch.Commit', 'WriteBatch.Commit', 'CollectionReference.Add'}
VOLATILE_RE = re.compile(r'(?<=/)(?:[a-f0-9]{32,}|[A-Za-z0-9_-]{20,}|[0-9]{8,})(?=/|$)')


def timestamp(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000.0


def percentile(a, p):
    if not a: return None
    a = sorted(a)
    x = (len(a)-1)*p/100.0
    lo = int(math.floor(x)); hi = int(math.ceil(x))
    return a[lo] + (a[hi]-a[lo])*(x-lo)


def agg(a):
    return {'n': len(a), 'p50': round(percentile(a,50),1) if a else None,
            'p95': round(percentile(a,95),1) if a else None,
            'max': round(max(a),1) if a else None,
            'sum': round(sum(a),1)}


def union_ms(intervals):
    if not intervals: return 0.0
    ss = sorted(intervals)
    start,end = ss[0]
    total = 0.0
    for a,b in ss[1:]:
        if a > end:
            total += end-start;start,end = a,b
        else: end=max(end,b)
    return total+end-start


def family_method(name):
    if name.startswith('Transaction.'): return 'Transaction.Run' if name=='Transaction.Run' else 'transaction-child'
    if name in ('Batch.Commit','WriteBatch.Commit'): return 'Batch.Commit'
    return name


def endpoint_name(name):
    name = name.split('?',1)[0]
    name = VOLATILE_RE.sub(':id',name)
    return name


def fetch(project,start,end,max_pages=30):
    token = subprocess.check_output(['gcloud','auth','print-access-token'],text=True).strip()
    session = requests.Session();session.headers.update({'Authorization':'Bearer '+token})
    url = 'https://cloudtrace.googleapis.com/v1/projects/%s/traces'%project
    params={'startTime':start, 'endTime':end, 'view':'COMPLETE','pageSize':1000}
    out=[]
    for i in range(max_pages):
        for attempt in range(4):
            resp=session.get(url,params=params,timeout=90)
            if resp.status_code in (429,500,502,503):
                time.sleep(1.5*(attempt+1));continue
            resp.raise_for_status();break
        else:raise RuntimeError('trace fetch exhausted retries')
        payload=resp.json();out.extend(payload.get('traces',[]))
        print('fetched page',i+1,'traces',len(out),file=sys.stderr,flush=True)
        nxt=payload.get('nextPageToken')
        if not nxt: return out, False
        params['pageToken']=nxt
    return out, True


def collect(traces,window_start,window_end):
    reqs=[]
    method_raw=collections.defaultdict(list)
    op_total=collections.Counter()
    missed=collections.Counter()
    bysvc=collections.defaultdict(collections.Counter)
    bysvcdur=collections.defaultdict(list)
    orphan=collections.defaultdict(list)
    nspans=0
    tstart=timestamp(window_start);tend=timestamp(window_end)
    for trace in traces:
        ss=trace.get('spans',[]);nspans+=len(ss)
        ids={x['spanId']:x for x in ss}
        children=collections.defaultdict(list)
        for x in ss:children[x.get('parentSpanId')].append(x)
        roots=[x for x in ss if x['name']=='awfl.http']
        maps={}
        for root in roots:
            rd=root.get('labels',{})
            child_routes=[x['name'] for x in children.get(root['spanId'],[]) if x['name'].startswith('/')]
            parent=ids.get(root.get('parentSpanId'))
            parent_route=parent['name'] if parent and parent['name'].startswith('/') else None
            route=endpoint_name(parent_route or (child_routes[0] if child_routes else '(unrouted:'+rd.get('awfl.request.family','unknown')+')'))
            st=timestamp(root['startTime']);en=timestamp(root['endTime'])
            if en<st or not tstart<=st<tend:continue
            rec={'route':route,'family':rd.get('awfl.request.family','unknown'),
                 'service':rd.get('service.name','unknown'),'start':st,'end':en,
                 'duration_ms':en-st,'sdk':[],'trace_id':trace.get('traceId','')}
            reqs.append(rec);maps[root['spanId']]=rec

        def ancestry(span):
            p=span.get('parentSpanId');seen=set()
            while p and p not in seen:
                seen.add(p);node=ids.get(p)
                if node is None:break
                yield node
                p=node.get('parentSpanId')

        for span in ss:
            name=span['name']
            if name not in SDK_METHODS:continue
            if not tstart<=timestamp(span['startTime'])<tend:continue
            op_total[name]+=1
            # A Set or Create contains Batch.Commit; Transaction.Run contains
            # Transaction.Get / Commit. Only count the outer logical call.
            parents=list(ancestry(span))
            if any(p['name'] in SDK_METHODS for p in parents):continue
            logical=family_method(name)
            service=span.get('labels',{}).get('service.name','unknown')
            bysvc[service][logical]+=1
            st=timestamp(span['startTime']);en=timestamp(span['endTime'])
            bysvcdur[(service,logical)].append(en-st)
            if en<st:continue
            method_raw[logical].append(en-st)
            request=next((maps[p['spanId']] for p in parents if p['spanId'] in maps),None)
            if not request:
                missed['no-http-ancestor:'+service+':'+logical]+=1
                orphan[(service,'no-http-ancestor',logical)].append(en-st)
                continue
            # Firestore operations may outlive an HTTP response, e.g. a
            # detached child still carrying a native root's trace context.
            if st>=request['end'] or en<=request['start']:
                why='after-http-response' if st>=request['end'] else 'before-http-request'
                missed[why+':'+service+':'+logical]+=1
                orphan[(service,why,logical)].append(en-st)
                continue
            request['sdk'].append((logical,max(st,request['start']),min(en,request['end']),en-st))

    return reqs,method_raw,op_total,missed,nspans,bysvc,bysvcdur,orphan


def summarize(reqs,method_raw,op_total,missed,ntraces,nspans,bysvc,bysvcdur,orphan):
    groups=collections.defaultdict(list)
    for r in reqs:
        ops=r['sdk']; dbunion=union_ms([(x[1],x[2]) for x in ops]);
        r['db_covered_ms']=dbunion
        r['db_covered_fraction']=dbunion / r['duration_ms'] if r['duration_ms'] else 0
        r['sdk_count']=len(ops)
        r['sdk_names']=collections.Counter(x[0] for x in ops)
        groups[(r['service'],r['route'])].append(r)
    routes=[]
    for (svc,route), arr in groups.items():
        counts=collections.Counter()
        for r in arr:counts.update(r['sdk_names'])
        routes.append({'service':svc,'route':route,'requests':len(arr),
                       'duration_ms':agg([x['duration_ms'] for x in arr]),
                       'db_covered_ms':agg([x['db_covered_ms'] for x in arr]),
                       'db_covered_sum_ms':round(sum(x['db_covered_ms'] for x in arr)),
                       'ops_per_request':agg([x['sdk_count'] for x in arr]),
                       'sdk_total':sum(counts.values()),'methods':dict(counts.most_common())})
    routes.sort(key=lambda r:r['db_covered_sum_ms'],reverse=True)
    services={}
    for svc in sorted(set(x['service'] for x in reqs)):
        subset=[x for x in reqs if x['service']==svc]
        ct=collections.Counter()
        for v in subset:ct.update(v['sdk_names'])
        services[svc]={'requests':len(subset),'sdk_total':sum(ct.values()),
                       'db_covered_sum_ms':round(sum(x['db_covered_ms'] for x in subset)),
                       'methods':dict(ct.most_common())}
    return {'trace_count':ntraces,'span_count':nspans,'http_requests':len(reqs),
            'scope':'AWFL awfl.http server-side requests and descendant logical Firestore SDK spans',
            'method_stats':{k:agg(v) for k,v in sorted(method_raw.items(),key=lambda t:-len(t[1]))},
            'sdk_raw_counts':dict(op_total.most_common()),
            'all_logical_sdk_by_service':{k:dict(v.most_common()) for k,v in bysvc.items()},
            'service_method_stats':{svc:{nm:agg(bysvcdur[(svc,nm)]) for nm in counts} for svc,counts in bysvc.items()},
            'operations_outside_live_request':[{'service':s,'reason':r,'method':m,**agg(v)} for (s,r,m),v in sorted(orphan.items(),key=lambda item:-len(item[1]))],
            'unattributed':dict(missed.most_common()),
            'services':services,'routes':routes,
            'high_db_requests':[{'route':v['route'],'service':v['service'],
              'duration_ms':round(v['duration_ms']),'db_covered_ms':round(v['db_covered_ms']),
              'sdk_count':v['sdk_count'],'methods':dict(v['sdk_names'].most_common())}
               for v in sorted(reqs,key=lambda x:x['db_covered_ms'],reverse=True)[:20]]}


def markdown(d,start,end,partial):
    lines=[f'# AWFL Firestore workflow latency report',
           f'Window UTC: `{start}` — `{end}` (Cloud Trace; {"TRUNCATED" if partial else "complete pagination"})',
           '',f"Traces: **{d['trace_count']}**, source spans: **{d['span_count']}** (some source trace spans fall outside window), HTTP requests **starting in window**: **{d['http_requests']}**.",
           '', '## Interpretation',
           '- Request and SDK start timestamps are filtered to the stated UTC window. Source traces can include later asynchronous activity that is excluded from operation counts.',
           '- **DB-covered ms** = union of top-level Firestore SDK operation intervals within an HTTP request, **not a proven reduction in latency**. Nested SDK spans are counted once; concurrent operations overlap rather than add.',
           '- **Aggregate DB-covered sum** adds request-level coverage and may double-count concurrent requests; use for workload prioritization, not overall wall-clock saved.',
           '- Method counts are logical SDK invocations, not billable Firestore reads/writes. No code-location/document-path tags are collected. An endpoint can contain unrelated work.',
           '- Unattributed operations are tracked separately. Cross-request trace linkage may not always be complete; labels indicate sampled services and endpoints only.',
           '', '## Services',
           '| Service | HTTP requests | Top-level SDK operations | Sum DB-covered request time |',
           '|---|---:|---:|---:|']
    for svc,dct in d['services'].items():lines.append(f"| {svc} | {dct['requests']} | {dct['sdk_total']} | {dct['db_covered_sum_ms']/1000:.1f}s |")
    lines+=['', '## All top-level logical SDK calls by service (including background/unattributed)']
    for svc,methods in d['all_logical_sdk_by_service'].items():
        lines.append(f"- **{svc}:** " + ', '.join(f'{k}={v}' for k,v in methods.items()))
    lines+=['', '## SDK calls not contained within a live HTTP request',
            '| Service | Why | Method | Count | p50/p95 SDK |',
            '|---|---|---|---:|---:|']
    for r in d['operations_outside_live_request']:
        lines.append(f"| {r['service']} | {r['reason']} | `{r['method']}` | {r['n']} | {r['p50']:.0f}/{r['p95']:.0f}ms |")
    lines += ['', '## Routes ranked by DB-covered request time (Jobs first)',
              '| Service | Route | N requests | p50/p95 request | p50/p95 DB-covered | Calls/request p50/p95 | Total SDK ops | Sum DB-covered |',
              '|---|---|---:|---:|---:|---:|---:|---:|']
    ranked=[r for r in d['routes'] if r['service']=='awfl-jobs'] + [r for r in d['routes'] if r['service']!='awfl-jobs']
    for r in ranked[:80]:
        p=lambda k:f"{r[k]['p50']:.0f}/{r[k]['p95']:.0f}ms" if r[k]['p50'] is not None else 'n/a'
        calls=r['ops_per_request'];calls_str=f"{calls['p50']:.0f}/{calls['p95']:.0f}"
        lines.append(f"| {r['service']} | `{r['route']}` | {r['requests']} | {p('duration_ms')} | {p('db_covered_ms')} | {calls_str} | {r['sdk_total']} | {r['db_covered_sum_ms']/1000:.1f}s |")
    lines+=['','## Jobs SDK operation latency (including background)',
            '| Method | Count | p50 | p95 | max |','|---|---:|---:|---:|---:|']
    for k,v in sorted(d['service_method_stats'].get('awfl-jobs',{}).items(),key=lambda x:-x[1]['n']):
        lines.append(f"| `{k}` | {v['n']} | {v['p50']:.1f}ms | {v['p95']:.1f}ms | {v['max']:.1f}ms |")
    lines+=['','## Top-level SDK operations (all services)',
            '| Method | Count | p50 | p95 | max |','|---|---:|---:|---:|---:|']
    for k,v in sorted(d['method_stats'].items(),key=lambda x:-x[1]['n']):
        lines.append(f"| `{k}` | {v['n']} | {v['p50']:.1f}ms | {v['p95']:.1f}ms | {v['max']:.1f}ms |")
    lines+=['', '## Top routes: method mix']
    for r in d['routes'][:35]:
        methods=', '.join(f'{k}={v}' for k,v in list(r['methods'].items())[:12])
        lines.append(f"- **{r['service']} `{r['route']}`** ({r['requests']} requests): {methods or 'no SDK spans'}")
    lines+=['','## Largest individual requests']
    for r in d['high_db_requests'][:20]:
        lines.append(f"- {r['service']} `{r['route']}`: {r['duration_ms']}ms total, {r['db_covered_ms']}ms DB-covered, {r['sdk_count']} SDK operations")
    lines+=['','## Coverage caveats',
            '- Endpoint attribution uses nearest ancestor `awfl.http` span. Missing exporter context or spans create unattributed data.',
            '- SDK instrumented spans may include gRPC retries and Firestore transaction callback work. Per-request DB-covered time is not the same as network-only wait.',
            '- These are observations from this specific production window; no counterfactual no-Firestore run was collected.',
            f"- Unattributed spans: `{json.dumps(d['unattributed'],sort_keys=True)}`",'']
    return '\n'.join(lines)


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--project',default='awfl-us');ap.add_argument('--start',required=True);ap.add_argument('--end',required=True);ap.add_argument('--out',default='/tmp/awfl-firestore-report');ap.add_argument('--max-pages',type=int,default=30)
    a=ap.parse_args();
    if timestamp(a.start)>=timestamp(a.end):ap.error('end must follow start')
    traces,partial=fetch(a.project,a.start,a.end,a.max_pages)
    reqs,methods,raw,missed,spans,bysvc,bysvcdur,orphan=collect(traces,a.start,a.end)
    d=summarize(reqs,methods,raw,missed,len(traces),spans,bysvc,bysvcdur,orphan)
    d.update({'window_start':a.start,'window_end':a.end,'pagination_truncated':partial})
    os.makedirs(os.path.dirname(os.path.abspath(a.out)),exist_ok=True)
    with open(a.out+'.json','w') as f:json.dump(d,f,indent=2)
    with open(a.out+'.md','w') as f:f.write(markdown(d,a.start,a.end,partial))
    print(json.dumps({'summary':{'traces':len(traces),'spans':spans,'requests':len(reqs),'routes':len(d['routes'])},'files':[a.out+'.json',a.out+'.md']}))

if __name__=='__main__':main()
