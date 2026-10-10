"""G1 dashboard server: one process = rclpy node + aiohttp (HTTP, WebSocket, MJPEG).

    source env.sh
    python hospital-sim-ui/server                 # against the sim / real robot
    python hospital-sim-ui/server --mock          # also starts hospital-sim-ui/tools/mock_robot.py (fake robot, no sim needed)

Serves the iPad app (hospital-sim-ui/app) at / and the engineering console (hospital-sim-ui/web) at /console/:
  https://<host>:8443  (TLS, when hospital-sim-ui/server/tls/out/server.{crt,key} exist: hospital-sim-ui/server/tls/make_cert.sh)
  http://127.0.0.1:8080 (plain HTTP, loopback only by default: localhost development; the console on the robot PC
                         gets the --localhost-role there)
"""
import argparse
import asyncio
import logging
import signal
import ssl
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
UI_DIR = os.path.dirname(HERE)
ROOT = os.environ.get('HG1_ROOT') or os.path.dirname(UI_DIR)
if UI_DIR not in sys.path:
    sys.path.insert(0, UI_DIR)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(prog='hospital-sim-ui/server', description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--host', default='0.0.0.0', help='HTTPS bind address')
    ap.add_argument('--port', type=int, default=8080, help='plain HTTP port')
    ap.add_argument('--http-host', default=None,
                    help='plain HTTP bind address (default 127.0.0.1 when TLS is available, else --host)')
    ap.add_argument('--https-port', type=int, default=8443)
    ap.add_argument('--tls-dir', default=os.path.join(HERE, 'tls', 'out'),
                    help='server.crt + server.key (made by hospital-sim-ui/server/tls/make_cert.sh)')
    ap.add_argument('--no-tls', action='store_true', help='plain HTTP only')
    ap.add_argument('--localhost-role', default='technician', choices=['clinical', 'operator', 'technician'],
                    help='role of clients on http://127.0.0.1 (the console on the robot PC; development)')
    ap.add_argument('--auth-config', default=os.path.join(HERE, 'config', 'auth.yaml'))
    ap.add_argument('--app-dir', default=os.path.join(UI_DIR, 'app'))
    ap.add_argument('--undo-s', type=float, default=3.0, help='undo window for send-to / instrument requests')
    ap.add_argument('--data-dir', default=HERE,
                    help='where audit/, incidents/ and data/ live (default hospital-sim-ui/server; use a separate one per instance)')
    ap.add_argument('--mock', action='store_true',
                    help='start hospital-sim-ui/tools/mock_robot.py as a child process (fake robot + mode manager)')
    ap.add_argument('--mock-arg', action='append', default=[], dest='mock_args',
                    help='extra argument passed to mock_robot.py (repeatable)')
    ap.add_argument('--use-sim-time', default='true', choices=['true', 'false'],
                    help='use /clock (sim) for this node and for SLAM / Nav2 stacks it starts')
    ap.add_argument('--maps-dir', default=os.path.join(ROOT, 'ros2_ws', 'src', 'hospital-sim-ros2', 'g1_navigation', 'maps'))
    ap.add_argument('--web-dir', default=os.path.join(UI_DIR, 'web'))
    ap.add_argument('--base-frame', default='pelvis')
    ap.add_argument('--key-repeat-ms', type=int, default=250,
                    help='browser re-sends a held movement key this often (manager timeout is 500 ms)')
    ap.add_argument('--log-level', default='info')
    ap.add_argument('--exit-with-parent', action='store_true',
                    help='shut down (and stop the stacks) when the parent process dies (used by dashboard.launch.py)')
    # ros2 launch appends --ros-args ...; ignore everything after it
    if argv is None:
        argv = sys.argv[1:]
    if '--ros-args' in argv:
        argv = argv[:argv.index('--ros-args')]
    a = ap.parse_args(argv)
    a.use_sim_time = a.use_sim_time == 'true'
    a.mock_script = os.path.join(UI_DIR, 'tools', 'mock_robot.py')
    a.ui_dir = UI_DIR
    crt, key = os.path.join(a.tls_dir, 'server.crt'), os.path.join(a.tls_dir, 'server.key')
    a.tls_ready = (not a.no_tls) and os.path.isfile(crt) and os.path.isfile(key)
    a.tls_files = (crt, key)
    if a.http_host is None:
        a.http_host = '127.0.0.1' if a.tls_ready else a.host
    return a


async def serve(app, opts):
    from aiohttp import web
    runner = web.AppRunner(app, handle_signals=False, shutdown_timeout=5.0)
    await runner.setup()
    await web.TCPSite(runner, opts.http_host, opts.port).start()
    if opts.tls_ready:
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.load_cert_chain(*opts.tls_files)
        await web.TCPSite(runner, opts.host, opts.https_port, ssl_context=ctx).start()
    else:
        logging.getLogger('g1_dashboard').warning(
            'no TLS certificate (%s): plain HTTP only. Run hospital-sim-ui/server/tls/make_cert.sh for the iPad.', opts.tls_dir)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        await runner.cleanup()


def main():
    opts = parse_args()
    logging.basicConfig(level=getattr(logging, opts.log_level.upper(), logging.INFO),
                        format='[%(asctime)s] %(levelname)s %(name)s: %(message)s')
    logging.getLogger('aiohttp.access').setLevel(logging.WARNING)
    import rclpy
    from aiohttp import web
    from server.app import Dashboard
    from server.bridge import RosBridge

    rclpy.init(args=None)
    dash = Dashboard(opts)
    dash.bridge = RosBridge(opts, dash.emit, dash.log)
    dash.bridge.start()
    app = dash.make_app()
    try:
        asyncio.run(serve(app, opts))
    except KeyboardInterrupt:
        pass
    finally:
        dash.bridge.shutdown()
        try:
            dash.bridge.destroy_node()
            rclpy.try_shutdown()
        except Exception:
            pass


if __name__ == '__main__':
    main()
