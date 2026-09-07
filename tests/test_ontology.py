"""Public proposal/build/object-read acceptance tests."""
import hashlib
import json
import subprocess
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from ontology import propose, build, ObjectStore

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT/'data/samples/chengchuan-heating'


class OntologyTest(unittest.TestCase):
    def test_proposal_sees_only_source_bundle_and_preserves_model_origin(self):
        captured = []
        def model(payload, timeout):
            captured.append(payload)
            return {'model': 'test-fixture', 'choices': [{'finish_reason': 'stop', 'message': {
                'content': json.dumps({'types': [], 'relations': [], 'metrics': [], 'constraints': [], 'open_questions': []})}}],
                'usage': {'prompt_tokens': 100, 'completion_tokens': 10}}
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)/'proposal'
            propose(SAMPLE, output, model=model)
            source = json.loads(captured[0]['messages'][1]['content'])
            self.assertEqual(source['as_of'], '2026-01-19T00:00:00+08:00')
            self.assertEqual(len(source['sources']), 17)
            text = json.dumps(source)
            for forbidden in ['answers.json', 'holdout', 'data/private', 'history.jsonl', 'reviewer-notes', 'event-policy.md']:
                self.assertNotIn(forbidden, text)
            self.assertIn('文苑一期', json.dumps(source, ensure_ascii=False))
            record = json.loads((output/'extraction.json').read_text())
            self.assertEqual(record['response']['usage']['prompt_tokens'], 100)
            self.assertEqual(record['status'], 'proposed')
            self.assertTrue((output/'candidate.json').exists())
            with self.assertRaises(FileExistsError):
                propose(SAMPLE, output, model=model)

    def test_build_persists_typed_objects_relations_and_exact_source_evidence(self):
        plan = minimal_plan()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            candidate = root/'candidate.json'
            candidate.write_text(json.dumps(plan))
            build(SAMPLE, candidate, root/'store')
            with ObjectStore(root/'store') as store:
                obj = store.get('Building:WY-01')
                self.assertEqual(obj['object']['attributes']['supplied_area_m2'], 10000)
                self.assertEqual(obj['outgoing'][0]['to'], 'Station:Z02')
                self.assertEqual(obj['status'], 'pending_confirmation')
                evidence = store.evidence('Building:WY-01')
                self.assertEqual(evidence['rows'][0]['record']['community_name'], '文苑小区')
                self.assertEqual(evidence['rows'][0]['record']['building_id'], 'WY-01')
                self.assertIn('source_sha256', evidence['rows'][0]['reference'])
            with ObjectStore(root/'store') as reopened:
                self.assertEqual(reopened.get('Building:WY-01'), obj)
            build(SAMPLE, candidate, root/'second')
            self.assertEqual((root/'store/objects.json').read_bytes(), (root/'second/objects.json').read_bytes())

    def test_address_and_temporal_lookup_keep_identity_and_missing_values(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            run=root/'run'
            subprocess.run([sys.executable,str(ROOT/'scripts/heating_data.py'),'generate','--output',str(run)],check=True,capture_output=True)
            plan=minimal_plan()
            for name,source,key,numeric in [
                ('Ticket','sources/service/tickets.csv','ticket_id',{}),
                ('Observation','sources/monitoring/station-hourly.csv','observation_id',{'interval_heat_gj':'GJ'})]:
                header=(SAMPLE/source).read_text().splitlines()[0]
                plan['types'].append(dict(id=name,name=name,source=source,key=key,description=name,
                    numeric_fields=numeric,evidence=[dict(path=source,quote=header)]))
            plan['relations'] += [
                dict(id='ticket_building',name='地址楼栋',kind='address',from_type='Ticket',to_type='Building',
                    from_field='customer_address',to_name_field='community_name',to_number_field='building_number',
                    aliases={'文苑一期':'文苑小区','文苑':'文苑小区','新桥花园':'新桥小区','柳岸':'柳岸小区','松园':'松园小区'},
                    description='以物业别称和楼号联系楼栋', evidence=[dict(path='sources/service/address-book-note.md',quote='柳岸、松园沿用小区简称。')]),
                dict(id='observation_station',name='监测站点',kind='lookup',from_type='Observation',to_type='Station',
                    from_field='station_tag',to_field='station_id',lookup_source='sources/monitoring/channel-register.csv',
                    lookup_key='station_tag',lookup_value='station_id',time_field='interval_start',
                    valid_from='valid_from',valid_to='valid_to',description='登记表按有效时间联系站点',
                    evidence=[dict(path='sources/monitoring/channel-register.csv',quote='station_tag,station_id,valid_from,valid_to')])]
            candidate=root/'candidate.json';candidate.write_text(json.dumps(plan))
            for day in [19,22]:
                snapshot=root/f'snapshot-{day}'
                subprocess.run([sys.executable,str(ROOT/'scripts/heating_data.py'),'export','--run',str(run),
                    '--as-of',f'2026-01-{day}T00:00:00+08:00','--output',str(snapshot)],check=True,capture_output=True)
                build(snapshot,candidate,root/f'store-{day}')
            with ObjectStore(root/'store-19') as store:
                self.assertEqual(store.get('Ticket:CS-009')['outgoing'][0]['to'],'Building:SY-03')
                self.assertNotEqual(store.get('Ticket:CS-011')['object']['id'],store.get('Ticket:CS-014')['object']['id'])
                self.assertEqual(store.get('Ticket:CS-011')['outgoing'][0]['to'],store.get('Ticket:CS-014')['outgoing'][0]['to'])
                self.assertIsNone(store.get('Observation:OBS-QH_RT-2026011013')['object']['attributes']['interval_heat_gj'])
            with ObjectStore(root/'store-22') as store:
                new=store.get('Observation:OBS-YX_RT_V2-2026012100')
                self.assertEqual(new['outgoing'][0]['to'],'Station:Z02')
                self.assertEqual(len(new['outgoing'][0]['evidence']),3)
                self.assertEqual(store.get('Observation:OBS-YX_RT-2026012000')['outgoing'][0]['to'],'Station:Z02')

    def test_invalid_candidates_and_tampered_store_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for name,mutate in [
                ('field',lambda p: p['relations'][0].update(from_field='nonexistent')),
                ('quote',lambda p: p['types'][0]['evidence'][0].update(quote='Invented source quote')),
                ('future',lambda p: p['types'][0].update(source='sources/service/heating-events.csv'))]:
                plan=minimal_plan();mutate(plan)
                file=root/f'{name}.json';file.write_text(json.dumps(plan))
                with self.assertRaises(ValueError): build(SAMPLE,file,root/name)
                self.assertFalse((root/name).exists())
            snapshot=root/'snapshot';shutil.copytree(SAMPLE,snapshot)
            (snapshot/'private-note.txt').write_text('SECRET_ADJACENT_DATA')
            file=root/'valid.json';file.write_text(json.dumps(minimal_plan()))
            build(snapshot,file,root/'store')
            self.assertFalse((root/'store/snapshot/private-note.txt').exists())
            self.assertFalse((root/'store/snapshot/README.md').exists())
            (root/'store/objects.json').write_text('{"tampered":true}')
            with self.assertRaises(ValueError): ObjectStore(root/'store')

    def test_confirmation_is_bound_to_exact_candidate_and_keeps_preview(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            file=root/'candidate.json';file.write_text(json.dumps(minimal_plan()))
            build(SAMPLE,file,root/'preview')
            approval=root/'approval.json'
            approval.write_text(json.dumps({'decision':'approved','candidate_sha256':'wrong',
                'reviewer':'test fixture','statement':'Fixture approval only',
                'snapshot_manifest_sha256':hashlib.sha256((SAMPLE/'manifest.json').read_bytes()).hexdigest()}))
            with self.assertRaises(ValueError): build(SAMPLE,file,root/'wrong',approval=approval)
            approval.write_text(json.dumps({'decision':'approved',
                'candidate_sha256':hashlib.sha256(file.read_bytes()).hexdigest(),
                'reviewer':'test fixture','statement':'Fixture approval only',
                'snapshot_manifest_sha256':hashlib.sha256((SAMPLE/'manifest.json').read_bytes()).hexdigest()}))
            build(SAMPLE,file,root/'confirmed',approval=approval)
            with ObjectStore(root/'confirmed') as store:
                self.assertEqual(store.get('Building:WY-01')['status'],'confirmed')
                self.assertEqual(store.get('Building:WY-01')['ontology_version'],'v1')
            with ObjectStore(root/'preview') as store:
                self.assertEqual(store.get('Building:WY-01')['status'],'pending_confirmation')


def minimal_plan():
    return {'types': [
        {'id': 'Station', 'name': '站点', 'source': 'sources/assets/stations.csv', 'key': 'station_id',
         'description': '设施站点', 'numeric_fields': {'service_area_m2': 'm²'},
         'evidence': [{'path': 'sources/assets/stations.csv', 'quote': 'station_id,station_name,address'}]},
        {'id': 'Building', 'name': '楼栋', 'source': 'sources/assets/buildings.csv', 'key': 'building_id',
         'description': '服务楼栋', 'numeric_fields': {'supplied_area_m2': 'm²', 'contract_households': 'count'},
         'evidence': [{'path': 'sources/assets/buildings.csv', 'quote': 'building_id,community_name,building_number,station_id'}]}
    ], 'relations': [{'id': 'building_station', 'name': '楼栋由站点服务', 'kind': 'foreign_key',
        'from_type': 'Building', 'to_type': 'Station', 'from_field': 'station_id', 'to_field': 'station_id',
        'description': '楼栋台账的服务站点引用',
        'evidence': [{'path': 'sources/assets/buildings.csv', 'quote': 'building_id,community_name,building_number,station_id'}]}],
        'metrics': [], 'constraints': [], 'open_questions': []}

if __name__ == '__main__':
    unittest.main()
