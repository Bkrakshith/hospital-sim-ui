"""Append-only, hash-chained audit log (docs/ui/02 L-6): one JSON object per line in hospital-sim-ui/server/audit/audit.jsonl.

Each entry carries `seq`, `prev` (hash of the previous entry) and `hash` = sha256(prev + canonical JSON of the entry
without `hash`). Editing, deleting or reordering any line breaks the chain from that line on (`verify`). The file is
opened in append mode only; at `rotate_bytes` it is renamed to audit-<first seq>.jsonl and the chain continues in the
new file (its first entry's `prev` is the last hash of the old one). Several server processes may share the file:
every append takes an exclusive flock and re-reads the chain tail under it.
"""
import fcntl
import glob
import hashlib
import json
import os
import threading
import time

GENESIS = '0' * 64
SECRET_KEYS = {'pin', 'token', 'password', 'badge'}


def canonical(e):
    return json.dumps(e, sort_keys=True, separators=(',', ':'), ensure_ascii=False, default=str)


def entry_hash(prev, e):
    body = {k: v for k, v in e.items() if k != 'hash'}
    return hashlib.sha256((prev + canonical(body)).encode()).hexdigest()


def scrub(args):
    """Drop secrets from op arguments before they are logged."""
    if not isinstance(args, dict):
        return args
    return {k: ('***' if k in SECRET_KEYS else v) for k, v in args.items() if k not in ('op', 'id')}


class AuditLog:
    def __init__(self, directory, rotate_bytes=50 * 1024 * 1024, clock=time.time):
        self.dir = directory
        os.makedirs(directory, exist_ok=True)
        self.path = os.path.join(directory, 'audit.jsonl')
        self.rotate_bytes = rotate_bytes
        self.clock = clock
        self.lock = threading.Lock()
        self.seq, self.last_hash = 0, GENESIS
        last = self._last_line()
        if last:
            e = json.loads(last)
            self.seq, self.last_hash = int(e['seq']), e['hash']

    def files(self):
        rotated = sorted((p for p in glob.glob(os.path.join(self.dir, 'audit-*.jsonl'))
                          if os.path.basename(p)[6:-6].isdigit()), key=lambda p: int(os.path.basename(p)[6:-6]))
        return rotated + ([self.path] if os.path.exists(self.path) else [])

    def _last_line(self):
        for p in reversed(self.files()):
            with open(p, 'rb') as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
            if lines:
                return lines[-1].decode()
        return None

    def _tail_state(self, f):
        """(seq, hash) of the last entry of the open file f (positioned anywhere), else of the rotated files."""
        f.seek(0, os.SEEK_END)
        size = f.tell()
        back = min(size, 65536)
        f.seek(size - back)
        raw = f.read(back)                       # bytes: a seek can land inside a multi-byte UTF-8 character
        lines = [ln for ln in raw.split(b'\n') if ln.strip()]
        if lines:
            e = json.loads(lines[-1].decode('utf-8'))
            return int(e['seq']), e['hash']
        last = self._last_line()
        if last:
            e = json.loads(last)
            return int(e['seq']), e['hash']
        return 0, GENESIS

    def append(self, **fields):
        with self.lock, open(self.path, 'ab+') as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            self.seq, self.last_hash = self._tail_state(f)
            now = self.clock()
            e = {'seq': self.seq + 1, 't': round(now, 3),
                 'iso': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(now)), **fields,
                 'prev': self.last_hash}
            e['hash'] = entry_hash(self.last_hash, e)
            out = f
            if f.tell() > self.rotate_bytes:
                f.seek(0)
                first = json.loads(f.readline().decode('utf-8'))['seq']
                os.rename(self.path, os.path.join(self.dir, f'audit-{first}.jsonl'))
                out = open(self.path, 'ab')
            try:
                out.write((canonical(e) + '\n').encode('utf-8'))
                out.flush()
                os.fsync(out.fileno())
            finally:
                if out is not f:
                    out.close()
            self.seq, self.last_hash = e['seq'], e['hash']
            return e

    def iter_entries(self):
        for p in self.files():
            with open(p, encoding='utf-8') as f:
                for ln in f:
                    if ln.strip():
                        yield json.loads(ln)

    def verify(self):
        """Returns {ok, n, bad_seq, reason}."""
        prev, n, want = GENESIS, 0, 1
        try:
            for e in self.iter_entries():
                n += 1
                if e.get('seq') != want:
                    return {'ok': False, 'n': n, 'bad_seq': e.get('seq'), 'reason': f'expected seq {want}'}
                if e.get('prev') != prev:
                    return {'ok': False, 'n': n, 'bad_seq': e['seq'], 'reason': 'prev hash does not match'}
                if entry_hash(prev, e) != e.get('hash'):
                    return {'ok': False, 'n': n, 'bad_seq': e['seq'], 'reason': 'entry was modified'}
                prev, want = e['hash'], want + 1
        except ValueError as ex:
            return {'ok': False, 'n': n, 'bad_seq': want, 'reason': f'unreadable line: {ex}'}
        return {'ok': True, 'n': n, 'bad_seq': None, 'reason': ''}

    def tail(self, limit=200, before_seq=None, since_t=None):
        out = []
        for e in self.iter_entries():
            if before_seq is not None and e['seq'] >= before_seq:
                continue
            if since_t is not None and e['t'] < since_t:
                continue
            out.append(e)
            if len(out) > limit:
                out.pop(0)
        return out
