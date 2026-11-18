#!/usr/bin/env python3
"""Compare captured OpenAI requests to diagnose prompt-prefix cache misses.

Uses read-only Cloud Logging/GCS APIs or local captures. Output deliberately
excludes prompt text, tool arguments, and credentials. Token counts derived
from request JSON are estimates, NOT OpenAI's model-side cache breakpoints.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote
from urllib.request import Request, urlopen


def compact(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def category(message):
    if not isinstance(message, dict):
        return 'non-object'
    role = message.get('role', '?')
    if role != 'system':
        return str(role)
    content = message.get('content', '')
    if not isinstance(content, str):
        content = compact(content)
    if 'Previously extracted topic info:' in content[:180]:
        return 'topic-info'
    if 'Previous convo summaries:' in content[:180]:
        return 'summary'
    if 'Summary of older conversation messages:' in content[:180]:
        return 'older-history-summary'
    if 'collapsed_group' in content[:100]:
        return 'collapsed-group'
    return 'system'


def changed_fields(before, after):
    if not isinstance(before, dict) or not isinstance(after, dict):
        return ['<value>'] if before != after else []
    return sorted(key for key in before.keys() | after.keys()
                  if before.get(key) != after.get(key))


def describe_change(before, after):
    a = before.get('content') if isinstance(before, dict) else before
    b = after.get('content') if isinstance(after, dict) else after
    aa = a if isinstance(a, str) else '' if a is None else compact(a)
    bb = b if isinstance(b, str) else '' if b is None else compact(b)
    same_chars = 0
    for x, y in zip(aa, bb):
        if x != y:
            break
        same_chars += 1
    description = {
        'old_category': category(before),
        'new_category': category(after),
        'changed_fields': changed_fields(before, after),
        'old_content_chars': len(aa),
        'new_content_chars': len(bb),
        'shared_content_chars': same_chars,
        'old_content_sha256': hashlib.sha256(aa.encode('utf8')).hexdigest()[:12],
        'new_content_sha256': hashlib.sha256(bb.encode('utf8')).hexdigest()[:12],
    }
    if b == 'Tool call failed to respond' and a != b:
        description['hint'] = 'toolCallBackfill synthetic reply; earlier tool response was pruned or absent'
    elif (category(before) == 'system'
          and category(after) in ('older-history-summary', 'summary', 'topic-info')):
        description['hint'] = 'earlier intro/system record disappeared or shifted; inspect sizeLimiter'
    elif before.get('role') == 'user' and after.get('role') == 'assistant':
        description['hint'] = 'earlier user sentinel replaced by appended assistant/tool history'
    elif len(bb) < len(aa) and category(before) == category(after) == 'tool':
        description['hint'] = 'tool response shortened; inspect fileContentsLimiter/sizeLimiter'
    return description


def estimator():
    try:
        import tiktoken
        encoder = tiktoken.get_encoding('o200k_base')
        return lambda text: len(encoder.encode(text)), 'approx o200k_base tokens in JSON'
    except ImportError:
        return lambda text: math.ceil(len(text) / 4), 'rough JSON chars/4 tokens (install tiktoken for better estimate)'


def compare(first, second, count_tokens):
    a = first['body']
    b = second['body']
    old = a.get('messages', [])
    new = b.get('messages', [])
    same = 0
    for x, y in zip(old, new):
        if x != y:
            break
        same += 1
    if same == min(len(old), len(new)):
        kind = 'appended' if len(new) > len(old) else 'removed' if len(new) < len(old) else 'identical'
        first_difference = {'index': same, 'kind': kind}
    else:
        first_difference = {'index': same, 'kind': 'changed',
                            **describe_change(old[same], new[same])}
    changes = [
        {'index': i, **describe_change(x, y)}
        for i, (x, y) in enumerate(zip(old, new)) if x != y
    ]
    fields = sorted(k for k in (set(a) | set(b)) - {'messages', 'tools'}
                    if a.get(k) != b.get(k))
    return {
        'from_capture': first.get('id'), 'to_capture': second.get('id'),
        'from_input_tokens': first.get('input_tokens'),
        'to_input_tokens': second.get('input_tokens'),
        'from_cached_tokens': first.get('cached_tokens'),
        'to_cached_tokens': second.get('cached_tokens'),
        'old_messages': len(old), 'new_messages': len(new),
        'identical_prefix_messages': same,
        'estimated_prefix_message_tokens': count_tokens(compact(old[:same])),
        'tools_identical': a.get('tools') == b.get('tools'),
        'changed_request_settings': fields,
        'first_difference': first_difference,
        'changed_position_count': len(changes),
        'changed_positions': changes[:12],
    }


def get_token(args):
    if args.token_file:
        return Path(args.token_file).read_text().strip()
    if os.environ.get('GOOGLE_OAUTH_ACCESS_TOKEN'):
        return os.environ['GOOGLE_OAUTH_ACCESS_TOKEN'].strip()
    if os.environ.get('GOOGLE_OAUTH_ACCESS_TOKEN_FILE'):
        return Path(os.environ['GOOGLE_OAUTH_ACCESS_TOKEN_FILE']).read_text().strip()
    return subprocess.check_output(['gcloud', 'auth', 'print-access-token'],
                                   stderr=subprocess.DEVNULL, text=True).strip()


def get_json(url, token, body=None):
    headers = {'Authorization': 'Bearer ' + token}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    request = Request(url, headers=headers,
                      data=compact(body).encode() if body is not None else None)
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def cloud_logs(args, token):
    # Ask for the exact usage events only; never log full request content.
    query = (f'resource.type="cloud_run_revision" AND '
             f'resource.labels.service_name="{args.service}" AND '
             f'jsonPayload.event="openai_context_capture_usage" AND '
             f'timestamp>="{args.since}"')
    if args.until:
        query += f' AND timestamp<="{args.until}"'
    items, page = [], None
    while True:
        request = {'resourceNames': ['projects/' + args.project],
                   'filter': query, 'orderBy': 'timestamp asc',
                   'pageSize': min(1000, args.max_requests * 4)}
        if page:
            request['pageToken'] = page
        result = get_json('https://logging.googleapis.com/v2/entries:list', token, request)
        items.extend(result.get('entries', []))
        page = result.get('nextPageToken')
        if not page or len(items) >= args.max_requests * 4:
            break
    return items


def load_rows(args):
    if args.requests:
        return [{'id': Path(path).stem,
                 'body': json.loads(Path(path).read_text()),
                 'input_tokens': None, 'cached_tokens': None}
                for path in args.requests[:args.max_requests]]
    token = get_token(args)
    logs = json.loads(Path(args.usage_json).read_text()) if args.usage_json else cloud_logs(args, token)
    logs = [event for event in logs if
            event.get('jsonPayload', {}).get('event') == 'openai_context_capture_usage'
            and (not args.model or event['jsonPayload'].get('model') == args.model)
            and event.get('jsonPayload', {}).get('capture_id')]
    logs.sort(key=lambda e: e.get('timestamp', ''))
    rows = []
    for event in logs[:args.max_requests]:
        info = event['jsonPayload']
        capture_id = info['capture_id']
        date = event['timestamp'][:10]
        obj = quote(f'{date}/{capture_id}.json', safe='')
        url = f'https://storage.googleapis.com/storage/v1/b/{args.bucket}/o/{obj}?alt=media'
        body = get_json(url, token)
        rows.append({'id': capture_id[:8], 'body': body,
                     'timestamp': event['timestamp'],
                     'input_tokens': info.get('prompt_tokens'),
                     'cached_tokens': info.get('cached_tokens')})
    return rows


def render(rows, comparisons, token_label):
    print(f'Requests: {len(rows)} | prefix estimate: {token_label}')
    total = sum(row.get('input_tokens') or 0 for row in rows)
    cached = sum(row.get('cached_tokens') or 0 for row in rows)
    if total:
        print(f'OpenAI usage: input={total:,} cached={cached:,} ({cached / total:.2%})')
    for i, comparison in enumerate(comparisons, 1):
        print(f'\nRequest {i} -> {i + 1}: cached={comparison["to_cached_tokens"]} '
              f'input={comparison["to_input_tokens"]}')
        print(f'  Identical prefix: {comparison["identical_prefix_messages"]} messages; '
              f'~{comparison["estimated_prefix_message_tokens"]:,} estimated message tokens')
        print(f'  Tool definitions identical: {comparison["tools_identical"]}; '
              f'changed API settings: {comparison["changed_request_settings"] or "none"}')
        diff = comparison['first_difference']
        print(f'  First divergence: messages[{diff["index"]}] ({diff["kind"]})')
        if diff['kind'] == 'changed':
            print(f'    {diff["old_category"]} -> {diff["new_category"]}; '
                  f'fields={diff["changed_fields"]}; '
                  f'content chars {diff["old_content_chars"]:,} -> {diff["new_content_chars"]:,} '
                  f'(shared={diff["shared_content_chars"]:,})')
            if diff.get('hint'):
                print('    Likely source:', diff['hint'])
        if comparison['changed_position_count'] > 1:
            print(f'  Other changed positions: {comparison["changed_position_count"] - 1}; '
                  f'first indices: {[x["index"] for x in comparison["changed_positions"][1:]]}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--usage-json', help='Cloud Logging JSON array (usage events)')
    inputs.add_argument('--since', help='Query Cloud Logging since UTC RFC3339 timestamp')
    inputs.add_argument('--requests', nargs='+', help='Local capture JSON files, chronological order')
    parser.add_argument('--until', help='Optional UTC RFC3339 upper bound for --since')
    parser.add_argument('--project', default='awfl-us')
    parser.add_argument('--service', default='jobs')
    parser.add_argument('--bucket', default='awfl-us-openai-context-capture')
    parser.add_argument('--model', help='Only include usage events for this model')
    parser.add_argument('--token-file', help='OAuth bearer token file (not printed)')
    parser.add_argument('--max-requests', type=int, default=50)
    parser.add_argument('--json-out', help='Write sanitized comparison report JSON')
    args = parser.parse_args(argv)
    if args.max_requests < 2:
        parser.error('--max-requests must be at least 2')
    try:
        rows = load_rows(args)
        if len(rows) < 2:
            raise ValueError('need at least two captured requests to compare')
        count_tokens, label = estimator()
        comparisons = [compare(x, y, count_tokens) for x, y in zip(rows, rows[1:])]
        render(rows, comparisons, label)
        if args.json_out:
            report = {'requests': len(rows), 'token_estimator': label,
                      'total_input_tokens': sum(x.get('input_tokens') or 0 for x in rows),
                      'total_cached_tokens': sum(x.get('cached_tokens') or 0 for x in rows),
                      'comparisons': comparisons}
            Path(args.json_out).write_text(json.dumps(report, indent=2) + '\n')
            print('\nSanitized report written to:', args.json_out)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(1, 'Error: ' + str(exc) + '\n')


if __name__ == '__main__':
    main()
