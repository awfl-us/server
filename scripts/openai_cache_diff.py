#!/usr/bin/env python3
"""Safely diff captured OpenAI Chat Completion requests and compare cache usage.

Examples:
  python3 scripts/openai_cache_diff.py --usage-file usage.json --bucket awfl-us-openai-context-capture --token-file /tmp/gcp-token
  python3 scripts/openai_cache_diff.py --project awfl-us --start 2026-11-18T17:04:00Z --end 2026-11-18T17:09:00Z
  python3 scripts/openai_cache_diff.py --usage-file usage.json --capture-dir /secure/local/captures --json

Only structural differences, lengths, and field names are printed. Never prints
message contents, tool arguments, API keys, or any other captured prompt text.
"""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request

DEFAULT_BUCKET = 'awfl-us-openai-context-capture'


def request_json(url, token, payload=None):
    headers = {'Authorization': 'Bearer ' + token}
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, headers=headers,
        data=json.dumps(payload).encode('utf-8') if payload is not None else None,
        method='POST' if payload is not None else 'GET')
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def get_token(path):
    path = path or os.environ.get('AWFL_GOOGLE_ACCESS_TOKEN_FILE')
    if path:
        return Path(path).read_text().strip()
    if os.environ.get('GOOGLE_OAUTH_ACCESS_TOKEN'):
        return os.environ['GOOGLE_OAUTH_ACCESS_TOKEN']
    return subprocess.check_output(['gcloud', 'auth', 'print-access-token'], text=True).strip()


def query_usage(project, start, end, token, service='jobs'):
    filters = [
        'resource.type="cloud_run_revision"',
        f'resource.labels.service_name="{service}"',
        'jsonPayload.event="openai_context_capture_usage"',
        f'timestamp>="{start}"',
    ]
    if end:
        filters.append(f'timestamp<="{end}"')
    entries = []
    page_token = ''
    for _ in range(40):
        body = {'resourceNames': [f'projects/{project}'],
            'filter': ' AND '.join(filters), 'orderBy': 'timestamp asc',
            'pageSize': 200}
        if page_token:
            body['pageToken'] = page_token
        data = request_json('https://logging.googleapis.com/v2/entries:list', token, body)
        entries.extend(data.get('entries') or [])
        page_token = data.get('nextPageToken')
        if not page_token:
            break
    else:
        raise RuntimeError('Too many Cloud Logging pages; narrow the time window')
    return entries


def parse_usage(raw, model=None):
    if isinstance(raw, dict):
        raw = raw.get('entries', [])
    records = []
    for entry in raw:
        data = entry.get('jsonPayload', entry)
        if data.get('event') not in (None, 'openai_context_capture_usage'):
            continue
        if not data.get('capture_id') or (model and data.get('model') != model):
            continue
        timestamp = entry.get('timestamp', data.get('timestamp', ''))
        if not timestamp:
            continue
        records.append({'timestamp': timestamp, 'capture_id': data['capture_id'],
            'model': data.get('model'), 'input_tokens': data.get('prompt_tokens'),
            'cached_tokens': data.get('cached_tokens')})
    records.sort(key=lambda x: (x['timestamp'], x['capture_id']))
    return records


def load_capture(record, bucket, capture_dir, token):
    date = record['timestamp'][:10]
    capture_id = record['capture_id']
    if capture_dir:
        for path in (Path(capture_dir) / date / f'{capture_id}.json',
                     Path(capture_dir) / f'{capture_id}.json'):
            if path.is_file():
                return json.loads(path.read_text())
        raise FileNotFoundError(f'Capture {date}/{capture_id}.json missing under {capture_dir}')
    object_name = f'{date}/{capture_id}.json'
    url = (f'https://storage.googleapis.com/storage/v1/b/{bucket}/o/' +
           urllib.parse.quote(object_name, safe='') + '?alt=media')
    return request_json(url, token)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def category(message):
    if not isinstance(message, dict):
        return 'non-message'
    role = message.get('role') or 'unknown'
    content = message.get('content')
    if isinstance(content, str):
        if content.startswith('These are the previously extracted topic information'):
            return 'context-intro'
        if content.startswith(('(Week) ', '(Term) ', '(Session) ', '(Convo) ')):
            prefix = content.split(' ', 1)[0]
            return 'promoted-summary:' + prefix.strip('()').lower()
        if content.startswith('Previously extracted topic info:'):
            return 'topic-summary'
        if content.startswith('Previous convo summaries:'):
            return 'conversation-summary'
        if content.strip() == 'Tool calls completed':
            return 'tool-completion-marker'
        if content == 'Tool call failed to respond':
            return 'synthetic-missing-tool-result'
    if role == 'assistant' and message.get('tool_calls'):
        return 'assistant-tool-call'
    return role


def field_differences(old, new, path='message', limit=8):
    """Return changed paths without leaking the captured values."""
    changes = []
    def visit(a, b, key):
        if len(changes) >= limit or a == b:
            return
        if isinstance(a, dict) and isinstance(b, dict):
            for field in sorted(set(a) | set(b)):
                if len(changes) >= limit:
                    break
                if field not in a or field not in b:
                    changes.append(key + '.' + field + ' (added/removed)')
                else:
                    visit(a[field], b[field], key + '.' + field)
        elif isinstance(a, list) and isinstance(b, list):
            for i in range(min(len(a), len(b))):
                if len(changes) >= limit:
                    break
                visit(a[i], b[i], key + f'[{i}]')
            if len(a) != len(b):
                changes.append(key + '.length')
        elif isinstance(a, str) and isinstance(b, str):
            n = 0
            while n < min(len(a), len(b)) and a[n] == b[n]:
                n += 1
            changes.append(f'{key} (text differs at character {n}; lengths {len(a)}->{len(b)})')
        else:
            changes.append(key + ' (type/value changed)')
    visit(old, new, path)
    return changes


def token_estimator():
    try:
        import tiktoken
        enc = tiktoken.get_encoding('o200k_base')
        return (lambda obj: len(enc.encode(canonical(obj)))), 'o200k_base estimate (NOT actual model tokenization)'
    except (ImportError, ValueError, RuntimeError):
        return (lambda obj: (len(canonical(obj)) + 3) // 4), 'JSON chars/4 estimate (NOT actual model tokenization)'


def analyze_pair(old, new, estimate):
    a, b = old.get('messages') or [], new.get('messages') or []
    common = 0
    for left, right in zip(a, b):
        if left != right:
            break
        common += 1
    prior_tools = old.get('tools') or []
    next_tools = new.get('tools') or []
    all_options = sorted((set(old) | set(new)) - {'messages', 'tools'})
    option_changes = [key for key in all_options if key not in ('messages','tools') and old.get(key) != new.get(key)]
    hashes_a = [hashlib.sha256(canonical(m).encode()).hexdigest() for m in a]
    hashes_b = [hashlib.sha256(canonical(m).encode()).hexdigest() for m in b]
    edit_ops = []
    for operation, ai, aj, bi, bj in difflib.SequenceMatcher(
        a=hashes_a, b=hashes_b, autojunk=False).get_opcodes():
        if operation == 'equal':
            continue
        edits = {'kind': operation, 'old_range': [ai, aj], 'new_range': [bi, bj],
            'old_categories': [category(msg) for msg in a[ai:aj]],
            'new_categories': [category(msg) for msg in b[bi:bj]]}
        if operation == 'replace' and ai < aj and bi < bj:
            edits['fields'] = field_differences(a[ai], b[bi])
        edit_ops.append(edits)
    return {'common_messages': common, 'old_message_count': len(a),
        'old_ending_category': category(a[-1]) if a else None,
        'new_message_count': len(b),
        'common_message_prefix_tokens_approx': estimate(a[:common]),
        'tools_unchanged': prior_tools == next_tools,
        'tool_tokens_approx': estimate(prior_tools),
        'request_option_changes': option_changes, 'edits': edit_ops}


def classify(pair):
    if pair['request_option_changes'] or not pair['tools_unchanged']:
        return 'model/tool configuration changed'
    edits = pair['edits']
    if not edits:
        return 'identical prompt'
    if all(op['kind'] == 'insert' and op['old_range'][0] == pair['old_message_count'] for op in edits):
        return 'append-only: cache-friendly'
    if any('context-intro' in op['old_categories'] and op['kind'] in ('replace','delete') for op in edits):
        return 'early context pruned; check sizeLimiter'
    if any('synthetic-missing-tool-result' in op['new_categories'] for op in edits):
        return 'past tool response rewritten; check toolCallBackfill and pruning'
    if any('tool-completion-marker' in op['old_categories'] for op in edits) or (
        pair['old_ending_category'] == 'tool-completion-marker' and
        any(op['kind'] == 'insert' and op['old_range'][0] < pair['old_message_count'] for op in edits)):
        return 'completion marker shifted/replaced; check dropToolCallsCompleted'
    if any(op['kind'] in ('delete', 'replace') for op in edits):
        return 'historical message edited or removed'
    return 'new content inserted before end'


def build_report(usage, captures):
    estimate, estimator_name = token_estimator()
    calls = []
    for item, capture in zip(usage, captures):
        calls.append({**item, 'message_count': len(capture.get('messages') or []),
            'tools_count': len(capture.get('tools') or [])})
    comparisons = []
    for i in range(1, len(usage)):
        details = analyze_pair(captures[i - 1], captures[i], estimate)
        details['from_call'] = i
        details['to_call'] = i + 1
        details['observed_cached_tokens'] = usage[i].get('cached_tokens')
        details['interpretation'] = classify(details)
        comparisons.append(details)
    total_input = sum(call.get('input_tokens') or 0 for call in calls)
    total_cached = sum(call.get('cached_tokens') or 0 for call in calls)
    return {'estimator': estimator_name, 'calls': calls, 'comparisons': comparisons,
        'total_input_tokens': total_input, 'total_cached_tokens': total_cached,
        'observed_cache_share_pct': round(total_cached / total_input * 100, 2) if total_input else None}


def print_report(report):
    print('Tokenizer:', report['estimator'])
    print('Requests:', len(report['calls']), 'input:', report['total_input_tokens'],
          'cached:', report['total_cached_tokens'], 'cached share:',
          str(report['observed_cache_share_pct']) + '%')
    for i, call in enumerate(report['calls'], 1):
        print(f"  #{i} {call['timestamp']}  id={call['capture_id'][:8]} "
              f"input={call['input_tokens']} cached={call['cached_tokens']} "
              f"msgs={call['message_count']} tools={call['tools_count']}")
    for item in report['comparisons']:
        print(f"\n  #{item['from_call']} -> #{item['to_call']}: "
              f"{item['interpretation']} (observed cached={item['observed_cached_tokens']})")
        print(f"    identical first {item['common_messages']} messages; "
              f"estimated message-prefix tokens={item['common_message_prefix_tokens_approx']}; "
              f"tool definitions unchanged={item['tools_unchanged']}; "
              f"tool-token estimate={item['tool_tokens_approx']}")
        if item['request_option_changes']:
            print('    config changes:', ', '.join(item['request_option_changes']))
        for op in item['edits']:
            print('    ', op['kind'], f"old[{op['old_range'][0]}:{op['old_range'][1]}]",
                  f"new[{op['new_range'][0]}:{op['new_range'][1]}]",
                  'before=' + str(op['old_categories']),
                  'after=' + str(op['new_categories']))
            if op.get('fields'):
                print('       changed fields:', ', '.join(op['fields']))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--project', help='GCP project, required if no --usage-file')
    parser.add_argument('--start', help='Cloud Logging UTC start ISO timestamp')
    parser.add_argument('--end', help='Cloud Logging UTC end ISO timestamp')
    parser.add_argument('--usage-file', help='Existing gcloud logging read --format=json output')
    parser.add_argument('--capture-dir', help='Local directory of downloaded <date>/<id>.json capture files')
    parser.add_argument('--bucket', default=os.environ.get('AWFL_OPENAI_CONTEXT_CAPTURE_BUCKET', DEFAULT_BUCKET))
    parser.add_argument('--token-file', help='Google OAuth token file (never included in output)')
    parser.add_argument('--model', default=None, help='Filter response model (default: all)')
    parser.add_argument('--service', default='jobs', help='Cloud Run logging service')
    parser.add_argument('--json', action='store_true', help='Emit JSON with metadata, no prompt content')
    args = parser.parse_args(argv)
    if not args.usage_file and not (args.project and args.start):
        parser.error('Provide --usage-file, or both --project and --start')
    token = get_token(args.token_file) if not args.capture_dir or not args.usage_file else None
    entries = json.loads(Path(args.usage_file).read_text()) if args.usage_file else query_usage(
        args.project, args.start, args.end, token, args.service)
    usage = parse_usage(entries, args.model)
    if not usage:
        raise SystemExit('No matching OpenAI cache-usage events found')
    captures = [load_capture(record, args.bucket, args.capture_dir, token) for record in usage]
    report = build_report(usage, captures)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report)


if __name__ == '__main__':
    main()
