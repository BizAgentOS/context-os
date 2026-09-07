"""Acceptance checks for the bounded data-tool interface used by the model."""
import json
import shutil
import tempfile
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from raw_baseline import SourceTools, run_question, score_answer

ROOT = Path(__file__).resolve().parents[1]


class RawBaselineTest(unittest.TestCase):
    def test_only_snapshot_sources_can_be_read_and_calculated(self):
        with SourceTools(ROOT / 'data/samples/chengchuan-heating') as tools:
            listing = tools.call('list', {})
            tickets = next(x for x in listing if x['path'].endswith('/tickets.csv'))
            result = tools.call('sql', {'query': f'SELECT count(*) AS n FROM "{tickets["table"]}"'})
            self.assertEqual(result['rows'], [[10]])
            self.assertIn('CS-011', tools.call('read', {'path': tickets['path']})['text'])
            for path in ['../config/heating.json', '/etc/passwd', 'sources/company/event-policy.md', 'manifest.json']:
                self.assertIn('error', tools.call('read', {'path': path}))
            for query in ["ATTACH DATABASE '/tmp/raw-baseline-escape.db' AS outside",
                          'PRAGMA database_list', 'SELECT load_extension(\'evil\')',
                          f'DELETE FROM "{tickets["table"]}"']:
                self.assertIn('error', tools.call('sql', {'query': query}))
            self.assertIn('error', tools.call('shell', {'command': 'cat /etc/passwd'}))
            self.assertEqual(tools.call('sql', {'query': f'SELECT count(*) FROM "{tickets["table"]}"'})['rows'], [[10]])

class AgentLoopTest(unittest.TestCase):
    def test_agent_uses_tools_and_records_usage_without_receiving_answers(self):
        captured = []
        responses = [
            {'tool': 'search', 'args': {'text': 'CS-011'}},
            {'answer': '有该投诉', 'claims': {'exists': True}, 'evidence': [
                {'path': 'sources/service/tickets.csv', 'quote': '文苑一期1号楼201', 'locator': 'CS-011'}]}
        ]
        def model(payload, timeout):
            captured.append(json.loads(json.dumps(payload)))
            return {'model': 'test-fixture', 'choices': [{'message': {'role': 'assistant', 'content': json.dumps(responses.pop(0))}, 'finish_reason': 'stop'}],
                    'usage': {'prompt_tokens': 10, 'completion_tokens': 5}}
        with SourceTools(ROOT / 'data/samples/chengchuan-heating') as tools:
            question = {'id': 'TEST', 'as_of': tools.manifest['as_of'], 'question': '是否有CS-011？', 'private_answer': 'SECRET_EXPECTED_ANSWER'}
            result = run_question(question, tools, BUDGET, 'Use only data tools.', model)
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(result['usage'], {'prompt_tokens': 20, 'completion_tokens': 10})
            self.assertEqual(result['tool_calls'], 1)
            self.assertGreaterEqual(result['elapsed_seconds'], 0)
            self.assertNotIn('DEEPSEEK_API_KEY', json.dumps(captured))
            self.assertNotIn('SECRET_EXPECTED_ANSWER', json.dumps(captured))
            self.assertEqual(captured[0]['messages'][1]['role'], 'user')
            score = score_answer(result, {'exists': True}, tools)
            self.assertEqual(score['claims_passed'], 1)
            self.assertTrue(score['quotes_valid'])
            wrong = score_answer(result, {'exists': False}, tools)
            self.assertEqual(wrong['claims_passed'], 0)
            result['final']['evidence'][0]['quote'] = 'This quotation does not exist.'
            self.assertFalse(score_answer(result, {'exists': True}, tools)['quotes_valid'])

    def test_failed_request_is_not_reported_as_zero_token_success(self):
        def unavailable(payload, timeout):
            raise TimeoutError('secret provider details')
        with SourceTools(ROOT / 'data/samples/chengchuan-heating') as tools:
            result = run_question({'id': 'FAIL', 'as_of': tools.manifest['as_of'], 'question': '查询'}, tools,
                                  BUDGET, 'Data only', unavailable)
            self.assertEqual(result['status'], 'error')
            self.assertFalse(result['usage_complete'])
            self.assertNotIn('secret provider details', json.dumps(result))
            self.assertIsNone(result['final'])

    def test_turn_limit_and_symlink_rejection(self):
        def looping(payload, timeout):
            return {'choices': [{'message': {'content': '{"tool":"list","args":{}}'}, 'finish_reason': 'stop'}]}
        with SourceTools(ROOT / 'data/samples/chengchuan-heating') as tools:
            result = run_question({'id': 'LIMIT', 'as_of': tools.manifest['as_of'], 'question': '查询'}, tools,
                                  BUDGET, 'Data only', looping)
            self.assertEqual(result['status'], 'turn_limit')
            self.assertEqual(result['tool_calls'], 2)
            self.assertIsNone(result['usage']['prompt_tokens'])
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)/'snapshot'
            shutil.copytree(ROOT / 'data/samples/chengchuan-heating', target)
            original = target/'sources/service/tickets.csv'
            original.unlink()
            original.symlink_to(ROOT/'data/samples/chengchuan-heating/sources/service/tickets.csv')
            with self.assertRaises(ValueError):
                SourceTools(target)


BUDGET = {'model': 'test-fixture', 'max_turns': 2, 'max_output_tokens_per_turn': 100,
          'question_timeout_seconds': 10, 'request_timeout_seconds': 1, 'temperature': 0,
          'thinking': {'type': 'disabled'}}

if __name__ == '__main__':
    unittest.main()
