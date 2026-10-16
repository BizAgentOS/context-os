#!/usr/bin/env python3
"""Check the Starbridge demo sample and rewrite its manifest.

The sample is built for a demo video: three systems (HR, tracker, wiki) name the
same people differently, with a few deliberate conflicts. This script checks that
references resolve and that each planted conflict is still present, so edits to
the data do not silently remove the story.
"""
import csv
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'data' / 'samples' / 'starbridge-demo'
PRIMARY_KEYS = {
    'hr/people.csv': 'employee_no', 'hr/teams.csv': 'team_id',
    'tracker/users.csv': 'username', 'tracker/products.csv': 'product_key',
    'tracker/projects.csv': 'project_key', 'tracker/releases.csv': 'release_key',
    'tracker/requirements.csv': 'requirement_key', 'tracker/tasks.csv': 'task_key',
}
OWNERS = {'hr': 'StarHR', 'tracker': 'StarTrack', 'wiki': 'StarWiki'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def rows(base, name):
    with (base / name).open(encoding='utf-8', newline='') as handle:
        data = list(csv.DictReader(handle))
    key = PRIMARY_KEYS[name]
    keys = [row[key] for row in data]
    require(len(keys) == len(set(keys)) and all(keys), f'{name}: {key} must be unique and non-empty')
    return {row[key]: row for row in data}


def check_tracker(people, teams, tracker):
    users, products, projects = tracker['users'], tracker['products'], tracker['projects']
    releases, requirements, tasks = tracker['releases'], tracker['requirements'], tracker['tasks']
    for team in teams.values():
        require(team['lead_employee_no'] in people, f"team {team['team_id']}: unknown lead")
        require(not team['parent_team_id'] or team['parent_team_id'] in teams, f"team {team['team_id']}: unknown parent")
    for person in people.values():
        require(person['team_id'] in teams, f"{person['employee_no']}: unknown team")
        require(not person['manager_employee_no'] or person['manager_employee_no'] in people, f"{person['employee_no']}: unknown manager")
    for row in products.values():
        require(row['owner_username'] in users, f"{row['product_key']}: unknown owner")
    for row in projects.values():
        require(row['product_key'] in products, f"{row['project_key']}: unknown product")
        require({row['project_manager'], row['engineering_lead']} <= users.keys(), f"{row['project_key']}: unknown user")
    for row in releases.values():
        require(row['product_key'] in products and row['release_manager'] in users, f"{row['release_key']}: bad reference")
        require(not row['project_key'] or row['project_key'] in projects, f"{row['release_key']}: unknown project")
    for row in requirements.values():
        require(row['target_release'] in releases and row['owner_username'] in users, f"{row['requirement_key']}: bad reference")
        require(row['project_key'] in projects and row['product_key'] in products, f"{row['requirement_key']}: bad reference")
    for row in tasks.values():
        require(row['requirement_key'] in requirements and row['assignee'] in users, f"{row['task_key']}: bad reference")
        require(not row['blocked_by'] or row['blocked_by'] in tasks, f"{row['task_key']}: unknown blocker")


def check_story(people, users, tracker, wiki):
    """The planted conflicts the demo relies on."""
    hr_emails = {p['email'] for p in people.values()}
    unmatched = sorted(u for u, row in users.items() if row['email'] not in hr_emails)
    require(unmatched == ['chen.wang', 'ci-bot'], f'expected only chen.wang and ci-bot to miss an HR email, got {unmatched}')
    require('wangchen@workflowx.example' in wiki['legacy-template-requirement.md'], 'legacy doc must explain the old account email')
    require(not any('username' in column for column in next(iter(people.values()))), 'HR must not carry tracker usernames')
    owner = tracker['requirements']['FP-REQ-3203']['owner_username']
    departed = people[next(p for p, row in people.items() if row['email'] == users[owner]['email'])]
    require(departed['status'] == 'left', 'FP-REQ-3203 owner must have left in HR')
    require(tracker['products']['FLOWPILOT']['owner_username'] == 'lin.yue' and '移交给陈曦' in wiki['flowpilot-owner-handover.md'],
            'FlowPilot owner field must be stale against the handover')
    require(tracker['requirements']['FP-REQ-3204']['target_release'] == 'FP-3.3' and '移动端审批' in wiki['roadmap-2026-h1.md'],
            'mobile approval must have moved out of 3.2 while the roadmap still lists it')
    require(tracker['tasks']['FP-TASK-3203']['blocked_by'] == 'FP-TASK-3204', 'security review must be blocked by the IdP sandbox')
    require('王工' in wiki['delivery-meeting-2026-08-28.md'], 'meeting note must use the 王工 alias')


def file_entry(path, base, source_id):
    content = path.read_bytes()
    entry = {'path': path.relative_to(base).as_posix(), 'source_system': OWNERS[path.relative_to(base).parts[-2]],
             'source_id': source_id, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
    if path.suffix == '.csv':
        name = '/'.join(path.parts[-2:])
        data = rows(path.parent.parent, name)
        entry.update(format='csv', primary_key=PRIMARY_KEYS[name], records=len(data),
                     columns=list(next(iter(data.values())).keys()))
    else:
        entry['format'] = 'markdown'
        entry['document_id'] = re.search(r'^document_id: (\S+)$', content.decode('utf-8'), re.M).group(1)
    return entry


def load(base):
    people = rows(base, 'hr/people.csv')
    teams = rows(base, 'hr/teams.csv')
    tracker = {name: rows(base, f'tracker/{name}.csv') for name in
               ['users', 'products', 'projects', 'releases', 'requirements', 'tasks']}
    return people, teams, tracker


def main():
    sources = ROOT / 'sources'
    people, teams, tracker = load(sources)
    check_tracker(people, teams, tracker)
    wiki = {p.name: p.read_text(encoding='utf-8') for p in sorted((sources / 'wiki').glob('*.md'))}
    check_story(people, tracker['users'], tracker, wiki)

    update = ROOT / 'updates' / '2026-09-03' / 'tracker'
    updated = dict(tracker, **{name: rows(update.parent, f'tracker/{name}.csv') for name in ['releases', 'tasks']})
    check_tracker(people, teams, updated)
    require(updated['releases']['FP-3.2']['forecast_date'] == '2026-10-08', 'update must move the FP-3.2 forecast')
    require(updated['tasks']['FP-TASK-3204']['status'] == 'done' and not updated['tasks']['FP-TASK-3203']['blocked_by'],
            'update must clear the security review blocker')

    files = [file_entry(p, ROOT, f"SRC-{p.parts[-2].upper()}-{p.stem.upper()}")
             for p in sorted(sources.rglob('*')) if p.is_file()]
    updates = [file_entry(p, ROOT, f"SRC-{p.parts[-2].upper()}-{p.stem.upper()}")
               for p in sorted((ROOT / 'updates').rglob('*')) if p.is_file()]
    manifest = {
        'dataset_version': 'starbridge-demo-v1', 'fictional': True, 'timezone': 'Asia/Shanghai',
        'as_of': '2026-08-30T09:00:00+08:00', 'source_root': 'sources', 'files': files,
        'updates': [{'as_of': '2026-09-03T18:00:00+08:00', 'replaces': 'sources/tracker', 'files': updates}],
    }
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    records = sum(f.get('records', 0) for f in files)
    print(f'OK: {len(files)} source files ({records} records), {len(updates)} update files; manifest written')


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(f'FAILED: {error}', file=sys.stderr)
        sys.exit(1)
