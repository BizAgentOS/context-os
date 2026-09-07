#!/usr/bin/env python3
"""Propose an ontology from visible sources and materialize a reviewable object preview."""
import argparse
import csv
import hashlib
import io
import json
import re
import time
from pathlib import Path

from heating_data import new_directory
from raw_baseline import SourceTools, dump, request_model, sha
from validate_heating_sample import require, time as source_time

ROOT = Path(__file__).resolve().parents[1]


def propose(snapshot, output, model=request_model):
    # The model transport receives only this source bundle, never evaluator files.
    if output.exists():
        raise FileExistsError('Proposal output already exists')
    with SourceTools(snapshot) as tools:
        sources = []
        for entry in tools.manifest['files']:
            item = {k: entry[k] for k in ('path', 'source_id', 'format', 'sha256')}
            text = tools.texts[entry['path']]
            if entry['format'] == 'markdown':
                item['text'] = text
            else:
                rows = list(csv.DictReader(io.StringIO(text)))
                sample = rows if len(rows)<=30 else rows[:2]+[r for r in rows if r.get('quality')=='missing'][:1]
                item.update(columns=entry['columns'], primary_key=entry['primary_key'],
                            row_count=len(rows), rows=sample, sampled=len(sample)<len(rows))
            sources.append(item)
        bundle = dict(as_of=tools.manifest['as_of'], sources=sources)
    system = (ROOT/'config/ontology/extract-system.txt').read_text()
    payload = dict(model='deepseek-v4-flash', messages=[{'role':'system','content':system},
        {'role':'user','content':dump(bundle)}], response_format={'type':'json_object'},
        thinking={'type':'disabled'}, temperature=0, max_tokens=10000, stream=False)
    output.mkdir(parents=True, exist_ok=False)
    (output/'request.json').write_text(dump(payload), encoding='utf-8')
    record = dict(status='error', snapshot_manifest_sha256=sha(snapshot/'manifest.json'),
                  prompt_sha256=hashlib.sha256(system.encode()).hexdigest())
    started = time.monotonic()
    try:
        response = model(payload, 90)
        record['response'] = response
        choice = response['choices'][0]
        require(choice['finish_reason']=='stop', 'Incomplete model response')
        candidate = json.loads(choice['message']['content'])
        require(isinstance(candidate, dict), 'Expected a JSON object')
        (output/'candidate.json').write_text(dump(candidate), encoding='utf-8')
        record['status'] = 'proposed'
    except Exception as error:
        record['error_type'] = type(error).__name__
        raise
    finally:
        record['elapsed_seconds'] = round(time.monotonic()-started, 3)
        (output/'extraction.json').write_text(dump(record), encoding='utf-8')
    print(f'Proposed candidate: {output}; {record["elapsed_seconds"]} seconds')


def read_rows(tools, path):
    return list(csv.DictReader(io.StringIO(tools.texts[path])))


def evidence_valid(evidence, tools):
    require(isinstance(evidence, list) and evidence, 'Evidence is required')
    for item in evidence:
        require(isinstance(item.get('quote'), str) and len(item['quote'])>=6,
                'Evidence quote must contain at least 6 characters')
        require(item.get('path') in tools.texts and item['quote'] in tools.texts[item['path']],
                f'Quote absent from visible source: {item.get("path")}')


def validate_plan(plan, tools):
    require(set(plan)=={'types','relations','metrics','constraints','open_questions'}, 'Invalid candidate sections')
    require(0 < len(plan['types']) <= 10, 'Candidate must contain 1..10 types')
    catalog = {x['path']: x for x in tools.manifest['files']}
    types, used = {}, set()
    for kind in plan['types']:
        require(re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', kind['id']) is not None, 'Invalid type ID')
        require(kind['id'] not in types and kind['source'] not in used, 'Duplicate type/source')
        source = catalog.get(kind['source'])
        require(source is not None and source['format']=='csv', 'Type must use a visible CSV')
        require(kind['key']==source['primary_key'], 'Object key must be the source primary key')
        require(set(kind['numeric_fields']).issubset(source['columns']), 'Unknown numeric field')
        require(kind['key'] not in kind['numeric_fields'], 'IDs must remain strings')
        require(kind['name'] and kind['description'], 'Type needs a name and description')
        evidence_valid(kind['evidence'], tools)
        types[kind['id']] = kind
        used.add(kind['source'])
    ids = set()
    for relation in plan['relations']:
        require(re.fullmatch(r'[a-z][a-z0-9_]*',relation['id']) is not None and relation['id'] not in ids,
                'Duplicate or invalid relation ID')
        ids.add(relation['id'])
        require(relation['from_type'] in types and relation['to_type'] in types, 'Unknown relation type')
        left = catalog[types[relation['from_type']]['source']]['columns']
        right = catalog[types[relation['to_type']]['source']]['columns']
        require(relation['from_field'] in left, f'{relation["id"]}: missing from_field {relation["from_field"]}')
        require(relation['kind'] in {'foreign_key','lookup','address'}, 'Unsupported relation kind')
        if relation['kind'] in {'foreign_key','lookup'}:
            require(relation['to_field'] in right, f'{relation["id"]}: missing to_field')
        if relation['kind']=='lookup':
            source = catalog.get(relation['lookup_source'])
            require(source is not None and source['format']=='csv', 'Lookup requires visible CSV')
            require(relation['time_field'] in left, 'Lookup time field absent')
            require(all(relation[k] in source['columns'] for k in ['lookup_key','lookup_value','valid_from','valid_to']),
                    'Lookup column absent')
        if relation['kind']=='address':
            require(relation['to_name_field'] in right and relation['to_number_field'] in right, 'Address target column absent')
            require(isinstance(relation['aliases'],dict) and all(isinstance(k,str) and isinstance(v,str)
                    and k and v for k,v in relation['aliases'].items()), 'Invalid address aliases')
        require(relation['description'] and relation['name'], 'Relation needs business meaning')
        evidence_valid(relation['evidence'], tools)
    metric_ids=set()
    for metric in plan['metrics']:
        require(metric['id'] not in metric_ids, 'Duplicate metric ID')
        metric_ids.add(metric['id'])
        require(all(isinstance(metric.get(k),str) and metric[k] for k in
                    ['id','name','definition','population','numerator','denominator','empty_result']), 'Incomplete metric')
        evidence_valid(metric['evidence'], tools)
    for constraint in plan['constraints']:
        require(bool(constraint['description']), 'Empty constraint')
        evidence_valid(constraint['evidence'], tools)
    require(all(isinstance(x,str) for x in plan['open_questions']), 'Invalid open questions')
    return types


def reference(tools, source, row):
    meta = next(x for x in tools.manifest['files'] if x['path']==source)
    return dict(path=source, source_id=meta['source_id'], source_sha256=meta['sha256'],
                primary_key=meta['primary_key'], record_id=row[meta['primary_key']])


def match_relation(relation, row, targets, tools):
    value=row[relation['from_field']]
    evidence=[]
    if relation['kind']=='foreign_key':
        return [r for r in targets if r[relation['to_field']]==value], evidence, 'no_match'
    if relation['kind']=='address':
        match=re.match(r'^(.+?)([0-9]+)(?:号楼|栋)',value.strip())
        if not match:
            return [],evidence,'unparsed_address'
        name,number=match.groups()
        name=relation['aliases'].get(name.strip(),name.strip())
        matches=[r for r in targets if r[relation['to_name_field']]==name
                 and r[relation['to_number_field']].isdigit()
                 and int(r[relation['to_number_field']])==int(number)]
    else:
        at=source_time(row[relation['time_field']])
        lookup=[r for r in read_rows(tools,relation['lookup_source'])
                if r[relation['lookup_key']]==value
                and source_time(r[relation['valid_from']])<=at
                and (not r[relation['valid_to']] or at<source_time(r[relation['valid_to']]))]
        if len(lookup)!=1:
            return [],evidence,'ambiguous_lookup' if lookup else 'no_effective_lookup'
        evidence=[reference(tools,relation['lookup_source'],lookup[0])]
        matches=[r for r in targets if r[relation['to_field']]==lookup[0][relation['lookup_value']]]
    if len(matches)>1:
        return [],evidence,'ambiguous_target'
    return matches,evidence,'no_match'


def build(snapshot, candidate_path, output, approval=None):
    import math
    import shutil
    decision=None
    if approval is not None:
        decision=json.loads(approval.read_text())
        require(decision.get('decision')=='approved' and decision.get('candidate_sha256')==sha(candidate_path)
                and decision.get('snapshot_manifest_sha256')==sha(snapshot/'manifest.json'), 'Approval does not match candidate/snapshot')
        require(bool(decision.get('reviewer')) and bool(decision.get('statement')), 'Approval needs reviewer and statement')
    status='confirmed' if decision else 'pending_confirmation'
    plan = json.loads(candidate_path.read_text())
    with SourceTools(snapshot) as tools:
        types = validate_plan(plan, tools)
        rows = {name: read_rows(tools, kind['source']) for name,kind in types.items()}
        objects, edges, unmatched = [], [], []
        ontology_types=[]
        for name,kind in types.items():
            meta = next(x for x in tools.manifest['files'] if x['path']==kind['source'])
            properties = {column: dict(value_type='number' if column in kind['numeric_fields'] else 'string',
                unit=kind['numeric_fields'].get(column), nullable=column!=kind['key']) for column in meta['columns']}
            ontology_types.append({k: kind[k] for k in ['id','name','description','evidence']})
            ontology_types[-1]['properties']=properties
            for row in rows[name]:
                attributes = {k: v if v!='' else None for k,v in row.items()}
                for column in kind['numeric_fields']:
                    if row[column]!='':
                        number=float(row[column])
                        require(math.isfinite(number), 'Nonfinite numeric value')
                        attributes[column]=number
                objects.append(dict(id=f'{name}:{row[kind["key"]]}', type=name,
                    attributes=attributes, source=reference(tools,kind['source'],row)))
        by_id={x['id']:x for x in objects}
        for relation in plan['relations']:
            left_type, right_type = relation['from_type'],relation['to_type']
            for row in rows[left_type]:
                value=row[relation['from_field']]
                if value=='':
                    continue
                matches,lookup_evidence,reason=match_relation(relation,row,rows[right_type],tools)
                left_id=f'{left_type}:{row[types[left_type]["key"]]}'
                if not matches:
                    unmatched.append(dict(object_id=left_id, relation=relation['id'], reason=reason, value=value))
                for target in matches:
                    right_id=f'{right_type}:{target[types[right_type]["key"]]}'
                    edges.append(dict(id=f'{relation["id"]}:{left_id}>{right_id}', relation=relation['id'],
                        **{'from':left_id,'to':right_id}, evidence=[by_id[left_id]['source'],by_id[right_id]['source']]+lookup_evidence,
                        rule_evidence=relation['evidence']))
        ontology=dict(version='v1' if decision else 'v1-candidate',status=status,types=ontology_types,
            metrics=plan['metrics'],constraints=plan['constraints'],open_questions=plan['open_questions'])
        mapping=dict(version='m1' if decision else 'm1-candidate',status=status,types=[{k:v for k,v in t.items()
            if k in {'id','source','key','numeric_fields','evidence'}} for t in plan['types']], relations=plan['relations'])
        with new_directory(output) as stage:
            (stage/'snapshot').mkdir()
            shutil.copyfile(snapshot/'manifest.json',stage/'snapshot/manifest.json')
            for entry in tools.manifest['files']:
                target=stage/'snapshot'/entry['path']
                target.parent.mkdir(parents=True,exist_ok=True)
                # Copy only the source bytes read by the validated in-memory view.
                target.write_text(tools.texts[entry['path']],encoding='utf-8')
                require(sha(target)==entry['sha256'],'Source byte representation changed')
            for name,value in [('ontology.json',ontology),('mapping.json',mapping),
                               ('objects.json',dict(objects=objects,relations=edges,unmatched=unmatched))]:
                (stage/name).write_text(dump(value),encoding='utf-8')
            if decision:
                (stage/'approval.json').write_text(dump(decision),encoding='utf-8')
            files={str(p.relative_to(stage)):sha(p) for p in stage.rglob('*') if p.is_file()}
            store=dict(status=status,as_of=tools.manifest['as_of'],ontology_version=ontology['version'],
                mapping_version=mapping['version'],candidate_sha256=sha(candidate_path),
                snapshot_manifest_sha256=sha(snapshot/'manifest.json'),files=files,
                object_count=len(objects),relation_count=len(edges),unmatched_count=len(unmatched))
            (stage/'store.json').write_text(dump(store),encoding='utf-8')
    print(f'Built preview: {len(objects)} objects, {len(edges)} relations, {len(unmatched)} unmatched references')


class ObjectStore:
    def __init__(self, root):
        self.root=Path(root)
        require(not any(p.is_symlink() for p in self.root.rglob('*')),'Store symlinks are not allowed')
        self.meta=json.loads((self.root/'store.json').read_text())
        actual={str(p.relative_to(self.root)) for p in self.root.rglob('*') if p.is_file() and p!=self.root/'store.json'}
        require(actual==set(self.meta['files']),'Store file inventory mismatch')
        for relative, expected in self.meta['files'].items():
            path=Path(relative)
            require(not path.is_absolute() and '..' not in path.parts and not (self.root/path).is_symlink(), 'Invalid store path')
            require(sha(self.root/path)==expected,'Store checksum mismatch')
        self.sources={x['path']:x for x in json.loads((self.root/'snapshot/manifest.json').read_text())['files']}
        graph=json.loads((self.root/'objects.json').read_text())
        self.objects={x['id']:x for x in graph['objects']}
        self.relations=graph['relations']

    def get(self, object_id):
        require(object_id in self.objects, 'Object not found')
        return dict(object=self.objects[object_id],outgoing=[e for e in self.relations if e['from']==object_id],
            incoming=[e for e in self.relations if e['to']==object_id],status=self.meta['status'],
            as_of=self.meta['as_of'],ontology_version=self.meta['ontology_version'],mapping_version=self.meta['mapping_version'])

    def evidence(self, object_id):
        obj=self.get(object_id)['object']
        ref=obj['source']
        require(ref['path'] in self.sources and ref['source_sha256']==self.sources[ref['path']]['sha256'], 'Evidence not in snapshot')
        relative=Path(ref['path'])
        require(not relative.is_absolute() and '..' not in relative.parts and relative.parts[0]=='sources','Invalid evidence path')
        path=self.root/'snapshot'/relative
        require(sha(path)==ref['source_sha256'],'Source changed since object build')
        with path.open(encoding='utf-8') as stream:
            row=next(r for r in csv.DictReader(stream) if r[ref['primary_key']]==ref['record_id'])
        return dict(object_id=object_id,rows=[dict(reference=ref,record=row)],
                    relations=self.get(object_id)['outgoing']+self.get(object_id)['incoming'])

    def __enter__(self):
        return self

    def __exit__(self,*args):
        pass


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    proposal=sub.add_parser('propose')
    proposal.add_argument('--snapshot',type=Path,required=True)
    proposal.add_argument('--output',type=Path,required=True)
    materialize=sub.add_parser('build')
    materialize.add_argument('--snapshot',type=Path,required=True)
    materialize.add_argument('--candidate',type=Path,required=True)
    materialize.add_argument('--output',type=Path,required=True)
    materialize.add_argument('--approval',type=Path)
    for name in ['get','evidence']:
        read=sub.add_parser(name)
        read.add_argument('--store',type=Path,required=True)
        read.add_argument('--id',required=True)
    args=parser.parse_args()
    try:
        if args.command=='propose':
            propose(args.snapshot,args.output)
        elif args.command=='build':
            build(args.snapshot,args.candidate,args.output,approval=args.approval)
        else:
            with ObjectStore(args.store) as store:
                print(dump(store.get(args.id) if args.command=='get' else store.evidence(args.id)))
    except (ValueError,OSError,KeyError,TypeError) as error:
        parser.exit(1,f'FAIL: {error}\n')


if __name__=='__main__':
    main()
