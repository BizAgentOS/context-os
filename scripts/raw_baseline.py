#!/usr/bin/env python3
"""Small raw-source agent baseline. No shell, host file access or writable SQL tool."""
import argparse
import csv
import hashlib
import io
import json
import os
import sqlite3
import time
import urllib.request
from pathlib import Path

from validate_heating_sample import validate

ROOT = Path(__file__).resolve().parents[1]


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SourceTools:
    """Load a validated snapshot once; dispatch accesses only its in-memory copies."""
    def __init__(self, snapshot):
        snapshot = Path(snapshot)
        if any(p.is_symlink() for p in snapshot.rglob('*')):
            raise ValueError('Snapshot symlinks are not allowed')
        validate(snapshot, quiet=True)
        self.manifest = json.loads((snapshot / 'manifest.json').read_text())
        self.texts, self.catalog = {}, []
        self.db = sqlite3.connect(':memory:')
        for i, entry in enumerate(self.manifest['files']):
            path = entry['path']
            text = (snapshot / path).read_text(encoding='utf-8')
            self.texts[path] = text
            item = {k: entry[k] for k in ('path', 'source_id', 'format')}
            if entry['format'] == 'csv':
                table = f'source_{i}'
                rows = list(csv.reader(io.StringIO(text)))
                columns = ','.join('"' + c.replace('"', '""') + '" TEXT' for c in rows[0])
                self.db.execute(f'CREATE TABLE "{table}" ({columns})')
                self.db.executemany(f'INSERT INTO "{table}" VALUES ({",".join("?" for _ in rows[0])})', rows[1:])
                item.update(table=table, columns=rows[0], rows=len(rows)-1)
            self.catalog.append(item)
        self.db.commit()
        self.db.set_authorizer(self.authorize)

    @staticmethod
    def authorize(action, arg1, arg2, database, trigger):
        allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ}
        functions = {'count', 'sum', 'avg', 'min', 'max', 'round', 'cast', 'coalesce', 'nullif',
                     'substr', 'substring', 'length', 'lower', 'upper', 'like', 'abs',
                     'row_number', 'rank', 'dense_rank', 'trim'}
        if action in allowed or (action == sqlite3.SQLITE_FUNCTION and arg2.lower() in functions):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY

    def call(self, name, args):
        try:
            if name == 'list':
                return self.catalog
            if name == 'read':
                text = self.texts[args['path']]
                offset = int(args.get('offset', 0))
                if offset < 0:
                    raise ValueError('Negative offset')
                return {'text': text[offset:offset+12000], 'next_offset': offset+12000 if len(text)>offset+12000 else None}
            if name == 'search':
                query = args['text']
                if not isinstance(query, str) or not query or len(query) > 200:
                    raise ValueError('Search text must be 1..200 characters')
                hits = [{'path': path, 'line': n, 'text': line[:1000]}
                        for path, text in self.texts.items() for n, line in enumerate(text.splitlines(), 1)
                        if query.casefold() in line.casefold()]
                return {'hits': hits[:40], 'truncated': len(hits)>40}
            if name == 'sql':
                query = args['query']
                if not isinstance(query, str) or len(query) > 12000:
                    raise ValueError('SQL too long')
                deadline = time.monotonic()+2
                self.db.set_progress_handler(lambda: int(time.monotonic()>deadline), 1000)
                cursor = self.db.execute(query)
                rows = cursor.fetchmany(101)
                result = {'columns': [c[0] for c in cursor.description], 'rows': [list(row) for row in rows[:100]], 'truncated': len(rows)>100}
                if len(dump(result)) > 16000:
                    raise ValueError('Result too large; aggregate or select fewer columns/rows')
                return result
            raise ValueError('Unknown tool; only list/read/search/sql are available')
        except (KeyError, ValueError, TypeError, sqlite3.Error):
            return {'error': 'Rejected or invalid request; use listed sources and read-only SQL within result limits.'}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.db.close()


def request_model(payload, timeout):
    key = os.environ.get('DEEPSEEK_API_KEY')
    if not key:
        raise ValueError('DEEPSEEK_API_KEY is not configured')
    request = urllib.request.Request('https://api.deepseek.com/chat/completions',
        data=dump(payload).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer '+key})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def run_question(question, tools, budget, system, model=request_model):
    """One fresh model conversation. The callable receives no evaluator or filesystem object."""
    started = time.monotonic()
    messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': dump({
        'as_of': question['as_of'], 'question': question['question'],
        'sources': tools.catalog, 'max_turns': budget['max_turns']})}]
    result = dict(question_id=question['id'], as_of=question['as_of'], status='turn_limit',
                  final=None, usage={'prompt_tokens': 0, 'completion_tokens': 0},
                  tool_calls=0, api_attempts=0, usage_complete=True, responses=[], messages=messages, requested_model=budget['model'])
    for turn in range(budget['max_turns']):
        remaining = budget['question_timeout_seconds']-(time.monotonic()-started)
        if remaining <= 0:
            result['status'] = 'timeout'
            break
        payload = dict(model=budget['model'], messages=messages, stream=False,
                       response_format={'type': 'json_object'}, temperature=budget['temperature'],
                       thinking=budget['thinking'], max_tokens=budget['max_output_tokens_per_turn'])
        response_received = False
        result['api_attempts'] += 1
        try:
            response = model(payload, min(remaining, budget['request_timeout_seconds']))
            response_received = True
            result['responses'].append(response)
            for key in result['usage']:
                value = response.get('usage', {}).get(key)
                if value is None or result['usage'][key] is None:
                    result['usage'][key] = None
                    result['usage_complete'] = False
                else:
                    result['usage'][key] += value
            choice = response['choices'][0]
            content = choice['message']['content']
            messages.append({'role': 'assistant', 'content': content})
            if choice.get('finish_reason') != 'stop':
                result['status'] = 'incomplete_model_response'
                break
            action = json.loads(content)
            if 'tool' in action:
                result['tool_calls'] += 1
                output = tools.call(action['tool'], action.get('args', {}))
                messages.append({'role': 'user', 'content': dump({'tool_result': output,
                                 'turns_remaining': budget['max_turns']-turn-1})})
            elif isinstance(action.get('answer'), str) and isinstance(action.get('claims'), dict) and isinstance(action.get('evidence'), list):
                result.update(status='completed', final=action)
                break
            else:
                raise ValueError('Invalid model protocol')
        except Exception as error:
            # Do not persist request headers, credentials or provider error bodies.
            if not response_received:
                result['usage_complete'] = False
            result.update(status='error', error_type=type(error).__name__)
            break
    result['elapsed_seconds'] = round(time.monotonic()-started, 3)
    return result


def score_answer(result, expected, tools):
    """Mechanical claims/quote checks only; evidence entailment requires separate review."""
    final = result.get('final') or {}
    actual = final.get('claims', {})
    checks = {}
    for key, value in expected.items():
        answer = actual.get(key)
        if type(value) in (int, float) and type(answer) in (int, float):
            checks[key] = abs(answer-value) <= 0.001
        else:
            checks[key] = key in actual and type(answer) is type(value) and answer == value
    evidence = final.get('evidence', [])
    valid = bool(evidence) and all(isinstance(e, dict) and isinstance(e.get('quote'), str)
        and len(e['quote']) >= 6 and e.get('path') in tools.texts
        and e['quote'] in tools.texts[e['path']] and bool(e.get('locator')) for e in evidence)
    return dict(question_id=result['question_id'], status=result['status'], claims=checks,
                claims_passed=sum(checks.values()), claims_total=len(checks), quotes_valid=valid,
                evidence_support='pending_human_review')


PUBLIC = ROOT / 'config/evaluation'
PRIVATE = ROOT / 'data/private/chengchuan-heating/evaluation'


def evaluation_inputs():
    return [PUBLIC/'development.json', PUBLIC/'raw-budget.json', PUBLIC/'raw-system.txt',
            PRIVATE/'holdout.json', PRIVATE/'answers.json', PRIVATE/'review-rubric.md',
            ROOT/'scripts/raw_baseline.py', ROOT/'scripts/heating_data.py', ROOT/'scripts/validate_heating_sample.py']


def load_questions(suite):
    paths = [PUBLIC/'development.json'] if suite == 'development' else [PRIVATE/'holdout.json']
    if suite == 'all':
        paths = [PUBLIC/'development.json', PRIVATE/'holdout.json']
    return [q for path in paths for q in json.loads(path.read_text())]


def freeze(author_run):
    import tempfile
    from heating_data import export
    target = PUBLIC/'freeze.json'
    if target.exists():
        raise ValueError('Freeze already exists; do not overwrite a recorded experiment')
    questions = load_questions('all')
    snapshots = {}
    with tempfile.TemporaryDirectory() as temp:
        for i, at in enumerate(sorted({q['as_of'] for q in questions})):
            snapshot = Path(temp)/str(i)
            export(author_run, at, snapshot)
            snapshots[at] = sha(snapshot/'manifest.json')
    value = dict(version=1, files={str(p.relative_to(ROOT)): sha(p) for p in evaluation_inputs()},
                 snapshots=snapshots, cases=[{'id': q['id'], 'as_of': q['as_of']} for q in questions])
    target.write_text(dump(value), encoding='utf-8')
    print('Frozen 5 development + 5 held-out questions, rubric, budgets, code and 2 snapshots.')


def verify_freeze():
    frozen = json.loads((PUBLIC/'freeze.json').read_text())
    for path in evaluation_inputs():
        if sha(path) != frozen['files'][str(path.relative_to(ROOT))]:
            raise ValueError(f'Frozen input changed: {path.relative_to(ROOT)}')
    return frozen


def run_suite(author_run, suite, output):
    import tempfile
    from heating_data import export
    frozen = verify_freeze()
    budget = json.loads((PUBLIC/'raw-budget.json').read_text())
    system = (PUBLIC/'raw-system.txt').read_text()
    if not os.environ.get('DEEPSEEK_API_KEY'):
        raise ValueError('DEEPSEEK_API_KEY is not configured')
    # Results persist per question, including errors. Existing experiments are immutable.
    output.mkdir(parents=True, exist_ok=False)
    (output/'run.json').write_text(dump(dict(suite=suite, freeze_sha256=sha(PUBLIC/'freeze.json'),
        budget=budget, code_sha256=sha(Path(__file__)), provider='https://api.deepseek.com',
        protocol='JSON action loop; raw-source read/search/SQL; fresh conversation per question')))
    for q in load_questions(suite):
        with tempfile.TemporaryDirectory() as temp:
            snapshot = Path(temp)/'snapshot'
            export(author_run, q['as_of'], snapshot)
            if sha(snapshot/'manifest.json') != frozen['snapshots'][q['as_of']]:
                raise ValueError('Snapshot differs from frozen input')
            with SourceTools(snapshot) as tools:
                result = run_question(q, tools, budget, system)
            result['snapshot_manifest_sha256'] = sha(snapshot/'manifest.json')
        (output/f'{q["id"]}.json').write_text(dump(result), encoding='utf-8')
        print(q['id'], result['status'], result['usage'], result['elapsed_seconds'], flush=True)


def score_suite(author_run, result_dir):
    import tempfile
    from heating_data import export
    frozen = verify_freeze()
    meta = json.loads((result_dir/'run.json').read_text())
    if meta['freeze_sha256'] != sha(PUBLIC/'freeze.json'):
        raise ValueError('Run uses a different freeze')
    if (result_dir/'scores.json').exists():
        raise ValueError('Scores already exist')
    expected = json.loads((PRIVATE/'answers.json').read_text())
    scores = []
    for q in load_questions(meta['suite']):
        result = json.loads((result_dir/f'{q["id"]}.json').read_text())
        with tempfile.TemporaryDirectory() as temp:
            snapshot = Path(temp)/'snapshot'
            export(author_run, q['as_of'], snapshot)
            if sha(snapshot/'manifest.json') != frozen['snapshots'][q['as_of']] or result['snapshot_manifest_sha256'] != sha(snapshot/'manifest.json'):
                raise ValueError('Score snapshot mismatch')
            with SourceTools(snapshot) as tools:
                scores.append(score_answer(result, expected[q['id']], tools))
    (result_dir/'scores.json').write_text(dump(scores), encoding='utf-8')
    print(dump(scores))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['freeze', 'run', 'score'])
    parser.add_argument('--author-run', type=Path, required=True)
    parser.add_argument('--suite', choices=['development', 'holdout', 'all'], default='development')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'freeze':
            freeze(args.author_run)
        elif args.output is None:
            raise ValueError('--output is required for run/score')
        elif args.command == 'run':
            run_suite(args.author_run, args.suite, args.output)
        else:
            score_suite(args.author_run, args.output)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, f'FAIL: {error}\n')


if __name__ == '__main__':
    main()
