#!/usr/bin/env python3
"""Finite Firestore document import, preserving paths including missing parents.

Run inventory -> schema -> copy -> verify. The source must be quiescent during
the final copy/verify window. OAuth, MCP workspaces and legacy durable execution
stay in their deliberately separate Firestore control plane.

Never logs document values, IDs or secret material.
"""
import argparse
import collections
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

MAX_SAFE_INT=(1<<53)-1
EXCLUDE_ROOT={'apiKeys','mcpOwners','mcpWorkspaces','mcpOAuthRequests',
    'mcpOAuthRefreshTokens','mcpOAuthCodes','mcpOAuthClients',
    'nativeWorkflowExecutions'}
EXCLUDE_CHILD={'mcpCommandKeys'}
SCHEMA=Path(__file__).resolve().parents[2]/'storage/postgres/schema.sql'

def stable(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),
        ensure_ascii=False,allow_nan=False)

def digest(path,value):
    return hashlib.sha256((path+'\0'+stable(value)).encode()).hexdigest()

def decode(value,kinds):
    if not isinstance(value,dict) or len(value)!=1:
        raise ValueError('invalid Firestore value envelope')
    kind,data=next(iter(value.items()))
    kinds[kind]+=1
    if kind=='nullValue': return None
    if kind=='stringValue': return data
    if kind=='booleanValue': return data
    if kind=='timestampValue': return data.replace('+00:00','Z')
    if kind=='integerValue':
        number=int(data)
        if abs(number)>MAX_SAFE_INT:
            raise ValueError('unsafe 64-bit integer')
        return number
    if kind=='doubleValue':
        number=float(data)
        if not math.isfinite(number): raise ValueError('nonfinite float')
        return number
    if kind=='mapValue':
        return {k:decode(v,kinds) for k,v in data.get('fields',{}).items()}
    if kind=='arrayValue':
        return [decode(v,kinds) for v in data.get('values',[])]
    raise ValueError('unsupported Firestore type '+kind)

class Reader:
    def __init__(self,project,token):
        self.base='https://firestore.googleapis.com/v1/projects/'+quote(project)+'/databases/(default)/documents'
        self.token=token
        self.token_path=os.getenv('CLOUDSDK_AUTH_ACCESS_TOKEN_FILE')
    def call(self,path,body=None,params=None):
        url=self.base+path
        if params: url+='?'+urlencode(params)
        payload=stable(body).encode() if body is not None else None
        for attempt in range(6):
            try:
                req=Request(url,data=payload,method='POST' if body is not None else 'GET',
                    headers={'Authorization':'Bearer '+(
                        Path(self.token_path).read_text().strip()
                        if self.token_path else self.token),
                        'Content-Type':'application/json'})
                with urlopen(req,timeout=40) as res: return json.load(res)
            except HTTPError as ex:
                if ex.code not in (429,500,502,503,504) or attempt==5:
                    raise RuntimeError('Firestore HTTP '+str(ex.code)) from ex
            except OSError:
                if attempt==5: raise
            time.sleep(min(2**attempt*0.5,8))
    def collections(self,parent=None):
        path=('/'+quote(parent,safe='/') if parent else '')+':listCollectionIds'
        out=set()
        cursor=None
        while True:
            body={'pageSize':1000}
            if cursor:body['pageToken']=cursor
            res=self.call(path,body)
            out.update(res.get('collectionIds',[]))
            cursor=res.get('nextPageToken')
            if not cursor:return sorted(out)
    def documents(self,collection):
        token=None
        while True:
            args={'pageSize':1000,'showMissing':'true'}
            if token:args['pageToken']=token
            res=self.call('/'+quote(collection,safe='/'),params=args)
            yield from res.get('documents',[])
            token=res.get('nextPageToken')
            if not token:return

def walk(reader,max_documents=500000,workers=6):
    roots=[v for v in reader.collections() if v not in EXCLUDE_ROOT]
    waiting=collections.deque(roots)
    visited=set()
    count=0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        while waiting:
            collection=waiting.popleft()
            if collection in visited:continue
            visited.add(collection)
            docs=list(reader.documents(collection))
            paths=[doc['name'].split('/documents/',1)[1] for doc in docs]
            child_sets=list(ex.map(reader.collections,paths))
            for doc,path,children in zip(docs,paths,child_sets):
                if 'fields' in doc:
                    count+=1
                    if count>max_documents: raise RuntimeError('document limit exceeded')
                    yield path,doc
                for child in children:
                    if child not in EXCLUDE_CHILD:
                        waiting.append(path+'/'+child)

def connect(dsn):
    try:import psycopg
    except ImportError as ex:
        raise RuntimeError('Install psycopg[binary] for SQL operations') from ex
    if not dsn: raise RuntimeError('PG DSN required for SQL operations')
    return psycopg.connect(dsn,autocommit=False)

def run(args):
    if args.mode=='schema':
        with connect(args.pg_dsn) as db:
            with db.cursor() as cur:
                cur.execute("SELECT to_regclass('awfl_documents')")
                if cur.fetchone()[0]: raise RuntimeError('schema already exists')
                cur.execute(SCHEMA.read_text())
            db.commit()
        print('schema initialized')
        return
    if args.mode=='copy' and not args.ack_copy:
        raise RuntimeError('copy requires --ack-copy')
    token=os.getenv('GOOGLE_OAUTH_ACCESS_TOKEN')
    if not token and os.getenv('CLOUDSDK_AUTH_ACCESS_TOKEN_FILE'):
        token=Path(os.environ['CLOUDSDK_AUTH_ACCESS_TOKEN_FILE']).read_text().strip()
    if not token: raise RuntimeError('Firestore bearer token unavailable')
    reader=Reader(args.project,token)
    db=connect(args.pg_dsn) if args.mode in ('copy','verify') else None
    if db:
        with db.cursor() as cur:
            cur.execute("SELECT to_regclass('awfl_documents')")
            if not cur.fetchone()[0]: raise RuntimeError('SQL schema missing')
    kinds=collections.Counter()
    collection_counts=collections.Counter()
    sha=hashlib.sha256()
    imported=0
    missing=0
    try:
        for path,snap in walk(reader,args.max_documents,args.workers):
            value={k:decode(v,kinds) for k,v in snap['fields'].items()
                if k!='__awflStorageMeta'}
            h=digest(path,value)
            sha.update(bytes.fromhex(h))
            collection_counts[path.split('/')[-2]]+=1
            if db:
                with db.cursor() as cur:
                    if args.mode=='copy':
                        parts=path.split('/')
                        cur.execute("""INSERT INTO awfl_documents
                          (path,collection_path,collection_id,document_id,data,
                           revision,created_at,updated_at)
                          VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s)
                          ON CONFLICT(path) DO NOTHING""",
                          (path,'/'.join(parts[:-1]),parts[-2],parts[-1],stable(value),
                           int(snap.get('fields',{}).get('__awflStorageMeta',{})
                               .get('mapValue',{}).get('fields',{})
                               .get('revision',{}).get('integerValue',1)),
                           snap.get('createTime') or '1970-01-01T00:00:00Z',
                           snap.get('updateTime') or '1970-01-01T00:00:00Z'))
                    else:
                        cur.execute("SELECT data FROM awfl_documents WHERE path=%s",(path,))
                        row=cur.fetchone()
                        if row is None or digest(path,row[0])!=h: missing+=1
            imported+=1
            if db and args.mode=='copy' and imported%250==0: db.commit()
        if db:db.commit()
        if db and args.mode=='verify':
            with db.cursor() as cur:
                cur.execute('SELECT count(*) FROM awfl_documents')
                target_total=cur.fetchone()[0]
            if target_total!=imported:
                missing+=abs(target_total-imported)
    except Exception:
        if db:db.rollback()
        raise
    finally:
        if db:db.close()
    print(stable({'mode':args.mode,'documents':imported,
        'collection_counts':dict(sorted(collection_counts.items())),
        'value_types':dict(sorted(kinds.items())),
        'ordered_source_sha256':sha.hexdigest(),
        **({'missing_or_mismatched':missing} if args.mode=='verify' else {})}))
    if missing: raise RuntimeError('missing/mismatched documents in SQL: '+str(missing))

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode',choices=['inventory','schema','copy','verify'])
    p.add_argument('--project',default='awfl-us')
    p.add_argument('--pg-dsn',default=os.getenv('AWFL_MIGRATION_PG_DSN'))
    p.add_argument('--max-documents',type=int,default=500000)
    p.add_argument('--workers',type=int,default=6)
    p.add_argument('--ack-copy',action='store_true')
    args=p.parse_args()
    try:run(args)
    except Exception as ex:
        print('Migration stopped safely: '+str(ex),file=sys.stderr)
        sys.exit(2)
