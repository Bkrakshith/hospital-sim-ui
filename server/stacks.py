"""Start / stop `ros2 launch` stacks (SLAM, navigation, mock robot) as managed subprocesses.

Each stack runs in its own process group so that stopping it takes down every node the launch
file started. Stop = SIGINT to the group (ros2 launch shuts its children down cleanly), then
SIGTERM after 8 s, SIGKILL after 12 s. Output lines are forwarded to the dashboard log.
"""
import asyncio
import os
import re
import shlex
import signal
import time

ROS_LOG_LINE = re.compile(r'\[(DEBUG|INFO|WARN|ERROR|FATAL)\] \[\d+\.\d+\] \[')



def _default_signals():
    # a server started from a non-interactive shell inherits SIGINT=ignored; ros2 launch must get it back
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)


class Stack:
    def __init__(self, name, log):
        self.name = name
        self.log = log                 # log(level, source, text)
        self.proc = None
        self.state = 'stopped'         # stopped | starting | running | stopping | failed
        self.cmd = None
        self.args = {}
        self.since = time.time()
        self.exit_code = None
        self.last_lines = []
        self._reader = None
        self._ready_check = None

    def info(self):
        return {'state': self.state, 'pid': self.proc.pid if self.proc else None,
                'since': self.since, 'args': self.args, 'exit_code': self.exit_code,
                'cmd': ' '.join(self.cmd) if self.cmd else None}

    def _set(self, state):
        self.state = state
        self.since = time.time()

    async def start(self, cmd, args=None, env=None, ready_check=None):
        if self.proc and self.proc.returncode is None:
            raise RuntimeError(f'{self.name} is already {self.state}')
        self.cmd = cmd
        self.args = args or {}
        self.exit_code = None
        self._ready_check = ready_check
        self._set('starting')
        self.log('info', 'stacks', f'starting {self.name}: {" ".join(shlex.quote(c) for c in cmd)}')
        self.proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL, start_new_session=True, env=env,
            preexec_fn=_default_signals)
        self._reader = asyncio.ensure_future(self._read())
        asyncio.ensure_future(self._watch_ready())

    async def _watch_ready(self):
        proc = self.proc
        t0 = time.time()
        while proc is self.proc and proc.returncode is None and self.state == 'starting':
            ok = True
            if self._ready_check is not None:
                try:
                    ok = bool(self._ready_check())
                except Exception:
                    ok = False
            if ok and time.time() - t0 > 1.5:
                self._set('running')
                self.log('info', 'stacks', f'{self.name} is running')
                return
            await asyncio.sleep(0.5)

    async def _read(self):
        proc = self.proc
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode(errors='replace').rstrip()
                if not text:
                    continue
                self.last_lines = (self.last_lines + [text])[-50:]
                low = text.lower()
                if ROS_LOG_LINE.search(text):
                    level = 'debug'  # node log lines also arrive via /rosout; keep them out of the default view
                else:
                    level = 'error' if ('[error]' in low or '[fatal]' in low or 'exception' in low
                                        or 'traceback' in low or 'process has died' in low) \
                        else 'warn' if '[warn' in low else 'debug'
                self.log(level, self.name, text)
        finally:
            rc = await proc.wait()
            if proc is self.proc:
                self.exit_code = rc
                if self.state == 'stopping' or rc in (0, -2, 130):
                    self._set('stopped')
                    self.log('info', 'stacks', f'{self.name} stopped (exit {rc})')
                else:
                    self._set('failed')
                    self.log('error', 'stacks', f'{self.name} exited with code {rc}')

    async def stop(self, timeout_int=8.0, timeout_term=4.0):
        proc = self.proc
        if not proc or proc.returncode is not None:
            self._set('stopped')
            return
        self._set('stopping')
        self.log('info', 'stacks', f'stopping {self.name}')
        pgid = os.getpgid(proc.pid)
        for sig, wait in ((signal.SIGINT, timeout_int), (signal.SIGTERM, timeout_term),
                          (signal.SIGKILL, 2.0)):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                break
            try:
                await asyncio.wait_for(proc.wait(), wait)
                break
            except asyncio.TimeoutError:
                self.log('warn', 'stacks', f'{self.name} did not exit after {sig.name}')
        # make sure stragglers in the group are gone
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if self._reader:
            try:
                await asyncio.wait_for(self._reader, 2.0)
            except Exception:
                pass
        self._set('stopped')


class StackManager:
    def __init__(self, log, use_sim_time=True):
        self.log = log
        self.use_sim_time = use_sim_time
        self.stacks = {n: Stack(n, log) for n in ('slam', 'nav', 'mock')}

    def info(self):
        return {n: s.info() for n, s in self.stacks.items()}

    def _ros2_launch(self, pkg, launch, **kw):
        cmd = ['ros2', 'launch', pkg, launch]
        cmd += [f'{k}:={v}' for k, v in kw.items()]
        return cmd

    async def start_slam(self, ready_check=None):
        cmd = self._ros2_launch('g1_navigation', 'slam.launch.py',
                                use_sim_time=str(self.use_sim_time).lower())
        await self.stacks['slam'].start(cmd, {}, ready_check=ready_check)

    async def start_nav(self, map_yaml=None, ready_check=None):
        kw = {'use_sim_time': str(self.use_sim_time).lower()}
        if map_yaml:
            kw['map'] = map_yaml
        else:
            kw['slam'] = 'true'
        cmd = self._ros2_launch('g1_navigation', 'nav.launch.py', **kw)
        await self.stacks['nav'].start(
            cmd, {'map': os.path.basename(map_yaml)[:-5] if map_yaml else None,
                  'localization': 'amcl' if map_yaml else 'slam'}, ready_check=ready_check)

    async def start_mock(self, script, extra=()):
        import sys
        cmd = [sys.executable, script, *extra]
        await self.stacks['mock'].start(cmd, {'script': script})

    async def stop(self, name):
        await self.stacks[name].stop()

    async def stop_all(self):
        await asyncio.gather(*(s.stop() for s in self.stacks.values()), return_exceptions=True)
