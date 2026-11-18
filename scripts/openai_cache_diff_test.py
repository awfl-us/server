#!/usr/bin/env python3
"""Offline tests for the structural prompt-cache diff diagnostic."""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

SOURCE = pathlib.Path(__file__).with_name('openai_cache_diff.py')
SPEC = importlib.util.spec_from_file_location('openai_cache_diff', SOURCE)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


def msg(role, content, **extra):
    return {'role': role, 'content': content, **extra}


class CacheDiffTests(unittest.TestCase):
    def setUp(self):
        self.estimate = lambda x: len(json.dumps(x)) // 4

    def test_append_only_and_tool_changes(self):
        a = {'messages': [msg('system', 'fixed'), msg('user', 'request')],
             'tools': [{'type': 'function', 'function': {'name': 'read'}}], 'model': 'test-model'}
        b = {'messages': a['messages'] + [msg('assistant', None,
             tool_calls=[{'id': 'id', 'type': 'function'}])],
             'tools': a['tools'], 'model': 'test-model'}
        pair = mod.analyze_pair(a, b, self.estimate)
        self.assertEqual(mod.classify(pair), 'append-only: cache-friendly')
        self.assertEqual(pair['common_messages'], 2)
        self.assertTrue(pair['tools_unchanged'])
        b['tools'] = [{'type': 'function', 'function': {'name': 'changed'}}]
        pair = mod.analyze_pair(a, b, self.estimate)
        self.assertEqual(mod.classify(pair), 'model/tool configuration changed')

    def test_moving_completion_marker_breaks_prefix(self):
        a = {'messages': [msg('user', 'main'), msg('user', 'Tool calls completed')]}
        b = {'messages': [msg('user', 'main'), msg('assistant', None,
            tool_calls=[{'id': 'tool1'}]), msg('tool', 'result', tool_call_id='tool1'),
            msg('user', 'Tool calls completed')]}
        pair = mod.analyze_pair(a, b, self.estimate)
        self.assertEqual(mod.classify(pair), 'completion marker shifted/replaced; check dropToolCallsCompleted')
        self.assertEqual(pair['common_messages'], 1)
        self.assertEqual(pair['edits'][0]['kind'], 'insert')
        self.assertEqual(pair['old_ending_category'], 'tool-completion-marker')

    def test_tool_backfill_and_early_truncation(self):
        initial = {'messages': [msg('system', 'static'),
            msg('system', 'These are the previously extracted topic information'),
            msg('system', '(Term) Summary content'), msg('tool', 'PRIVATE SECRETS'),
            msg('user', 'finish')]}
        pruned = {'messages': [msg('system', 'static'),
            msg('tool', 'Tool call failed to respond'), msg('user', 'finish')]}
        pair = mod.analyze_pair(initial, pruned, self.estimate)
        self.assertIn('early context pruned', mod.classify(pair))
        self.assertEqual(pair['common_messages'], 1)
        report = mod.build_report([
            {'timestamp': '2026-11-18T17:00:00Z', 'capture_id': 'a', 'input_tokens': 100, 'cached_tokens': 0},
            {'timestamp': '2026-11-18T17:00:01Z', 'capture_id': 'b', 'input_tokens': 100, 'cached_tokens': 0},
        ], [initial, pruned])
        rendered = json.dumps(report)
        self.assertNotIn('PRIVATE SECRETS', rendered)
        self.assertNotIn('Summary content', rendered)
        self.assertIn('context-intro', rendered)

    def test_usage_parse_order_and_model_filter(self):
        entries = [
            {'timestamp': '2026-11-18T17:00:02Z', 'jsonPayload': {
                'event': 'openai_context_capture_usage', 'capture_id': 'later',
                'model': 'terra', 'cached_tokens': 500, 'prompt_tokens': 1000}},
            {'timestamp': '2026-11-18T17:00:01Z', 'jsonPayload': {
                'event': 'openai_context_capture_usage', 'capture_id': 'earlier',
                'model': 'terra', 'cached_tokens': 0, 'prompt_tokens': 500}},
            {'timestamp': '2026-11-18T17:00:01Z', 'jsonPayload': {
                'event': 'openai_context_capture_usage', 'capture_id': 'irrelevant',
                'model': 'other', 'cached_tokens': 0, 'prompt_tokens': 500}},
            {'timestamp': '2026-11-18T17:00:01Z', 'jsonPayload': {
                'event': 'openai_context_capture_saved', 'capture_id': 'saved',
                'model': 'terra'}},
        ]
        rows = mod.parse_usage(entries, 'terra')
        self.assertEqual([r['capture_id'] for r in rows], ['earlier', 'later'])
        self.assertEqual(rows[1]['cached_tokens'], 500)

    def test_offline_cli_never_prints_user_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            captures = root / '2026-11-18'
            captures.mkdir()
            for name, words in [('first', 'SENSITIVE PROMPT CONTENT'),
                                ('second', 'SENSITIVE PROMPT CONTENT')]:
                (captures / f'{name}.json').write_text(json.dumps({
                    'model': 'test', 'messages': [msg('user', words)], 'tools': []}))
            usage = root / 'usage.json'
            usage.write_text(json.dumps([
                {'timestamp': '2026-11-18T17:00:00Z', 'jsonPayload': {
                    'capture_id': 'first', 'event': 'openai_context_capture_usage',
                    'model': 'test', 'prompt_tokens': 100, 'cached_tokens': 0}},
                {'timestamp': '2026-11-18T17:00:01Z', 'jsonPayload': {
                    'capture_id': 'second', 'event': 'openai_context_capture_usage',
                    'model': 'test', 'prompt_tokens': 110, 'cached_tokens': 90}},
            ]))
            cmd = [sys.executable, str(SOURCE), '--usage-file', str(usage),
                   '--capture-dir', str(root), '--model', 'test']
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            self.assertIn('Requests: 2', result.stdout)
            self.assertNotIn('SENSITIVE PROMPT CONTENT', result.stdout)
            result = subprocess.run(cmd + ['--json'], capture_output=True, text=True, check=True)
            body = json.loads(result.stdout)
            self.assertEqual(body['total_cached_tokens'], 90)
            self.assertNotIn('SENSITIVE PROMPT CONTENT', result.stdout)


if __name__ == '__main__':
    unittest.main()
