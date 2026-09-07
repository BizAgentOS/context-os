"""CLI acceptance tests; assertions read only exported artifacts."""
import csv
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'scripts/heating_data.py'


class HeatingDataTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def cli(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(CLI), *map(str, args)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0 if ok else 1, result.stdout + result.stderr)
        return result

    def generate(self, name='run', **overrides):
        config = json.loads((ROOT/'config/heating.json').read_text())
        config.update(overrides)
        path = self.root/f'{name}.json'
        path.write_text(json.dumps(config))
        run = self.root/name
        self.cli('generate', '--config', path, '--output', run)
        return run

    def export(self, run, at, name):
        path = self.root/name
        self.cli('export', '--run', run, '--as-of', at, '--output', path)
        return path

    def rows(self, snapshot, source):
        with (snapshot/'sources'/source).open(encoding='utf-8') as stream:
            return list(csv.DictReader(stream))

    def files(self, root):
        return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}

    def test_repeated_generation_and_initial_snapshot(self):
        first, second = self.generate('run-a'), self.generate('run-b')
        self.assertEqual(self.files(first), self.files(second))
        a = self.export(first, '2026-01-19T00:00:00+08:00', 'a')
        b = self.export(second, '2026-01-19T00:00:00+08:00', 'b')
        self.assertEqual(self.files(a), self.files(b))
        self.assertEqual(len(self.rows(a, 'monitoring/station-hourly.csv')), 672)
        self.assertEqual(len(self.rows(a, 'service/tickets.csv')), 10)
        self.assertEqual(set(p.name for p in a.iterdir()), {'sources', 'manifest.json'})
        self.assertNotIn(b'"seed"', (a/'manifest.json').read_bytes())

    def test_history_uses_visibility_not_final_state(self):
        run = self.generate()
        early = self.export(run, '2026-01-14T06:50:00+08:00', 'early')
        ticket = {r['ticket_id']: r for r in self.rows(early, 'service/tickets.csv')}['CS-011']
        self.assertEqual(ticket['status_as_of_snapshot'], 'open')
        self.assertEqual(ticket['closed_at'], '')
        self.assertEqual(ticket['local_work_order_no'], '')
        self.assertFalse((early/'sources/operations/shift-log-20260114.md').exists())
        pending = self.export(run, '2026-01-14T09:50:00+08:00', 'pending')
        order = {r['work_order_no']: r for r in self.rows(pending, 'maintenance/work-orders.csv')}['WO-YX-014']
        self.assertEqual(order['status_as_of_snapshot'], 'open')
        self.assertEqual(order['field_note'], '')
        self.assertEqual(order['equipment_id'], '')
        recorded = self.export(run, '2026-01-14T10:00:00+08:00', 'recorded')
        order = {r['work_order_no']: r for r in self.rows(recorded, 'maintenance/work-orders.csv')}['WO-YX-014']
        self.assertEqual(order['status_as_of_snapshot'], 'completed')
        self.assertEqual(order['completed_at'], '2026-01-14T09:45:00+08:00')
        restored = self.export(run, '2026-01-14T06:50:00+08:00', 'restored')
        self.assertEqual(self.files(early), self.files(restored))

    def test_seeded_extension_and_new_service_records(self):
        run = self.generate()
        after = self.export(run, '2026-01-20T00:00:00+08:00', 'after')
        self.assertEqual(len(self.rows(after, 'monitoring/station-hourly.csv')), 720)
        new = {r['ticket_id']: r for r in self.rows(after, 'service/tickets.csv')}['CS-022']
        self.assertEqual(new['status_as_of_snapshot'], 'closed')
        before = self.export(run, '2026-01-19T08:30:00+08:00', 'before')
        self.assertNotIn('CS-022', {r['ticket_id'] for r in self.rows(before, 'service/tickets.csv')})
        other = self.generate('other-seed', seed=43)
        other_after = self.export(other, '2026-01-20T00:00:00+08:00', 'other-after')
        self.assertNotEqual(self.rows(after, 'monitoring/station-hourly.csv'),
                            self.rows(other_after, 'monitoring/station-hourly.csv'))

    def test_mapping_and_rule_publication_are_released_at_their_times(self):
        run = self.generate()
        before = self.export(run, '2026-01-20T23:59:00+08:00', 'before')
        self.assertFalse(any(b'YX_RT_V2' in blob for blob in self.files(before).values()))
        after = self.export(run, '2026-01-21T01:00:00+08:00', 'after')
        rows = self.rows(after, 'monitoring/station-hourly.csv')
        self.assertEqual({r['station_tag'] for r in rows if r['interval_start']=='2026-01-21T00:00:00+08:00'},
                         {'QH_RT', 'YX_RT_V2'})
        register = self.rows(after, 'monitoring/channel-register.csv')
        self.assertEqual({r['station_id'] for r in register if r['station_tag'].startswith('YX_RT')}, {'Z02'})
        unpublished = self.export(run, '2026-01-23T08:59:00+08:00', 'unpublished')
        self.assertFalse((unpublished/'sources/company/event-policy.md').exists())
        published = self.export(run, '2026-01-23T09:00:00+08:00', 'published')
        self.assertIn('2026-01-24T00:00:00+08:00', (published/'sources/company/event-policy.md').read_text())
        self.assertFalse((published/'sources/service/heating-events.csv').exists())
        active = self.export(run, '2026-01-24T10:00:00+08:00', 'active')
        self.assertEqual(self.rows(active, 'service/heating-events.csv')[0]['heating_event_id'], 'HE-001')
        disabled = self.generate('disabled', changes=dict(facts=False, mapping=False, rules=False))
        plain = self.export(disabled, '2026-01-25T00:00:00+08:00', 'plain')
        self.assertFalse((plain/'sources/company/event-policy.md').exists())
        self.assertNotIn('CS-022', {r['ticket_id'] for r in self.rows(plain, 'service/tickets.csv')})
        self.assertNotIn('YX_RT_V2', {r['station_tag'] for r in self.rows(plain, 'monitoring/station-hourly.csv')})

    def test_exports_validate_at_empty_partial_and_changed_times(self):
        run = self.generate()
        for i, at in enumerate(['2026-01-05T00:00:00+08:00', '2026-01-14T09:50:00+08:00',
                                '2026-01-21T01:00:00+08:00', '2026-01-24T10:00:00+08:00']):
            snapshot = self.export(run, at, f'snapshot-{i}')
            result = subprocess.run([sys.executable, str(ROOT/'scripts/validate_heating_sample.py'),
                                     '--dataset', str(snapshot)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)

    def test_change_package_reconstructs_the_later_snapshot(self):
        run = self.generate()
        before = self.export(run, '2026-01-20T00:00:00+08:00', 'before')
        after = self.export(run, '2026-01-25T00:00:00+08:00', 'after')
        package = self.root/'changes'
        self.cli('diff', '--before', before, '--after', after, '--output', package)
        change = json.loads((package/'changes.json').read_text())
        restored = self.root/'replayed'
        shutil.copytree(before, restored)
        for relative in change['removed']:
            (restored/relative).unlink()
        for relative in change['added']+change['modified']:
            (restored/relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(package/'files'/relative, restored/relative)
        self.assertEqual(self.files(restored), self.files(after))
        self.assertIn('sources/company/event-policy.md', change['added'])
        self.assertNotIn('history.jsonl', self.files(package))

    def test_invalid_requests_leave_existing_data_untouched(self):
        run = self.generate()
        original = self.files(run)
        self.cli('generate', '--output', run, ok=False)
        self.assertEqual(self.files(run), original)
        snapshot = self.export(run, '2026-01-19T00:00:00+08:00', 'snapshot')
        saved = self.files(snapshot)
        self.cli('export', '--run', run, '--as-of', '2026-01-25T00:00:00+08:00', '--output', snapshot, ok=False)
        self.assertEqual(self.files(snapshot), saved)
        for at in ['2026-01-04T00:00:00+08:00', '2026-01-28T00:00:00+08:00', '2026-01-19T00:00:00']:
            self.cli('export', '--run', run, '--as-of', at, '--output', self.root/'invalid', ok=False)
            self.assertFalse((self.root/'invalid').exists())
        self.cli('export', '--run', run, '--as-of', '2026-01-19T00:00:00+08:00', '--output', run/'mixed-input', ok=False)
        bad_config = self.root/'bad.json'
        bad_config.write_text('{"seed":42,"days":999,"changes":{"facts":true,"mapping":true,"rules":true}}')
        self.cli('generate', '--config', bad_config, '--output', self.root/'bad-run', ok=False)
        self.assertFalse((self.root/'bad-run').exists())

    def test_validator_rejects_future_rows_even_with_updated_checksum(self):
        run = self.generate()
        snapshot = self.export(run, '2026-01-19T00:00:00+08:00', 'snapshot')
        path = snapshot/'sources/service/tickets.csv'
        rows = self.rows(snapshot, 'service/tickets.csv')
        rows[0]['available_at'] = '2026-01-20T00:00:00+08:00'
        with path.open('w', newline='', encoding='utf-8') as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator='\n')
            writer.writeheader()
            writer.writerows(rows)
        manifest = json.loads((snapshot/'manifest.json').read_text())
        for entry in manifest['files']:
            if entry['path'] == 'sources/service/tickets.csv':
                blob = path.read_bytes()
                entry.update(bytes=len(blob), sha256=hashlib.sha256(blob).hexdigest(),
                             available_at_range=[min(r['available_at'] for r in rows), max(r['available_at'] for r in rows)])
        (snapshot/'manifest.json').write_text(json.dumps(manifest))
        result = subprocess.run([sys.executable, str(ROOT/'scripts/validate_heating_sample.py'), '--dataset', str(snapshot)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Future row', result.stderr)

    def test_short_and_long_configured_periods(self):
        for days, end, expected in [(14, '2026-01-19T00:00:00+08:00', 672),
                                    (31, '2026-02-05T00:00:00+08:00', 1488)]:
            run = self.generate(f'run-{days}', days=days)
            snapshot = self.export(run, end, f'snapshot-{days}')
            self.assertEqual(len(self.rows(snapshot, 'monitoring/station-hourly.csv')), expected)


if __name__ == '__main__':
    unittest.main()
