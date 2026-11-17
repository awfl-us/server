#!/usr/bin/env python3
"""AWFL finite Firestore -> PostgreSQL collection-group import.

All reads use Firestore collection-group queries with deterministic __name__
cursor pagination. Existing Firebase Auth, OAuth, MCP workspace control plane,
and legacy native durable journals remain in Firestore.

Run discover -> inventory -> copy -> verify. Copy accepts a repeatable
idempotent final pass while old writes are stopped. Never prints doc bodies.
"""
import argparse
import collections
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import time

from firestore_to_postgres import (
    Reader, connect, decode, digest, stable, EXCLUDE_ROOT, EXCLUDE_CHILD,
)

BASE = Path(__file__).resolve().parent
# Known terminal collections do not require a per-document listCollectionIds
# read. New collection names are learned from real project/session containers.
LEAF = {
    'messages','items','relayEvents','relayEventsSessions','callbacks','tasks',
    'cursors','agentSessions','agents','creds','workflowDefinitions',
    'workflowTypes','workflowExecLinks','workflowExecStatus',
    'workflowExecsBySession','integrations','nativeWorkflowExecutions',
    'log.sessions.summaries','log.sessions.topicInfos',
    'log.terms.summaries','log.terms.topicInfos',
    'log.weekly.summaries','log.weekly.topicInfos',
}
CONTAINERS = {'users', 'projects', 'convo.sessions', 'workspaces',
    'relayEventsSessions','prompts','defs'}


def batches(items, width):
    for i in range(0, len(items), width):
        yield items[i:i+width]


def collection_group(reader, name, *, page_size=400, start_after=None):
    """Returns docs in path order; including every descendant collection."""
    while True:
        query={'from':[{'collectionId':name,'allDescendants':True}],
            'orderBy':[{'field':{'fieldPath':'__name__'},
                'direction':'ASCENDING'}], 'limit':page_size}
        if start_after:
            query['startAt']={'values':[{'referenceValue':start_after}],
                'before':False}
        result=reader.call(':runQuery',{'structuredQuery':query})
        documents=[item['document'] for item in result if 'document' in item]
        if not documents:return
        for doc in documents:
            path=doc['name'].split('/documents/',1)[1]
            # This should never include the excluded roots, but guard even
            # against a reused collection ID under an excluded control plane.
            if path.split('/')[0] not in EXCLUDE_ROOT and not any(
                col in EXCLUDE_CHILD or col.startswith('locks.')
                for col in path.split('/')[::2]):
                yield path,doc
        last=documents[-1]['name']
        if start_after == last:
            raise RuntimeError('nonadvancing Firestore collection-group cursor')
        start_after=last
        if len(documents)<page_size:return


def group_count(reader, name):
    query={'structuredQuery':{'from':[{'collectionId':name,
        'allDescendants':True}]}}
    result=reader.call(':runAggregationQuery',{
        'structuredAggregationQuery':{**query,
            'aggregations':[{'count':{},'alias':'total'}]}})
    return int(result[0].get('result',{}).get('aggregateFields',{})
        .get('total',{}).get('integerValue',0))


def discover(reader, *, threads=16):
    """Learn all user/project collection names, including virtual parents."""
    names=set(c for c in reader.collections() if c not in EXCLUDE_ROOT)
    users=[d['name'].split('/documents/',1)[1]
        for d in reader.documents('users')]
    def descendants(parent):
        try:return parent,reader.collections(parent)
        except Exception as error:
            raise RuntimeError('failed collection discovery') from error
    def map_names(parents):
        out={}
        with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as pool:
            for path,children in pool.map(descendants,parents):
                kept=[c for c in children if c not in EXCLUDE_CHILD
                    and not c.startswith('locks.')]
                out[path]=kept
                names.update(kept)
        return out
    # First inspect virtual parent users and their project documents.
    user_children=map_names(users)
    project_parents=[u for u in users if 'projects' in user_children[u]]
    projects=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as pool:
        for docs in pool.map(lambda p:list(reader.documents(p+'/projects')),project_parents):
            projects += [d['name'].split('/documents/',1)[1] for d in docs]
    project_children=map_names(projects)
    # Nested session docs are containers, not leaf documents. Enumerate their
    # subcollection names, including under missing/virtual session parents.
    nested_paths=[]
    def nested_docs(item):
        path,children=item
        subpaths=[]
        for name in children:
            if name in ('convo.sessions','relayEventsSessions','workspaces',
                'projects','prompts','defs'):
                subpaths += [d['name'].split('/documents/',1)[1]
                    for d in reader.documents(path+'/'+name)]
        return subpaths
    with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as pool:
        for rows in pool.map(nested_docs,project_children.items()):
            nested_paths.extend(rows)
    # Avoid excess per-leaf listCollectionIds calls.
    map_names(nested_paths)
    # The two primary document-array namespaces are stable, with named group
    # types even when their virtual parent documents have no fields.
    names.update(('messages','items','projects','convo.sessions'))
    return sorted(name for name in names if name not in EXCLUDE_ROOT
        and name not in EXCLUDE_CHILD and not name.startswith('locks.'))


def write_rows(db, rows, *, cutover_at=None):
    if not rows:return
    placeholders=','.join('(%s,%s,%s,%s,%s::jsonb,%s,%s,%s)'
        for _ in rows)
    params=[v for row in rows for v in row]
    statement=('INSERT INTO awfl_documents '
        '(path,collection_path,collection_id,document_id,data,revision,created_at,updated_at)'
        ' VALUES '+placeholders+' ON CONFLICT(path) DO UPDATE SET '
        'data=EXCLUDED.data,revision=EXCLUDED.revision,'
        'created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at '
        'WHERE ')
    if cutover_at:
        # Fencing at SQL execution time protects concurrently committed
        # post-cutover PG mutations from a delayed Firestore reconciliation.
        statement+='awfl_documents.updated_at < %s::timestamptz AND '
        params.append(cutover_at)
    statement+=('(awfl_documents.data IS DISTINCT FROM EXCLUDED.data '
        'OR awfl_documents.revision IS DISTINCT FROM EXCLUDED.revision)')
    with db.cursor() as cur:cur.execute(statement,params)
    db.commit()


def parse_cutover_timestamp(value):
    if value is None:return None
    if not isinstance(value,str):raise ValueError('cutover timestamp required')
    try:dt=datetime.fromisoformat(value.replace('Z','+00:00'))
    except ValueError as ex:raise ValueError('invalid cutover timestamp') from ex
    if dt.tzinfo is None:raise ValueError('cutover timestamp must include timezone')
    return dt.astimezone(timezone.utc)


def document_row(path,doc,value):
    parts=path.split('/')
    metadata=doc.get('fields',{}).get('__awflStorageMeta',{})
    revision=int(metadata.get('mapValue',{}).get('fields',{})
        .get('revision',{}).get('integerValue',1))
    return (path,'/'.join(parts[:-1]),parts[-2],parts[-1],stable(value),
        revision,doc.get('createTime','1970-01-01T00:00:00Z'),
        doc.get('updateTime','1970-01-01T00:00:00Z'))


def migrate_group(reader, group, mode, db=None, page_size=400,
    cutover_at=None):
    kinds=collections.Counter()
    num=0
    checksum=hashlib.sha256()
    queued=[]
    errors=0
    absent=0
    changed_since_copy=0
    equal_timestamp_mismatch=0
    changed=0
    unchanged=0
    fenced=0
    targets={}
    if mode in ('verify','sync'):
        # One bounded SQL index scan per collection, not one round trip per
        # document. Keep hashes and server-owned update timestamps only.
        name='migration_'+hashlib.sha1(group.encode()).hexdigest()[:10]
        with db.cursor(name=name) as cur:
            cur.itersize=500
            cur.execute('SELECT path,data,updated_at FROM awfl_documents WHERE collection_id=%s',
                (group,))
            for path,payload,updated_at in cur:
                targets[path]=(digest(path,payload),updated_at)
    for path,doc in collection_group(reader,group,page_size=page_size):
        value={field:decode(raw,kinds)
            for field,raw in doc.get('fields',{}).items()
            if field!='__awflStorageMeta'}
        source_hash=digest(path,value)
        checksum.update(bytes.fromhex(source_hash))
        num+=1
        if mode=='copy':
            queued.append(document_row(path,doc,value))
            if len(queued)>=100:
                write_rows(db,queued)
                queued.clear()
        elif mode in ('sync','verify'):
            target=targets.pop(path,None)
            # A record touched by PostgreSQL after the provider switch is now
            # PG-owned; source Firestore history must never overwrite it.
            if cutover_at and target and target[1]>=cutover_at:
                fenced+=1
            elif mode=='verify':
                if target is None:
                    errors+=1
                    absent+=1
                elif target[0]!=source_hash:
                    errors+=1
                    source_updated_at=parse_cutover_timestamp(doc.get('updateTime'))
                    if source_updated_at and source_updated_at>target[1]:
                        changed_since_copy+=1
                    else:
                        equal_timestamp_mismatch+=1
            elif target and target[0]==source_hash:
                unchanged+=1
            else:
                queued.append(document_row(path,doc,value))
                changed+=1
                if len(queued)>=100:
                    write_rows(db,queued,cutover_at=cutover_at)
                    queued.clear()
        if num%4000==0:
            print('group',group,'docs',num,flush=True)
    if queued:write_rows(db,queued,cutover_at=cutover_at)
    # PG-only rows created after the cutoff are expected; older extra rows
    # are surfaced but never silently deleted by migration tools.
    extras=sum(not cutover_at or stamp<cutover_at
        for _,stamp in targets.values())
    if mode=='verify':errors+=extras
    record={'group':group,'count':num,'digest':checksum.hexdigest(),
        'value_types':dict(sorted(kinds.items()))}
    if mode=='verify':record.update(mismatched=errors,fenced=fenced,extras=extras,
        absent=absent,source_updated_since_copy=changed_since_copy,
        unresolved_data_mismatch=equal_timestamp_mismatch)
    if mode=='sync':record.update(changed=changed,unchanged=unchanged,
        fenced=fenced,extras=extras)
    return record


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['discover','inventory','copy','sync','verify'])
    parser.add_argument('--project',default='awfl-us')
    parser.add_argument('--pg-dsn',default=os.getenv('AWFL_MIGRATION_PG_DSN'))
    parser.add_argument('--manifest',default='/tmp/awfl-pg-collection-groups.json')
    parser.add_argument('--threads',type=int,default=16)
    parser.add_argument('--page-size',type=int,default=400)
    parser.add_argument('--only-group',action='append')
    parser.add_argument('--ack-copy',action='store_true')
    parser.add_argument('--cutover-at',help='UTC/offset timestamp fence for final sync/verify')
    args=parser.parse_args()
    if args.mode in ('copy','sync') and not args.ack_copy:
        parser.error('copy requires --ack-copy; do not start a live traffic cutover')
    token=os.getenv('GOOGLE_OAUTH_ACCESS_TOKEN')
    if not token and os.getenv('CLOUDSDK_AUTH_ACCESS_TOKEN_FILE'):
        token=Path(os.environ['CLOUDSDK_AUTH_ACCESS_TOKEN_FILE']).read_text().strip()
    if not token:parser.error('Firestore bearer token unavailable')
    reader=Reader(args.project,token)
    if args.mode=='discover':
        names=discover(reader,threads=args.threads)
        Path(args.manifest).write_text(json.dumps(names,indent=2)+'\n')
        print('discovered_groups',len(names))
        for name in names:
            print(name,group_count(reader,name))
        return
    groups=args.only_group or json.loads(Path(args.manifest).read_text())
    if not groups:parser.error('no groups discovered')
    cutover_at=parse_cutover_timestamp(args.cutover_at)
    if cutover_at and args.mode not in ('sync','verify'):
        parser.error('--cutover-at only applies to sync or verify')
    db=connect(args.pg_dsn) if args.mode in ('copy','sync','verify') else None
    if db:
        with db.cursor() as cur:
            cur.execute("SELECT to_regclass('public.awfl_documents')")
            if not cur.fetchone()[0]:parser.error('Postgres schema is missing')
    mismatches=0
    try:
        for group in groups:
            record=migrate_group(reader,group,args.mode,db=db,
                page_size=args.page_size,cutover_at=cutover_at)
            print(stable(record),flush=True)
            mismatches+=record.get('mismatched',0)
    finally:
        if db:db.close()
    if mismatches:raise RuntimeError('Source/target data mismatch count '+str(mismatches))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print('migration failed safely:',str(error)[:300],file=sys.stderr)
        sys.exit(2)
