"""Map + waypoint storage for the dashboard (map_server-compatible pgm/yaml files).

Maps live in ros2_ws/src/hospital-sim-ros2/g1_navigation/maps/:
    <name>.yaml / <name>.pgm         map_server format (trinary, 0.65 / 0.25 thresholds)
    <name>.posegraph / <name>.data   slam_toolbox serialized pose graph (optional, to continue mapping)
    <name>.waypoints.json            named waypoint routes for that map (dashboard "tasks")
"""
import io
import json
import os
import re
import time

import numpy as np
from PIL import Image

NAME_RE = re.compile(r'^[A-Za-z0-9_.\-]{1,64}$')


def sanitize(name):
    name = (name or '').strip().replace(' ', '_')
    if name.endswith('.yaml'):
        name = name[:-5]
    if not NAME_RE.match(name) or name.startswith('.'):
        raise ValueError('map name must be 1-64 chars of letters, digits, _ . -')
    return name


def grid_to_array(width, height, data):
    """OccupancyGrid data (row-major, row 0 = bottom) -> int8 array (h, w)."""
    return np.asarray(data, dtype=np.int8).reshape(height, width)


def encode_grid_png(arr):
    """int8 occupancy (h, w; row 0 = bottom) -> PNG bytes, grayscale, row 0 = top.
    Pixel value: 0..100 = occupancy probability, 255 = unknown. The browser colours it by theme."""
    a = arr.astype(np.int16)
    img = np.where(a < 0, 255, np.clip(a, 0, 100)).astype(np.uint8)[::-1]
    buf = io.BytesIO()
    Image.fromarray(img, mode='L').save(buf, format='PNG', optimize=False, compress_level=6)
    return buf.getvalue()


def save_map(maps_dir, name, arr, resolution, origin_xy_yaw, source=''):
    """Write <name>.pgm/.yaml the way nav2 map_saver does (trinary)."""
    name = sanitize(name)
    os.makedirs(maps_dir, exist_ok=True)
    a = arr.astype(np.int16)
    img = np.full(a.shape, 205, dtype=np.uint8)  # unknown
    img[(a >= 0) & (a <= 25)] = 254               # free
    img[a >= 65] = 0                              # occupied
    img = img[::-1]
    h, w = img.shape
    base = os.path.join(maps_dir, name)
    with open(base + '.pgm', 'wb') as f:
        f.write(b'P5\n# CREATOR: g1 dashboard %.3f m/pix\n%d %d\n255\n' % (resolution, w, h))
        f.write(img.tobytes())
    ox, oy, oyaw = origin_xy_yaw
    with open(base + '.yaml', 'w') as f:
        f.write(f'# saved by the G1 dashboard from {source or "/map"} at '
                f'{time.strftime("%Y-%m-%d %H:%M:%S")}\n')
        f.write(f'image: {name}.pgm\nmode: trinary\nresolution: {resolution:.6g}\n')
        f.write(f'origin: [{ox:.4f}, {oy:.4f}, {oyaw:.4f}]\n')
        f.write('negate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.25\n')
    return base + '.yaml'


def _parse_yaml(path):
    """Tiny parser for map_server yaml (avoids a PyYAML dependency on odd formats)."""
    out, comments = {}, []
    with open(path) as f:
        for line in f:
            s = line.strip()
            if s.startswith('#'):
                comments.append(s)
                continue
            if ':' not in s:
                continue
            k, v = s.split(':', 1)
            out[k.strip()] = v.strip()
    out['_comments'] = comments
    return out


def read_pgm(path):
    with open(path, 'rb') as f:
        data = f.read()
    img = Image.open(io.BytesIO(data))
    return np.array(img.convert('L'))


def list_maps(maps_dir):
    maps = []
    if not os.path.isdir(maps_dir):
        return maps
    for fn in sorted(os.listdir(maps_dir)):
        if not fn.endswith('.yaml'):
            continue
        path = os.path.join(maps_dir, fn)
        try:
            y = _parse_yaml(path)
            img_path = os.path.join(maps_dir, y.get('image', ''))
            w = h = None
            if os.path.isfile(img_path):
                with Image.open(img_path) as im:
                    w, h = im.size
            name = fn[:-5]
            maps.append({
                'name': name,
                'yaml': path,
                'resolution': float(y.get('resolution', 0.05)),
                'width': w, 'height': h,
                'ground_truth': any('GROUND-TRUTH' in c for c in y['_comments']),
                'has_posegraph': os.path.isfile(os.path.join(maps_dir, name + '.posegraph')),
                'mtime': os.path.getmtime(path),
                'preview': f'/api/maps/{name}.png',
            })
        except Exception as e:  # a broken yaml should not hide the others
            maps.append({'name': fn[:-5], 'error': str(e)})
    return maps


def map_preview_png(maps_dir, name, theme='light'):
    name = sanitize(name)
    y = _parse_yaml(os.path.join(maps_dir, name + '.yaml'))
    img = read_pgm(os.path.join(maps_dir, y['image']))
    if theme == 'dark':
        lut = np.zeros(256, dtype=np.uint8)
        lut[:] = 40
        lut[250:] = 70
        lut[:60] = 220
        rgb = lut[img]
    else:
        rgb = img
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format='PNG')
    return buf.getvalue()


def load_map_array(maps_dir, name):
    """Return (int8 occupancy array row0=bottom, resolution, origin) for a saved map."""
    name = sanitize(name)
    y = _parse_yaml(os.path.join(maps_dir, name + '.yaml'))
    img = read_pgm(os.path.join(maps_dir, y['image'])).astype(np.int16)
    negate = y.get('negate', '0').strip() in ('1', 'true')
    p = (img if negate else 255 - img) / 255.0
    occ = float(y.get('occupied_thresh', 0.65))
    free = float(y.get('free_thresh', 0.25))
    arr = np.full(img.shape, -1, dtype=np.int8)
    arr[p > occ] = 100
    arr[p < free] = 0
    origin = [float(v) for v in y['origin'].strip('[]').split(',')]
    return arr[::-1].copy(), float(y['resolution']), origin


# ---------------------------------------------------------------- waypoints / tasks
def _wp_path(maps_dir, map_name):
    return os.path.join(maps_dir, sanitize(map_name) + '.waypoints.json')


def load_routes(maps_dir, map_name):
    p = _wp_path(maps_dir, map_name)
    if not os.path.isfile(p):
        return {}
    with open(p) as f:
        return json.load(f).get('routes', {})


def save_route(maps_dir, map_name, route_name, poses):
    route_name = sanitize(route_name)
    routes = load_routes(maps_dir, map_name)
    clean = []
    for p in poses:
        clean.append({'x': float(p['x']), 'y': float(p['y']), 'yaw': float(p.get('yaw', 0.0)),
                      'label': str(p.get('label', ''))[:40]})
    routes[route_name] = clean
    with open(_wp_path(maps_dir, map_name), 'w') as f:
        json.dump({'map': map_name, 'routes': routes}, f, indent=1)
    return routes


def delete_route(maps_dir, map_name, route_name):
    routes = load_routes(maps_dir, map_name)
    routes.pop(route_name, None)
    with open(_wp_path(maps_dir, map_name), 'w') as f:
        json.dump({'map': map_name, 'routes': routes}, f, indent=1)
    return routes
