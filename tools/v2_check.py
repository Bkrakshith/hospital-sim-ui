#!/usr/bin/env python3
"""End-to-end check of the v2 protocol against a running hospital-sim-ui/server (mock robot or MuJoCo sim).

    python hospital-sim-ui/tools/v2_check.py [--url wss://127.0.0.1:8443/ws] [--json out.json] [--sim]

Two simulated iPads (A = operator, B = clinical, C = operator) exercise: session + roles (Clinical refused a
technician op), the control lease (non-holder motion refused), Stop -> HOLD + resume, the UI heartbeat watchdog
(A stops heartbeating in LOCO -> HOLD by "watchdog" + Medium alarm), undo window, alarms, audit chain, incident.
Exit code 0 if all checks passed. The server must run with the default auth.yaml test PINs.
"""
import argparse
import asyncio
import json
import ssl
import sys
import time

import aiohttp

OP_PIN, TECH_PIN = '123456', '987654'


class Pad:
    def __init__(self, name, url):
        self.name, self.url = name, url
        self.id = 0
        self.waiters = {}
        self.msgs = []
        self.state = {}
        self.mode = None
        self.hb = True
        self.lease = None
        self.alarms = None

    async def open(self, session, sslctx):
        self.ws = await session.ws_connect(self.url, ssl=sslctx)
        self.reader = asyncio.ensure_future(self._read())
        self.hbt = asyncio.ensure_future(self._heartbeat())
        r = await self.call('hello', protocol=2, device_id=f'test-{self.name}', device_name=f'iPad {self.name}',
                            room='theatre_1', app='v2_check')
        assert r['ok'], r
        return r

    async def _read(self):
        async for m in self.ws:
            if m.type != aiohttp.WSMsgType.TEXT:
                continue
            d = json.loads(m.data)
            t = d.get('type')
            if t == 'result' and d.get('id') in self.waiters:
                self.waiters.pop(d['id']).set_result(d)
            elif t == 'state':
                self.state = d
            elif t == 'mode':
                self.mode = d
            elif t == 'lease':
                self.lease = d
            elif t == 'alarms':
                self.alarms = d
            else:
                self.msgs.append(d)

    async def _heartbeat(self):
        while True:
            if self.hb:
                await self.ws.send_str('{"op":"heartbeat"}')
            await asyncio.sleep(0.15)

    async def call(self, op, timeout=8.0, **kw):
        self.id += 1
        f = asyncio.get_running_loop().create_future()
        self.waiters[self.id] = f
        await self.ws.send_str(json.dumps({'op': op, 'id': self.id, **kw}))
        return await asyncio.wait_for(f, timeout)

    async def close(self):
        self.hbt.cancel()
        self.reader.cancel()
        await self.ws.close()


async def wait_for(pred, timeout=10.0, dt=0.1):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return True
        await asyncio.sleep(dt)
    return False


async def main(a):
    results = []

    def check(name, ok, detail=''):
        results.append({'check': name, 'ok': bool(ok), 'detail': str(detail)[:300]})
        print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))
        return ok

    sslctx = ssl.create_default_context()
    sslctx.check_hostname = False
    sslctx.verify_mode = ssl.CERT_NONE
    async with aiohttp.ClientSession() as s:
        A, B, C = Pad('A', a.url), Pad('B', a.url), Pad('C', a.url)
        for p in (A, B, C):
            await p.open(s, sslctx if a.url.startswith('wss') else None)
        mode = lambda p=A: (p.mode or {}).get('name')  # noqa: E731

        # ---------------------------------------------------------------- roles
        r = await B.call('stack_start', stack='slam')
        check('clinical refused technician op (stack_start)', not r['ok'] and r['data']['code'] == 'forbidden', r)
        r = await B.call('audit_list')
        check('clinical refused audit_list', not r['ok'] and r['data']['code'] == 'forbidden', r)
        r = await B.call('login', role='operator', pin='000000')
        check('wrong PIN refused', not r['ok'] and r['data']['code'] == 'bad_pin', r)
        r = await A.call('login', role='operator', pin=OP_PIN, user='Test Operator')
        check('operator login', r['ok'] and r['data']['session']['role'] == 'operator', r)
        r = await C.call('login', role='operator', pin=OP_PIN)
        check('second operator login', r['ok'], r)
        r = await A.call('audit_list')
        check('operator refused audit_list (technician op)', not r['ok'], r)

        # ---------------------------------------------------------------- stand up
        if mode() in ('HOLD',):
            await A.call('resume', to='stand')
        if mode() != 'STAND':
            if mode() != 'DAMP':
                await A.call('power_off')
                await asyncio.sleep(1.0)
            r = await A.call('set_mode', mode='STAND')
            check('DAMP -> STAND', r['ok'], r)
        await wait_for(lambda: mode() == 'STAND' and 'ready' in (A.mode or {}).get('detail', ''), 12)

        # ---------------------------------------------------------------- lease
        r = await A.call('set_mode', mode='LOCO')
        check('v2 client needs the lease for LOCO', not r['ok'] and r['data']['code'] == 'need_lease', r)
        r = await A.call('lease_acquire', reason='drive test')
        check('A acquires lease', r['ok'], r)
        await wait_for(lambda: A.lease and A.lease.get('you'), 3)
        check('lease broadcast (A is holder, B observes)', A.lease and A.lease['you'] and B.lease
              and not B.lease['you'] and B.lease['holder']['device_id'] == 'test-A', (A.lease, B.lease))
        r = await C.call('lease_acquire')
        check('C cannot acquire a held lease', not r['ok'], r)
        r = await A.call('set_mode', mode='LOCO')
        check('holder A: STAND -> LOCO', r['ok'], r)
        r = await C.call('cmd_vel', vx=0.3, vy=0, wz=0)
        check("non-holder C's motion op rejected (cmd_vel)", not r['ok'] and r['data']['code'] == 'lease', r)
        r = await C.call('key', key='w')
        check("non-holder C's key rejected", not r['ok'] and r['data']['code'] == 'lease', r)
        r = await B.call('send_to', place='theatre_door')
        check('clinical send_to refused while A holds the lease', not r['ok'] and r['data']['code'] == 'lease', r)

        # ---------------------------------------------------------------- stop from a non-holder
        r = await B.call('stop')
        check('clinical non-holder can Stop', r['ok'], r)
        ok = await wait_for(lambda: mode() == 'HOLD', 3)
        check('Stop -> HOLD', ok, A.mode)
        await wait_for(lambda: (A.state.get('hold') or {}).get('held_from') == 'LOCO', 3)
        h = A.state.get('hold') or {}
        check('state.hold says who stopped it, from what', h.get('held_from') == 'LOCO' and
              'iPad B' in (h.get('by_label') or ''), h)
        r = await B.call('stop_reason', reason='person_in_way')
        check('stop reason recorded', r['ok'], r)
        r = await A.call('set_mode', mode='LOCO')
        check('HOLD -> LOCO refused (resume first)', not r['ok'], r)
        r = await B.call('resume', to='stand')
        check('clinical resume -> STAND', r['ok'] and mode() in ('STAND',) or r['ok'], r)
        await wait_for(lambda: mode() == 'STAND', 3)
        check('mode STAND after resume', mode() == 'STAND', A.mode)
        await wait_for(lambda: 'ready' in (A.mode or {}).get('detail', ''), 5)

        # ---------------------------------------------------------------- watchdog
        r = await A.call('set_mode', mode='LOCO')
        check('A: STAND -> LOCO again', r['ok'], r)
        await asyncio.sleep(1.5)
        check('LOCO survives with heartbeat (1.5 s)', mode() == 'LOCO', A.mode)
        A.hb = False
        t0 = time.time()
        ok = await wait_for(lambda: mode() == 'HOLD', 4)
        dt = time.time() - t0
        check('heartbeat stops -> HOLD by watchdog', ok and (A.mode or {}).get('source') == 'watchdog',
              f'{A.mode} after {dt:.2f} s')
        check('watchdog trip time 1.0-2.0 s', 0.9 < dt < 2.2, f'{dt:.2f} s')
        results[-1]['detail'] = f'{dt:.2f} s'
        A.hb = True
        ok = await wait_for(lambda: A.alarms and any(x['code'] == 'manual_control_lost'
                                                     for x in A.alarms['active']), 4)
        check('Medium alarm "Manual control lost"', ok, A.alarms)
        al = next((x for x in (A.alarms or {}).get('active', []) if x['code'] == 'manual_control_lost'), None)
        if al:
            check('alarm has what/do/who', al['what'] and al['do'] and al['who'] and al['priority'] == 'medium', al)
            r = await B.call('alarm_ack', alarm_id=al['id'])
            check('clinical acknowledges alarm', r['ok'], r)
        await A.call('resume', to='stand')
        await wait_for(lambda: mode() == 'STAND', 3)

        # ---------------------------------------------------------------- steal
        r = await C.call('lease_steal', reason='')
        check('steal needs a reason', not r['ok'], r)
        r = await C.call('lease_steal', reason='A went to scrub')
        check('C steals the lease with a reason', r['ok'], r)
        await wait_for(lambda: A.lease and not A.lease['you'], 3)
        check('A sees it lost control', A.lease and not A.lease['you'], A.lease)
        r = await C.call('lease_release')
        check('C releases', r['ok'], r)

        # ---------------------------------------------------------------- arms hold in MANIP, gripper override
        r = await B.call('hand', side='right', close=0.0)
        check('clinical refused gripper override', not r['ok'] and r['data']['code'] == 'forbidden', r)
        r = await A.call('hand', side='right', close=0.0)
        check('gripper override refused in STAND', not r['ok'], r)
        await wait_for(lambda: 'ready' in (A.mode or {}).get('detail', ''), 5)
        await A.call('lease_acquire', reason='arms')
        await wait_for(lambda: A.lease and A.lease.get('you'), 3)
        r = await A.call('set_mode', mode='MANIP')
        check('A: STAND -> MANIP', r['ok'], r)
        r = await A.call('hand', side='right', close=1.0)
        check('gripper override refused in MANIP while the camera drives the hands', not r['ok'], r)
        r = await C.call('manip_hold', on=True)
        check("non-holder can't hold/release the arms", not r['ok'] and r['data']['code'] == 'lease', r)
        r = await A.call('manip_hold', on=True)
        check('manip_hold on: arms held, still MANIP', r['ok'] and mode() == 'MANIP', r)
        await wait_for(lambda: A.state.get('arms_hold'), 3)
        check('state.arms_hold + task sentence', A.state.get('arms_hold') and
              '(arms held)' in (A.state.get('task') or {}).get('text', ''), A.state.get('task'))
        r = await A.call('hand', side='right', close=0.0)
        check('gripper override (open) with arms held', r['ok'] and r['data']['hand_override']['side'] == 'right', r)
        r = await A.call('manip_hold', on=False)
        check('manip_hold off: arms follow the operator again', r['ok'] and mode() == 'MANIP', r)
        await A.call('set_mode', mode='STAND')
        await A.call('lease_release')
        await wait_for(lambda: mode() == 'STAND', 3)

        # ---------------------------------------------------------------- state additions
        await asyncio.sleep(1.0)
        px = A.state.get('proximity')
        check('state.proximity.sectors [left, front, right] from /scan', px and len(px['sectors']) == 3
              and set(px['named']) == {'left', 'front', 'right'}, px)
        t = A.state.get('task') or {}
        check('state.task plain-language sentence', t.get('text', '').startswith(('Standing by', 'Arms')), t)

        # ---------------------------------------------------------------- undo window
        r = await B.call('send_to', place='theatre_door')
        pend = (r.get('data') or {}).get('pending') or {}
        check('send_to readback + pending (clinical, lease free)', r['ok'] and pend.get('undo_s') == 3.0, r)
        if pend:
            r2 = await B.call('undo', pending_id=pend['id'])
            check('undo within 3 s', r2['ok'], r2)
            await asyncio.sleep(3.5)
            done = [m for m in B.msgs if m.get('type') == 'pending_done' and m.get('id') == pend['id']]
            check('undone request never dispatched', len(done) == 1 and done[0]['cancelled'], done)
        r = await B.call('send_to', place='theatre_instrument_table')
        check('clinical refused an operator-only place', not r['ok'], r)

        # ---------------------------------------------------------------- data
        r = await B.call('places_list')
        check('places_list', r['ok'] and len(r['data']['places']) >= 5, r)
        r = await B.call('instruments_list')
        check('instruments_list', r['ok'] and len(r['data']['instruments']) >= 5, r)
        r = await B.call('checks_run')
        check('checks_run', r['ok'] or r['message'] == 'not ready', [(i['id'], i['status']) for i in
                                                                   (r['data'] or {}).get('items', [])])
        r = await B.call('handover_card')
        check('handover_card', r['ok'] and 'trips' in r['data'], r)

        # ---------------------------------------------------------------- incident, audit
        r = await B.call('incident_create', chips=['behaving_oddly'], note='v2_check')
        check('incident bundle created', r['ok'] and r['data']['id'].startswith('INC-'), r)
        r = await B.call('login', role='technician', pin=TECH_PIN)
        check('technician login', r['ok'], r)
        r = await B.call('audit_verify')
        check('audit chain intact', r['ok'], r)
        r = await B.call('audit_list', limit=500)
        ents = (r.get('data') or {}).get('entries', [])
        refused = [e for e in ents if e.get('refused') and e.get('device') == 'test-C']
        check('audit has refused motion ops with role/device/lease holder', refused and
              refused[-1].get('lease_holder') is not None and refused[-1].get('role') == 'operator', refused[-1:])
        r = await B.call('incidents_list')
        check('technician lists incidents', r['ok'] and r['data']['incidents'], r)
        iid = r['data']['incidents'][0]['id']
        r = await B.call('incident_link', incident_id=iid)
        url = (r.get('data') or {}).get('url', '')
        check('one-time incident link (no session token in the URL)', r['ok'] and 'dl=' in url and
              'token' not in url, r)
        base = a.url.replace('wss://', 'https://').replace('ws://', 'http://').rsplit('/ws', 1)[0]
        sslarg = sslctx if base.startswith('https') else None
        async with s.get(base + url, ssl=sslarg) as resp:
            body = await resp.read()
            check('incident zip downloads once', resp.status == 200 and body[:2] == b'PK', resp.status)
        async with s.get(base + url, ssl=sslarg) as resp:
            check('second use of the link refused', resp.status == 403, resp.status)
        r = await B.call('logout')
        check('logout -> clinical', r['ok'] and r['data']['session']['role'] == 'clinical', r)

        # ---------------------------------------------------------------- power off
        r = await B.call('power_off')
        check('power off (DAMP)', r['ok'], r)
        ok = await wait_for(lambda: mode() == 'DAMP', 3)
        check('mode DAMP', ok, A.mode)
        ok = await wait_for(lambda: B.alarms and any(x['code'] == 'power_off' and x['priority'] == 'high'
                                                     for x in B.alarms['active']), 3)
        check('High latched alarm "Robot powered down"', ok, B.alarms)
        for p in (A, B, C):
            await p.close()
    n_ok = sum(r['ok'] for r in results)
    print(f'\n{n_ok}/{len(results)} checks passed')
    if a.json:
        with open(a.json, 'w') as f:
            json.dump({'passed': n_ok, 'total': len(results), 'results': results}, f, indent=1)
    return 0 if n_ok == len(results) else 1


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', default='wss://127.0.0.1:8443/ws')
    ap.add_argument('--json')
    sys.exit(asyncio.run(main(ap.parse_args())))
