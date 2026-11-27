"""Scoped production release probe. Requires the installed AWFL CLI's normal auth.

Does not start or retry billable executions. Start the benchmark continuation
only after READY is printed. Prints counts/times/identity checks, never text,
credentials, or raw server errors. Run from a terminal with authorized AWFL
credentials. The probe opens at most two session-scoped connections.
"""
import argparse
import asyncio
import json
import time
from collections import defaultdict

import aiohttp
from awfl.auth import get_auth_headers
from awfl.consumer.live_responses import LiveResponses
from awfl.consumer.sse_parser import SSEParser
from awfl.utils import get_api_origin


async def probe(project, session, timeout):
    if project != "pmbench-152f82a5e40c4048ba38946a22ad094f":
        raise ValueError("Only the approved benchmark project is supported")
    scope = (project, session)
    origin = get_api_origin().rstrip("/")
    headers = {**get_auth_headers(), "x-project-id": project}
    ready = asyncio.Event()
    first_delta = asyncio.Event()
    finished = asyncio.Event()
    start = time.monotonic()
    ids = set()
    timings = {}
    seen = defaultdict(set)
    primary = LiveResponses()
    secondary = LiveResponses()
    primary.select(scope)
    secondary.select(scope)
    primary_text = {}
    secondary_text = {}
    statuses = []

    async with aiohttp.ClientSession(headers=headers, timeout=aiohttp.ClientTimeout(total=None,sock_connect=10,sock_read=30)) as http:
        async def read(state, name, stop_after_delta=False):
            parser = SSEParser()
            async with http.get(origin+"/workflows/events/responses/stream",params={"sessionId":session},headers={"Accept":"text/event-stream"}) as response:
                print(name,"HTTP",response.status,flush=True)
                if response.status!=200:
                    return False
                async for raw in response.content:
                    evt=parser.feed_line(raw.decode("utf-8"))
                    if not evt or not evt["data"]:
                        continue
                    kind=evt["event"]
                    data=json.loads(evt["data"])
                    state.feed(scope,kind,data)
                    if kind=="response.ready" and name=="primary":
                        ready.set()
                    rid=data.get("responseId")
                    if not rid:
                        continue
                    if kind=="response.started" and name=="primary":
                        ids.add(rid)
                        timings[rid]={"started_ms":round((time.monotonic()-start)*1000)}
                    if rid not in ids:
                        continue
                    if kind=="response.delta":
                        seen[(name,rid)].add(data.get("sequence"))
                        if name=="primary":
                            timings.setdefault(rid,{}).setdefault("first_delta_ms",round((time.monotonic()-start)*1000))
                            first_delta.set()
                        if stop_after_delta:
                            return True
                    if kind=="response.provider_finished" and name=="primary":
                        timings.setdefault(rid,{})["terminal_ms"]=round((time.monotonic()-start)*1000)
                        if data.get("hasText"):
                            primary_text[rid]=state.responses[rid].text
                            finished.set()
                    if name=="secondary":
                        r=state.responses.get(rid)
                        if r:
                            secondary_text[rid]=r.text
                    if kind=="response.failed":
                        statuses.append((name,"failed"))
                return False

        p=asyncio.create_task(read(primary,"primary"))
        q=None
        try:
            await asyncio.wait_for(ready.wait(),15)
            print("READY",flush=True)
            await asyncio.wait_for(first_delta.wait(),timeout)
            # Join after first observed delta: tests snapshot or terminal grace.
            q=asyncio.create_task(read(secondary,"secondary"))
            await asyncio.wait_for(finished.wait(),timeout)
            deadline=time.monotonic()+20
            stored={}
            while time.monotonic()<deadline:
                async with http.post(origin+"/workflows/context/topicContextYoj/run",json={"kala":{"kind":"SegKala","sessionId":session,"end":int(time.time()),"windowSeconds":3600},"presetId":"TopicContext","includeDocId":True}) as response:
                    if response.status==200:
                        yoj=(await response.json()).get("yoj",[])
                        stored={m["responseId"]:m["content"] for m in yoj if m.get("role")=="assistant" and m.get("responseId") in primary_text}
                if all(stored.get(rid)==v for rid,v in primary_text.items()) and all(secondary_text.get(rid)==v for rid,v in primary_text.items()):
                    break
                await asyncio.sleep(.5)
            result=[]
            for rid,value in primary_text.items():
                result.append({"response_id":rid,"characters":len(value),"primary_deltas":len(seen[("primary",rid)]),"late_join_deltas":len(seen[("secondary",rid)]),"timing":timings[rid],"persisted_matches":stored.get(rid)==value,"late_join_matches":secondary_text.get(rid)==value})
            print("CANARY_RESULT",json.dumps({"responses":result,"failed_events":statuses}),flush=True)
            assert result and all(x["persisted_matches"] and x["late_join_matches"] and x["timing"]["first_delta_ms"]<x["timing"]["terminal_ms"] for x in result)
        finally:
            for t in [p,q]:
                if t:
                    t.cancel()
            await asyncio.gather(*(t for t in [p,q] if t),return_exceptions=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--project",required=True)
    parser.add_argument("--session",required=True)
    parser.add_argument("--timeout",type=int,default=90)
    args=parser.parse_args()
    asyncio.run(probe(args.project,args.session,args.timeout))
