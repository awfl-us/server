"""Unit tests for the read-only cache-prefix comparison CLI."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout

MODULE = Path(__file__).with_name('openai_cache_diff.py')
SPEC = importlib.util.spec_from_file_location('openai_cache_diff', MODULE)
DIFF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIFF)


def row(messages, cached=0, tools=None, **extra):
    return {'id': 'capture', 'body': {'model': 'test-model', 'messages': messages,
            'tools': tools or [], **extra}, 'input_tokens': 4000,
            'cached_tokens': cached}


class CacheDiffTests(unittest.TestCase):
    def test_append_only_preserves_prefix(self):
        old = [{'role': 'system', 'content': 'stable'},
               {'role': 'user', 'content': 'original'}]
        new = old + [{'role': 'assistant', 'content': 'answer'}]
        diff = DIFF.compare(row(old), row(new, 1024), lambda text: len(text))
        self.assertEqual(diff['identical_prefix_messages'], 2)
        self.assertEqual(diff['first_difference'], {'index': 2, 'kind': 'appended'})
        self.assertTrue(diff['tools_identical'])

    def test_tool_backfill_reports_prior_response_replaced(self):
        tool_call = {'role': 'assistant', 'tool_calls': [{'id': 'call_1'}]}
        reply = {'role': 'tool', 'tool_call_id': 'call_1',
                 'content': 'private file contents ' * 100}
        synthetic = {'role': 'tool', 'tool_call_id': 'call_1',
                     'content': 'Tool call failed to respond'}
        diff = DIFF.compare(row([tool_call, reply]),
                            row([tool_call, synthetic]), len)
        self.assertEqual(diff['first_difference']['index'], 1)
        self.assertIn('toolCallBackfill', diff['first_difference']['hint'])
        self.assertGreater(diff['first_difference']['old_content_chars'], 100)
        self.assertNotIn('private file contents', json.dumps(diff))

    def test_removed_system_message_breaks_early_prefix(self):
        intro = {'role': 'system', 'content': 'context intro'}
        summary = {'role': 'system', 'content': 'Summary of older conversation messages: {}'}
        old = [{'role': 'system', 'content': 'static'}, intro, summary]
        new = [{'role': 'system', 'content': 'static'}, summary]
        diff = DIFF.compare(row(old), row(new), len)
        self.assertEqual(diff['identical_prefix_messages'], 1)
        self.assertEqual(diff['first_difference']['index'], 1)
        self.assertIn('sizeLimiter', diff['first_difference']['hint'])

    def test_settings_and_tool_schema_drift_are_exposed(self):
        first = row([{'role': 'system', 'content': 'same'}],
                    tools=[{'function': {'name': 'first'}}], tool_choice='auto')
        second = row(first['body']['messages'],
                     tools=[{'function': {'name': 'changed'}}], tool_choice='none')
        diff = DIFF.compare(first, second, len)
        self.assertFalse(diff['tools_identical'])
        self.assertEqual(diff['changed_request_settings'], ['tool_choice'])
        self.assertEqual(diff['first_difference']['kind'], 'identical')

    def test_offline_cli_omits_raw_contents_from_stdout_and_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            one = Path(tmp) / 'one.json'
            two = Path(tmp) / 'two.json'
            report = Path(tmp) / 'report.json'
            secret = 'very confidential value from repo'
            one.write_text(json.dumps(row([{'role': 'system', 'content': secret}])['body']))
            two.write_text(json.dumps(row([{'role': 'system', 'content': secret},
                                           {'role': 'user', 'content': 'ok'}])['body']))
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                DIFF.main(['--requests', str(one), str(two), '--json-out', str(report)])
            self.assertNotIn(secret, stdout.getvalue())
            self.assertNotIn(secret, report.read_text())
            self.assertEqual(json.loads(report.read_text())['requests'], 2)


if __name__ == '__main__':
    unittest.main()
