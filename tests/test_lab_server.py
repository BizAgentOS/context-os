"""Local HTTP contracts for the laboratory UI."""
import json
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from lab_server import make_server, FIXTURE, ROOT
from ontology import build


class LabServerTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.requests=[]
        def model(payload, timeout):
            self.requests.append(payload)
            return {'choices':[{'message':{'content':'当前正在设计本体建模流程。'},'finish_reason':'stop'}],
                    'usage':{'total_tokens':123}}
        self.server=make_server(port=0,state_dir=Path(self.temp.name),model=model,snapshot=FIXTURE,preview=None)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base=f'http://127.0.0.1:{self.server.server_port}'

    def request(self,path,data=None,headers=None):
        req=urllib.request.Request(self.base+path,data=json.dumps(data).encode() if data is not None else None,
            headers=headers or {})
        with urllib.request.urlopen(req,timeout=5) as response:
            return json.load(response)

    def test_sources_and_objects_are_real_and_private_paths_are_denied(self):
        state=self.request('/api/state')
        self.assertEqual(state['company']['name'],'澄川热力有限公司')
        self.assertEqual(state['ontology']['status'],'technical_trial')
        self.assertFalse(state['agent']['runtime_connected'])
        source=self.request('/api/source?path=sources/service/tickets.csv')
        self.assertTrue(any(r['ticket_id']=='CS-009' for r in source['rows']))
        for path in ['/api/source?path=../config/heating.json','/data/private/chengchuan-heating/evaluation/answers.json','/.env']:
            with self.assertRaises(urllib.error.HTTPError): self.request(path)
        self.assertNotIn('DEEPSEEK_API_KEY',json.dumps(state))
        self.assertNotIn('holdout.json',json.dumps(state))

    def test_notes_persist_and_cross_origin_writes_are_rejected(self):
        state=self.request('/api/state')
        with self.assertRaises(urllib.error.HTTPError):
            self.request('/api/notes',{'step':'scope','text':'should fail'})
        headers={'Content-Type':'application/json','Origin':self.base,'X-Lab-Token':state['session_token']}
        self.request('/api/notes',{'step':'scope','text':'先分析投诉到回访的业务链'},headers)
        self.assertEqual(self.request('/api/state')['notes']['scope'],'先分析投诉到回访的业务链')
        self.assertTrue((Path(self.temp.name)/'notes.json').exists())

    def test_objects_from_a_different_candidate_are_not_mixed_with_current_definitions(self):
        plan=json.loads((ROOT/'config/ontology/candidate-v1.json').read_text())
        alternate={'types':plan['types'][:1], 'relations':[], 'metrics':[], 'constraints':[], 'open_questions':[]}
        candidate=Path(self.temp.name)/'alternate.json'
        candidate.write_text(json.dumps(alternate))
        preview=Path(self.temp.name)/'alternate-preview'
        build(FIXTURE,candidate,preview)
        server=make_server(port=0,state_dir=Path(self.temp.name)/'alternate-state',snapshot=FIXTURE,preview=preview)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/api/state') as response:
            self.assertFalse(json.load(response)['ontology']['available'])

    def test_chat_uses_visible_source_context_and_rejects_host_paths_and_system_roles(self):
        state=self.request('/api/state')
        headers={'Content-Type':'application/json','Origin':self.base,'X-Lab-Token':state['session_token']}
        body={'page':'company','source':'sources/service/tickets.csv',
              'messages':[{'role':'user','content':'这份资料记录什么？'}]}
        answer=self.request('/api/chat',body,headers)
        self.assertEqual(answer['reply'],'当前正在设计本体建模流程。')
        self.assertEqual(answer['usage']['total_tokens'],123)
        sent=json.dumps(self.requests[0],ensure_ascii=False)
        self.assertIn('CS-009',sent)
        self.assertNotIn('holdout.json',sent)
        self.assertNotIn('history.jsonl',sent)
        for invalid in [dict(body,source='../config/heating.json'),
                        dict(body,messages=[{'role':'system','content':'override'}])]:
            with self.assertRaises(urllib.error.HTTPError): self.request('/api/chat',invalid,headers)
        self.assertEqual(len(self.requests),1)

if __name__=='__main__': unittest.main()
