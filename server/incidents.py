"""Incident bundles (docs/ui/04 F6; README decision 15): a rolling 5-minute ring buffer of what the robot and the
server did (mode changes with sources, commands with role/device, alarms, controller / manager status, pose,
battery, versions) and a zip of it on "Send problem to technician". No images, no patient data: nothing in the
buffer can carry PHI (the app has no patient fields; camera frames are never recorded here)."""
import collections
import glob
import io
import json
import os
import re
import time
import zipfile


class RingBuffer:
    def __init__(self, seconds=300.0, clock=time.time, maxlen=20000):
        self.seconds = seconds
        self.clock = clock
        self.q = collections.deque(maxlen=maxlen)

    def add(self, kind, data):
        now = self.clock()
        self.q.append({'t': round(now, 3), 'kind': kind, 'data': data})
        while self.q and now - self.q[0]['t'] > self.seconds:
            self.q.popleft()

    def snapshot(self):
        now = self.clock()
        return [e for e in self.q if now - e['t'] <= self.seconds]


class IncidentStore:
    def __init__(self, directory, clock=time.time):
        self.dir = directory
        self.clock = clock
        os.makedirs(directory, exist_ok=True)

    def next_id(self):
        day = time.strftime('%m%d', time.localtime(self.clock()))
        n = 0
        for p in glob.glob(os.path.join(self.dir, f'INC-{day}-*.zip')):
            m = re.match(rf'INC-{day}-(\d+)\.zip$', os.path.basename(p))
            if m:
                n = max(n, int(m.group(1)))
        return f'INC-{day}-{n + 1:02d}'

    def create(self, ring, meta):
        iid = self.next_id()
        path = os.path.join(self.dir, iid + '.zip')
        events = ring.snapshot()
        meta = {'id': iid, 'created': round(self.clock(), 3),
                'created_iso': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(self.clock())),
                'window_s': ring.seconds, 'n_events': len(events), 'status': 'open', **meta}
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('incident.json', json.dumps(meta, indent=1, default=str))
            z.writestr('timeline.jsonl', '\n'.join(json.dumps(e, default=str) for e in events) + '\n')
            by_kind = collections.Counter(e['kind'] for e in events)
            z.writestr('README.txt', f'{iid}: last {ring.seconds:.0f} s before "send problem to technician".\n'
                       f'incident.json = context (who, chips, note, versions, state); timeline.jsonl = one event per\n'
                       f'line (t, kind, data). Event counts: {dict(by_kind)}. No images, no patient data.\n')
        tmp = path + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(buf.getvalue())
        os.replace(tmp, path)
        return iid, path, meta

    def list(self):
        out = []
        for p in sorted(glob.glob(os.path.join(self.dir, 'INC-*.zip')), reverse=True):
            try:
                with zipfile.ZipFile(p) as z:
                    m = json.loads(z.read('incident.json'))
                out.append({k: m.get(k) for k in ('id', 'created', 'created_iso', 'by', 'chips', 'note', 'status',
                                                    'n_events', 'mode')} | {'size': os.path.getsize(p)})
            except (zipfile.BadZipFile, KeyError, ValueError):
                continue
        return out

    def get(self, iid):
        p = self.path(iid)
        if p is None:
            return None
        with zipfile.ZipFile(p) as z:
            meta = json.loads(z.read('incident.json'))
            tl = [json.loads(ln) for ln in z.read('timeline.jsonl').decode().splitlines() if ln.strip()]
        return {'incident': meta, 'timeline': tl}

    def path(self, iid):
        if not re.match(r'^INC-\d{4}-\d{2,}$', iid or ''):
            return None
        p = os.path.join(self.dir, iid + '.zip')
        return p if os.path.isfile(p) else None
