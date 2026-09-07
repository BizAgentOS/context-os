#!/usr/bin/env python3
"""Generate an author-side heating run and export visible source snapshots."""
import argparse
import csv
import hashlib
import io
import json
import random
import shutil
import tempfile
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path

from validate_heating_sample import require, time, validate

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / 'data/samples/chengchuan-heating'
START = time('2026-01-05T00:00:00+08:00')
MAPPING_AT = '2026-01-21T00:00:00+08:00'


def json_text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n'


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def source_path(value):
    path = Path(value)
    require(not path.is_absolute() and '..' not in path.parts and len(path.parts) > 1
            and path.parts[0] == 'sources', f'Invalid source path: {value}')
    return path


@contextmanager
def new_directory(output):
    require(not output.exists() and not output.is_symlink(), f'Output already exists: {output}')
    require(not output.resolve().is_relative_to(SAMPLE.resolve()), 'Output cannot be inside the fixed sample')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.heating-', dir=output.parent) as temp:
        stage = Path(temp)/'payload'
        stage.mkdir()
        yield stage
        require(not output.exists() and not output.is_symlink(), f'Output already exists: {output}')
        stage.rename(output)


def load_config(path):
    config = json.loads(path.read_text(encoding='utf-8'))
    require(isinstance(config, dict), 'Config must be an object')
    require(set(config) == {'seed', 'days', 'changes'}, 'Config requires seed, days and changes')
    require(type(config['seed']) is int, 'seed must be an integer')
    require(type(config['days']) is int and 14 <= config['days'] <= 31, 'days must be 14..31')
    require(isinstance(config['changes'], dict), 'changes must be an object')
    require(set(config['changes']) == {'facts', 'mapping', 'rules'}, 'Unknown change switches')
    require(all(type(v) is bool for v in config['changes'].values()), 'Change switches must be booleans')
    return config


def base_history():
    manifest = json.loads((SAMPLE/'manifest.json').read_text(encoding='utf-8'))
    catalog, events = {}, []
    for entry in manifest['files']:
        path = entry['path']
        blob = (SAMPLE/source_path(path)).read_bytes()
        require(digest(blob) == entry['sha256'], f'Fixed sample changed: {path}')
        catalog[path] = {k: v for k, v in entry.items()
                         if k in {'source_id', 'format', 'owner', 'columns', 'primary_key', 'time_columns'}}
        if entry['format'] == 'markdown':
            events.append(dict(path=path, key='', at=entry['available_at'], value=blob.decode('utf-8')))
        else:
            for row in csv.DictReader(io.StringIO(blob.decode('utf-8'))):
                events.append(dict(path=path, key=row[entry['primary_key']], at=row['available_at'], value=row))
    return catalog, events


def add_lifecycle_history(events):
    """Construct explicit experimental creation/dispatch versions from fixed end states."""
    ticket_path = 'sources/service/tickets.csv'
    order_path = 'sources/maintenance/work-orders.csv'
    orders = {e['key']: e['value'] for e in events if e['path'] == order_path}
    for event in list(events):
        if event['path'] not in {ticket_path, order_path}:
            continue
        final = event['value']
        if final['available_at'] == final['opened_at']:
            continue
        initial = dict(final, available_at=final['opened_at'], status_as_of_snapshot='open')
        if event['path'] == order_path:
            initial.update(completed_at='', field_note='', equipment_id='')
        else:
            initial.update(closed_at='', local_work_order_no='')
        events.append(dict(event, at=initial['available_at'], value=initial))
        if event['path'] == ticket_path and final['local_work_order_no']:
            assigned_at = max(time(final['opened_at']), time(orders[final['local_work_order_no']]['opened_at']))
            require(assigned_at <= time(final['available_at']), 'Assignment occurs after final ticket version')
            assigned = dict(initial, local_work_order_no=final['local_work_order_no'], available_at=assigned_at.isoformat())
            if assigned_at < time(final['available_at']):
                events.append(dict(event, at=assigned['available_at'], value=assigned))


def add_row(catalog, events, path, row):
    events.append(dict(path=path, key=row[catalog[path]['primary_key']], at=row['available_at'], value=row))


def extend_monitoring(catalog, events, config):
    rng = random.Random(config['seed'])
    for day in range(14, config['days']):
        date = START + timedelta(days=day)
        outdoor = round(rng.uniform(-8, -1), 2)
        add_row(catalog, events, 'sources/monitoring/weather-daily.csv', dict(
            observation_id=f'WX-{date:%Y%m%d}', date=f'{date:%Y-%m-%d}', weather_site='北城气象观测点',
            outdoor_mean_c=str(outdoor), available_at=(date+timedelta(days=1)).isoformat()))
        for hour in range(24):
            begin = date + timedelta(hours=hour)
            end = begin + timedelta(hours=1)
            for tag, flow_base in [('QH_RT', 180), ('YX_RT', 182)]:
                supply = round(53 - outdoor*0.4 + rng.uniform(-0.3, 0.3), 2)
                ret = round(supply - 14, 2)
                flow = round(flow_base + rng.uniform(-3, 3), 2)
                add_row(catalog, events, 'sources/monitoring/station-hourly.csv', dict(
                    observation_id=f'OBS-{tag}-{begin:%Y%m%d%H}', station_tag=tag,
                    interval_start=begin.isoformat(), interval_end=end.isoformat(),
                    secondary_supply_c=str(supply), secondary_return_c=str(ret), secondary_flow_m3_h=str(flow),
                    secondary_supply_mpa='0.55', secondary_return_mpa='0.35',
                    interval_heat_gj=f'{flow*(supply-ret)*0.004186:.3f}', quality='ok', available_at=end.isoformat()))


def add_service_change(catalog, events):
    add_row(catalog, events, 'sources/service/tickets.csv', dict(
        ticket_id='CS-022', opened_at='2026-01-19T08:40:00+08:00', customer_address='柳岸1号楼202',
        complaint_text='单户暖气偏冷，申请检查', channel='phone', status_as_of_snapshot='closed',
        closed_at='2026-01-19T15:30:00+08:00', local_work_order_no='WO-QH-019', owner_team='客服组',
        available_at='2026-01-19T15:30:00+08:00'))
    add_row(catalog, events, 'sources/maintenance/work-orders.csv', dict(
        work_order_no='WO-QH-019', opened_at='2026-01-19T09:00:00+08:00', station_id='Z01',
        location='柳岸1号楼202', equipment_id='', job_type='单户偏冷检查', status_as_of_snapshot='completed',
        completed_at='2026-01-19T15:00:00+08:00', field_note='完成现场检查与处理；住户反馈另行回访，当前不推断全楼恢复',
        available_at='2026-01-19T15:10:00+08:00'))
    add_row(catalog, events, 'sources/service/callbacks.csv', dict(
        callback_id='FB-022', ticket_id='CS-022', called_at='2026-01-19T16:00:00+08:00',
        result='improved', note='住户确认比早上暖和', available_at='2026-01-19T16:00:00+08:00'))


def declare_table(catalog, path, source_id, columns, introduced_at):
    catalog[path] = dict(source_id=source_id, format='csv', owner='运行调度', columns=columns,
                         primary_key=columns[0], introduced_at=introduced_at,
                         time_columns=[c for c in columns if c.endswith('_at') or c == 'valid_from'])


def add_document(catalog, events, path, source_id, available_at, body):
    catalog[path] = dict(source_id=source_id, format='markdown', owner='运行调度')
    value = f'source_id: {source_id}\navailable_at: {available_at}\nstatus: approved\n\n{body.strip()}\n'
    events.append(dict(path=path, key='', at=available_at, value=value))


def add_mapping(catalog, events, enabled):
    path = 'sources/monitoring/channel-register.csv'
    available = '2026-01-04T10:00:00+08:00'
    declare_table(catalog, path, 'OPS-CHANNELS', ['station_tag', 'station_id', 'valid_from', 'valid_to', 'available_at'], available)
    for tag, station in [('QH_RT', 'Z01'), ('YX_RT', 'Z02')]:
        add_row(catalog, events, path, dict(station_tag=tag, station_id=station,
                valid_from='2026-01-01T00:00:00+08:00', valid_to='', available_at=available))
    if not enabled:
        return
    add_row(catalog, events, path, dict(station_tag='YX_RT', station_id='Z02',
            valid_from='2026-01-01T00:00:00+08:00', valid_to=MAPPING_AT, available_at=MAPPING_AT))
    add_row(catalog, events, path, dict(station_tag='YX_RT_V2', station_id='Z02',
            valid_from=MAPPING_AT, valid_to='', available_at=MAPPING_AT))
    for event in events:
        if event['path'] == 'sources/monitoring/station-hourly.csv':
            row = event['value']
            if row['station_tag'] == 'YX_RT' and time(row['interval_start']) >= time(MAPPING_AT):
                row['station_tag'] = 'YX_RT_V2'
                row['observation_id'] = row['observation_id'].replace('YX_RT', 'YX_RT_V2')
                event['key'] = row['observation_id']
    add_document(catalog, events, 'sources/monitoring/handover-20260121.md', 'OPS-HANDOVER-20260121', MAPPING_AT, '''
# 育新站监测接入变更交接

批准人：运行主管。生效时间：2026-01-21T00:00:00+08:00。

育新路16号育新站（台账Z02）监测接入改用标签 YX_RT_V2。原标签 YX_RT 的历史记录仍保留，时间边界前后均对应同一座站，不新增设施。清河站 QH_RT 不变。

监测接入登记表 channel-register.csv 记录标签与台账站号及有效区间，valid_to 为空表示尚未结束。按小时区间开始时间选取有效标签，边界采用左闭右开；跨系统联系以交接与登记记录为据。
''')


def add_rule_change(catalog, events):
    add_document(catalog, events, 'sources/company/event-policy.md', 'OPS-EVENT-POLICY-001',
                 '2026-01-23T09:00:00+08:00', '''
# 供热事件管理试行规则

批准人：运行主管、客服负责人。
published_at: 2026-01-23T09:00:00+08:00
effective_at: 2026-01-24T00:00:00+08:00

本公司自生效日起增加供热事件登记。新制度不改变原有客服办结率、回访确认改善率的定义。

同一运行问题可关联多条投诉。登记须列出设施、时间、现场或运行依据、关联工单及责任部门；时间接近或同属一座站本身不能确定共同根因。运行主管确认后方可关联；证据不足的来电保留待核查，不强行归入。

分别记录问题开始、站内运行恢复观察和回访核查。站内恢复不代表所有住户恢复；关联投诉仍有未接通或未确认改善时，事件保持 reviewing，不得作为全部用户恢复的证明。客服负责补充回访，运行主管确认关闭依据。

service/heating-events.csv 中 linked_ticket_ids 为用分号分隔的关联客服单号，station_recovered_at 仅表示站内恢复观察时间，status 为当前登记状态，basis 为登记依据。事件数量按事件号计，投诉数量仍按客服单号计，两者分别报告。
''')
    path = 'sources/service/heating-events.csv'
    available = '2026-01-24T09:00:00+08:00'
    declare_table(catalog, path, 'OPS-HEATING-EVENTS', [
        'heating_event_id', 'station_id', 'started_at', 'station_recovered_at',
        'linked_ticket_ids', 'status', 'basis', 'available_at'], available)
    add_row(catalog, events, path, dict(heating_event_id='HE-001', station_id='Z02',
        started_at='2026-01-14T06:10:00+08:00', station_recovered_at='2026-01-14T10:00:00+08:00',
        linked_ticket_ids='CS-011;CS-012;CS-013;CS-014', status='reviewing',
        basis='运行主管依据OPS-SHIFT-20260114、WO-YX-014及接诉记录补登记；早间四条投诉关联本次事件，其他来电待核查。CS-014回访未接通，保留核查状态。',
        available_at=available))


def generate(config_path, output):
    config = load_config(config_path)
    catalog, events = base_history()
    extend_monitoring(catalog, events, config)
    if config['changes']['facts']:
        add_service_change(catalog, events)
    add_mapping(catalog, events, config['changes']['mapping'])
    if config['changes']['rules']:
        add_rule_change(catalog, events)
    add_lifecycle_history(events)
    end = START + timedelta(days=config['days'])
    events = sorted((e for e in events if time(e['at']) <= end), key=lambda e: (time(e['at']), e['path'], e['key']))
    history = ''.join(json.dumps(e, ensure_ascii=False, sort_keys=True) + '\n' for e in events)
    run = dict(format_version=1, config=config, start=START.isoformat(), end=end.isoformat(),
               catalog=catalog, history_sha256=digest(history.encode('utf-8')),
               sample_manifest_sha256=digest((SAMPLE/'manifest.json').read_bytes()))
    with new_directory(output) as stage:
        (stage/'run.json').write_text(json_text(run), encoding='utf-8')
        (stage/'history.jsonl').write_text(history, encoding='utf-8')
    print(f'Generated author run: {output} ({len(events)} source versions)')


def export(run_path, at, output):
    require(not output.resolve().is_relative_to(run_path.resolve()), 'Snapshot must be outside the author run')
    run = json.loads((run_path/'run.json').read_text(encoding='utf-8'))
    require(run['format_version'] == 1, 'Unsupported run format')
    cutoff = time(at)
    require(time(run['start']) <= cutoff <= time(run['end']), 'as-of is outside the generated period')
    history = (run_path/'history.jsonl').read_bytes()
    require(digest(history) == run['history_sha256'], 'Author history checksum mismatch')
    state = {path: {} for path, meta in run['catalog'].items()
             if meta['format'] == 'csv' and time(meta.get('introduced_at', run['start'])) <= cutoff}
    visible_at = {}
    for line in history.decode('utf-8').splitlines():
        event = json.loads(line)
        if time(event['at']) <= cutoff:
            state.setdefault(event['path'], {})[event['key']] = event['value']
            visible_at[event['path']] = event['at']
    entries = []
    with new_directory(output) as stage:
        for path, values in sorted(state.items()):
            meta = run['catalog'][path]
            target = stage/source_path(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            entry = dict(meta, path=path)
            if meta['format'] == 'markdown':
                target.write_text(values[''], encoding='utf-8')
                entry['available_at'] = visible_at[path]
            else:
                rows = [values[key] for key in sorted(values)]
                with target.open('w', newline='', encoding='utf-8') as stream:
                    writer = csv.DictWriter(stream, fieldnames=meta['columns'], lineterminator='\n')
                    writer.writeheader()
                    writer.writerows(rows)
                availability = [r['available_at'] for r in rows]
                entry.update(records=len(rows), available_at_range=[min(availability), max(availability)] if rows else [])
            blob = target.read_bytes()
            entry.update(bytes=len(blob), sha256=digest(blob))
            entries.append(entry)
        manifest = dict(dataset_version='chengchuan-heating-generated-v1', fictional=True, timezone='Asia/Shanghai',
                        as_of=cutoff.isoformat(), observation_window=[run['start'], cutoff.replace(minute=0, second=0, microsecond=0).isoformat()],
                        observation_window_semantics='left_closed_right_open', source_root='sources',
                        total_csv_records=sum(e.get('records', 0) for e in entries), files=entries)
        (stage/'manifest.json').write_text(json_text(manifest), encoding='utf-8')
        validate(stage, quiet=True)
    print(f'Exported visible snapshot: {output} at {cutoff.isoformat()}')


def diff(before, after, output):
    for snapshot in (before, after):
        require(not output.resolve().is_relative_to(snapshot.resolve()), 'Change package must be outside snapshots')
        validate(snapshot, quiet=True)
    old = json.loads((before/'manifest.json').read_text(encoding='utf-8'))
    new = json.loads((after/'manifest.json').read_text(encoding='utf-8'))
    require(time(old['as_of']) <= time(new['as_of']), 'Change package must move forward in time')
    require(old['dataset_version'] == new['dataset_version'] and
            old['observation_window'][0] == new['observation_window'][0], 'Snapshots must belong to the same dataset format')
    def hashes(snapshot, manifest):
        return {**{e['path']: e['sha256'] for e in manifest['files']},
                'manifest.json': digest((snapshot/'manifest.json').read_bytes())}
    a, b = hashes(before, old), hashes(after, new)
    changes = dict(from_as_of=old['as_of'], to_as_of=new['as_of'],
                   base_manifest_sha256=a['manifest.json'], target_manifest_sha256=b['manifest.json'],
                   added=sorted(b.keys()-a.keys()), removed=sorted(a.keys()-b.keys()),
                   modified=sorted(k for k in a.keys() & b.keys() if a[k] != b[k]))
    with new_directory(output) as stage:
        for path in changes['added'] + changes['modified']:
            target = stage/'files'/path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(after/path, target)
        (stage/'changes.json').write_text(json_text(changes), encoding='utf-8')
    print(f'Created change package: {output}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    gen = sub.add_parser('generate')
    gen.add_argument('--config', type=Path, default=ROOT/'config/heating.json')
    gen.add_argument('--output', type=Path, required=True)
    out = sub.add_parser('export')
    out.add_argument('--run', type=Path, required=True)
    out.add_argument('--as-of', required=True)
    out.add_argument('--output', type=Path, required=True)
    delta = sub.add_parser('diff')
    delta.add_argument('--before', type=Path, required=True)
    delta.add_argument('--after', type=Path, required=True)
    delta.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'generate':
            generate(args.config, args.output)
        elif args.command == 'export':
            export(args.run, args.as_of, args.output)
        else:
            diff(args.before, args.after, args.output)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, f'FAIL: {error}\n')


if __name__ == '__main__':
    main()
