"""Data the iPad app needs (hospital-sim-ui/PROTOCOL.md v2): named places with display metadata, the instrument catalogue with rack
state, and the speed zones. Sources: ros2_ws/src/hospital-sim-ros2/g1_mission/config/{locations,instruments}.yaml (generated),
hospital-sim-env/objects/catalog.json (rack slots, world poses), /sim/objects (ground truth, sim only) and the display overlays in
hospital-sim-ui/server/config/{places,instruments}.yaml."""
import math
import os

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get('HG1_ROOT') or os.path.dirname(os.path.dirname(HERE))
MISSION_CFG = os.path.join(ROOT, 'ros2_ws', 'src', 'hospital-sim-ros2', 'g1_mission', 'config')
ZONES = os.path.join(ROOT, 'ros2_ws', 'src', 'hospital-sim-ros2', 'g1_teleop_manager', 'config', 'zones.yaml')
OBJ_CATALOG = os.path.join(ROOT, 'hospital-sim-env', 'objects', 'catalog.json')
ALL_ROLES = ['clinical', 'operator', 'technician']


def _yaml(path):
    try:
        with open(path) as f:
            return yaml.safe_load(f) or {}
    except OSError:
        return {}


def load_places(locations=None, overlay=None):
    locs = _yaml(locations or os.path.join(MISSION_CFG, 'locations.yaml')).get('locations', {})
    ov = _yaml(overlay or os.path.join(HERE, 'config', 'places.yaml'))
    dflt = ov.get('defaults', {})
    meta = ov.get('places', {}) or {}
    out = []
    for pid, loc in locs.items():
        m = {**dflt, **(meta.get(pid) or {})}
        out.append(_place(pid, pid, loc, m))
    for pid, m in (ov.get('extra', {}) or {}).items():
        target = m.get('alias_of')
        if target in locs:
            out.append(_place(pid, target, locs[target], {**dflt, **m}))
    order = {k: i for i, k in enumerate(list(meta) + list(ov.get('extra', {}) or {}))}
    out.sort(key=lambda p: order.get(p['id'], 999))
    return out


def _place(pid, target, loc, m):
    roles = m.get('allowed_roles', ['operator', 'technician'])
    if roles == 'all':
        roles = list(ALL_ROLES)
    return {'id': pid, 'location': target, 'name': m.get('name') or pid.replace('_', ' ').capitalize(),
            'room': m.get('room', ''), 'icon': m.get('icon', 'pin'), 'kind': m.get('kind', 'place'),
            'x': loc.get('x'), 'y': loc.get('y'), 'yaw': loc.get('yaw'), 'allowed_roles': roles,
            'note': loc.get('note', ''), 'hidden': bool(m.get('hidden', False))}


def places_for(places, role):
    return [dict(p, allowed=role in p['allowed_roles']) for p in places if not p['hidden'] or role == 'technician']


def load_instruments():
    cat = _yaml(os.path.join(MISSION_CFG, 'instruments.yaml')).get('instruments', {})
    ov = _yaml(os.path.join(HERE, 'config', 'instruments.yaml')).get('instruments', {}) or {}
    world = {}
    try:
        import json
        with open(OBJ_CATALOG) as f:
            oc = json.load(f)
        world = oc.get('world_poses', {})
    except (OSError, ValueError):
        pass
    out = {}
    for iid, e in cat.items():
        m = ov.get(iid, {}) or {}
        out[iid] = {'id': iid, 'name': m.get('name') or iid.replace('_', ' ').capitalize(),
                    'desc': e.get('desc', ''), 'slot': e.get('rack_slot'), 'standin': bool(e.get('standin')),
                    'handle_first': m.get('handle_first', True),
                    'home': (world.get(iid) or {}).get('pos')}
    return out


def instrument_state(catalog, objects, mission=None, rack_tol=0.06):
    """Merge the catalogue with /sim/objects ground truth (sim) and the mission's current target."""
    mission = mission or {}
    cur = mission.get('instrument') if mission.get('state') in ('running', 'paused') else None
    out = []
    for iid, e in catalog.items():
        o = (objects or {}).get(iid)
        held = None
        on_rack = None
        if o is not None:
            if o.get('held_by'):
                held = o['held_by']
                on_rack = False
            elif e['home'] is not None and o.get('pose'):
                p = o['pose']
                on_rack = math.dist(p[:3], e['home']) < rack_tol
        if held is None and iid == cur and on_rack is False:
            held = 'robot'
        rc = None if on_rack is None else int(bool(on_rack) and held is None)
        out.append({'id': iid, 'name': e['name'], 'desc': e['desc'], 'slot': e['slot'], 'standin': e['standin'],
                    'on_rack': rc, 'rack_count': rc, 'held_by': held,
                    'available': rc is None or rc > 0, 'source': 'ground_truth' if o is not None else 'catalogue'})
    return out


def load_zones(path=None):
    z = _yaml(path or ZONES)
    return {'frame': z.get('frame', 'map'), 'manual_cap': z.get('manual_cap'),
            'zones': [{'name': q['name'], 'cap': q['max_speed'], 'polygon': q['polygon']} for q in z.get('zones', [])]}


def readback_instrument(inst, requester='surgeon'):
    first = ', handle first' if inst.get('handle_first', True) else ''
    return f"{inst['name']} → {requester}{first}", f"{inst['name']}, coming."
