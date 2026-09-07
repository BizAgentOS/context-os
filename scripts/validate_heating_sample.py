#!/usr/bin/env python3
"""Check the committed source sample, without reading answers or future plans."""
import argparse
import csv
import hashlib
import io
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def time(value):
    result = datetime.fromisoformat(value)
    require(result.utcoffset() == timedelta(hours=8), f"Expected UTC+08:00: {value}")
    return result


def validate(root):
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    require(manifest['fictional'] is True, 'Sample must be marked fictional')
    as_of = time(manifest['as_of'])
    start, end = map(time, manifest['observation_window'])
    require(start < end <= as_of, 'Invalid observation window')
    tables, listed, source_ids = {}, set(), set()
    row_count = 0
    for entry in manifest['files']:
        rel = Path(entry['path'])
        require(not rel.is_absolute() and '..' not in rel.parts and rel.parts[0] == 'sources',
                f"Source path outside sources/: {rel}")
        require(str(rel) not in listed, f"Duplicate source path: {rel}")
        listed.add(str(rel))
        require(entry['source_id'] not in source_ids, 'Duplicate source ID')
        source_ids.add(entry['source_id'])
        path = root / rel
        require(path.resolve().is_relative_to((root / 'sources').resolve()), 'Source escapes dataset')
        require(not path.is_symlink(), f"Source symlink: {rel}")
        blob = path.read_bytes()
        require(len(blob) == entry['bytes'], f"Size mismatch: {rel}")
        require(hashlib.sha256(blob).hexdigest() == entry['sha256'], f"Hash mismatch: {rel}")
        if entry['format'] == 'markdown':
            require(entry['source_id'] in blob.decode('utf-8'), f"Missing document source ID: {rel}")
            require(time(entry['available_at']) <= as_of, f"Future document: {rel}")
            continue
        require(entry['format'] == 'csv', f"Unsupported format: {rel}")
        reader = csv.DictReader(io.StringIO(blob.decode('utf-8')))
        require(reader.fieldnames == entry['columns'], f"CSV columns differ: {rel}")
        rows = list(reader)
        require(len(rows) == entry['records'], f"Row count mismatch: {rel}")
        require(bool(rows), f"Empty source table: {rel}")
        availability = [r['available_at'] for r in rows]
        require(entry['available_at_range'] == [min(availability), max(availability)],
                f"Availability range differs: {rel}")
        row_count += len(rows)
        primary = entry['primary_key']
        keys = set()
        for row in rows:
            require(None not in row and None not in row.values(), f"Malformed CSV row: {rel}")
            key = row[primary]
            require(key and key not in keys, f"Missing/duplicate key in {rel}: {key}")
            keys.add(key)
            available = time(row['available_at'])
            require(available <= as_of, f"Future row in snapshot: {rel}:{key}")
            for field in entry['time_columns']:
                if row[field]:
                    require(time(row[field]) <= available, f"Record predates its event: {rel}:{key}:{field}")
        tables[str(rel.relative_to('sources'))] = rows
    actual = {str(p.relative_to(root)) for p in (root / 'sources').rglob('*') if p.is_file()}
    require(actual == listed, 'Unlisted or missing source files')
    require(row_count == manifest['total_csv_records'], 'Total record count differs')

    def index(name, key):
        return {r[key]: r for r in tables[name]}

    stations = index('assets/stations.csv', 'station_id')
    area = defaultdict(float)
    buildings = tables['assets/buildings.csv']
    for row in buildings:
        require(row['station_id'] in stations, 'Building references unknown station')
        require(int(row['contract_households']) > 0 and float(row['supplied_area_m2']) > 0, 'Invalid building size')
        area[row['station_id']] += float(row['supplied_area_m2'])
    for key, row in stations.items():
        require(math.isclose(area[key], float(row['service_area_m2'])), f"Station area mismatch: {key}")
    equipment = index('assets/equipment.csv', 'equipment_id')
    for row in equipment.values():
        require(row['station_id'] in stations, 'Equipment references unknown station')

    orders = index('maintenance/work-orders.csv', 'work_order_no')
    for row in orders.values():
        require(row['station_id'] in stations, 'Work order references unknown station')
        if row['equipment_id']:
            require(row['equipment_id'] in equipment, 'Work order references unknown equipment')
            require(equipment[row['equipment_id']]['station_id'] == row['station_id'], 'Equipment/station mismatch')
        if row['completed_at']:
            require(time(row['completed_at']) >= time(row['opened_at']), 'Work completed before opening')
        require((row['status_as_of_snapshot'] == 'completed') == bool(row['completed_at']), 'Work order state mismatch')

    tickets = index('service/tickets.csv', 'ticket_id')
    for row in tickets.values():
        if row['local_work_order_no']:
            require(row['local_work_order_no'] in orders, 'Ticket references unknown work order')
        if row['closed_at']:
            require(time(row['closed_at']) >= time(row['opened_at']), 'Ticket closed before opening')
        require((row['status_as_of_snapshot'] == 'closed') == bool(row['closed_at']), 'Ticket state mismatch')
    for name, event_time in [('service/callbacks.csv', 'called_at'), ('service/room-measurements.csv', 'measured_at')]:
        for row in tables[name]:
            require(row['ticket_id'] in tickets, f"Unknown ticket in {name}")
            require(time(row[event_time]) >= time(tickets[row['ticket_id']]['opened_at']), f"Activity predates ticket: {name}")
    callback_keys = set()
    for row in tables['service/callbacks.csv']:
        require(row['result'] in {'improved', 'not_improved', 'unreachable', 'uncertain'}, 'Unknown callback result')
        key = row['ticket_id'], row['called_at']
        require(key not in callback_keys, 'Ambiguous latest callback: same ticket and timestamp')
        callback_keys.add(key)
    for row in tables['service/room-measurements.csv']:
        require(math.isfinite(float(row['indoor_c'])), 'Invalid room temperature')
        require(bool(row['measurement_location']) and bool(row['method']), 'Missing measurement context')

    numeric = ['secondary_supply_c', 'secondary_return_c', 'secondary_flow_m3_h',
               'secondary_supply_mpa', 'secondary_return_mpa', 'interval_heat_gj']
    series, missing = defaultdict(list), 0
    for row in tables['monitoring/station-hourly.csv']:
        begin, finish = time(row['interval_start']), time(row['interval_end'])
        require(finish-begin == timedelta(hours=1), 'Not a one-hour interval')
        series[row['station_tag']].append((begin, finish))
        if row['quality'] == 'missing':
            require(all(row[k] == '' for k in numeric), 'Missing data must not contain invented zeroes')
            missing += 1
            continue
        require(row['quality'] == 'ok', 'Unknown monitoring quality')
        values = {k: float(row[k]) for k in numeric}
        require(all(math.isfinite(v) for v in values.values()), 'Non-finite monitoring value')
        delta = values['secondary_supply_c'] - values['secondary_return_c']
        require(delta >= 0 and values['secondary_flow_m3_h'] >= 0, 'Invalid sample heat/flow relationship')
        require(values['secondary_supply_mpa'] >= values['secondary_return_mpa'] >= 0, 'Invalid pressure relationship')
        heat = values['secondary_flow_m3_h'] * delta * 0.004186
        require(abs(heat-values['interval_heat_gj']) <= 0.00051, 'Synthetic heat arithmetic mismatch')
    require(len(series) == len(stations), 'Sample station/channel count mismatch')
    for tag, intervals in series.items():
        cursor = start
        for begin, finish in sorted(intervals):
            require(begin == cursor, f"Gap or overlapping monitoring interval: {tag}")
            cursor = finish
        require(cursor == end, f"Monitoring coverage differs: {tag}")
    weather = tables['monitoring/weather-daily.csv']
    dates = [r['date'] for r in weather]
    expected = [(start+timedelta(days=i)).date().isoformat() for i in range((end-start).days)]
    require(sorted(dates) == expected, 'Weather coverage differs')
    for row in weather:
        require(math.isfinite(float(row['outdoor_mean_c'])), 'Invalid outdoor temperature')
    print(f"PASS: {len(listed)} source files, {row_count} CSV records; hashes, references, times and sample quantities checked.")
    print(f"Coverage: {len(stations)} stations, {len(buildings)} buildings, {len(weather)} days; {missing} explicit missing monitoring interval(s).")
    print('This validates a fixed sample, not a generator, physical simulator or Agent evaluation.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, default=Path(__file__).resolve().parents[1]/'data/samples/chengchuan-heating')
    args = parser.parse_args()
    try:
        validate(args.dataset)
    except (ValueError, KeyError, OSError, TypeError) as exc:
        print(f'FAIL: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
