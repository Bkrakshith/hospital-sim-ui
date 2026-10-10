"""Closed-loop requests with undo (docs/ui/README.md decision 10; 03 HF-3, HF-6): `send_to` and `instrument_request`
are held on the server for `undo_s` (3 s) before they are dispatched. The readback text is shown on every iPad and
spoken by the robot; `undo` within the window cancels. Works on the running asyncio loop."""
import asyncio
import itertools
import time


class PendingCommands:
    def __init__(self, undo_s=3.0, on_event=None, clock=time.time):
        self.undo_s = undo_s
        self.on_event = on_event or (lambda msg: None)   # broadcast pending / pending_done
        self.clock = clock
        self.items = {}
        self.ids = itertools.count(1)

    def add(self, kind, text, dispatch, by=None, speak=None, args=None):
        """dispatch: async () -> (ok, message). Returns the public pending dict."""
        pid = f'P{next(self.ids)}'
        now = self.clock()
        p = {'id': pid, 'kind': kind, 'text': text, 'speak': speak or text, 'by': by or {}, 'args': args or {},
             'created': round(now, 3), 'dispatch_at': round(now + self.undo_s, 3), 'undo_s': self.undo_s}
        task = asyncio.ensure_future(self._run(pid, dispatch))
        self.items[pid] = (p, task)
        self.on_event({'type': 'pending', **p})
        return p

    async def _run(self, pid, dispatch):
        try:
            await asyncio.sleep(self.undo_s)
        except asyncio.CancelledError:
            return
        p, _ = self.items.pop(pid, (None, None))
        if p is None:
            return
        try:
            ok, message = await dispatch()
        except Exception as e:  # noqa: BLE001
            ok, message = False, f'{type(e).__name__}: {e}'
        self.on_event({'type': 'pending_done', 'id': pid, 'kind': p['kind'], 'ok': bool(ok), 'cancelled': False,
                       'message': message, 'text': p['text']})

    def undo(self, pid, by=None):
        entry = self.items.pop(pid, None)
        if entry is None:
            return False, 'too late to undo (already sent) or unknown request'
        p, task = entry
        task.cancel()
        self.on_event({'type': 'pending_done', 'id': pid, 'kind': p['kind'], 'ok': True, 'cancelled': True,
                       'message': 'undone', 'text': p['text'], 'by': by or {}})
        return True, f"undone: {p['text']}"

    def list(self):
        return [p for p, _ in self.items.values()]
