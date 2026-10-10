# G1 dashboard WebSocket protocol (v1 + v2)

This document is the WebSocket protocol between the UI server and the browsers. The engineering console
(`hospital-sim-ui/web`, served at `/console/`) speaks v1, described first. The iPad app (`hospital-sim-ui/app`,
served at `/`) speaks v2 (section [v2](#v2)). v2 adds sessions, roles, the control lease, hold-stop, alarms,
undo, places, instruments, checks, handover and incidents. v2 is a superset: every v1 message and op still
exists, but every op now goes through the role allow-list.

The transport is one WebSocket at `ws://<host>:8080/ws` with JSON text frames. The server is
`hospital-sim-ui/server` (the rclpy node `g1_dashboard` + aiohttp in one process). The plain HTTP endpoints are
listed at the end.

## Server → browser

Every message has a `type`.

| type | when | fields |
|---|---|---|
| `hello` | on connect | `protocol` (1), `mock`, `use_sim_time`, `maps_dir`, `modes` ({0:"DAMP",…}), `transitions` (legal targets per mode), `keys` (contract keys → description), `teleop_keys` (c/f/h/u of the camera teleop node), `limits` ({vx:[-0.5,0.8], vy:[-0.4,0.4], wz:[-1,1]}), `key_repeat_ms`, `base_frame`, `nav2`, `g1_interfaces` |
| `logs` | on connect | `entries`: last 400 `log` messages |
| `mode` | on every `/g1/mode` message (latched) | `mode` (uint8), `name`, `source`, `detail`, `stamp` |
| `state` | 2 Hz (and on connect) | see below |
| `pose` | 10 Hz | `frame` (`map` if map→pelvis exists, else `odom`), `x`, `y`, `yaw`, `vx`, `vy`, `wz` (body-frame twist from `/odom`) |
| `scan` | 5 Hz | `frame` (same as pose), `pts`: flat `[x0,y0,x1,y1,…]` of the latest `/scan` projected into that frame, ≤540 points, cm precision |
| `map` | when `/map` changes (≤1 Hz) and on connect | `frame`, `width`, `height`, `resolution`, `origin` [x,y,yaw], `version`, `png`: base64 8-bit grayscale PNG, **row 0 = top (max y)**, pixel = occupancy 0..100, 255 = unknown |
| `path` | when `/plan` changes (≤2 Hz) | `frame`, `pts`: [[x,y],…] (≤400 points), `stamp` |
| `log` | as they happen | `t` (unix s), `level` (debug/info/warn/error), `src`, `msg` |
| `toast` | notable events (for example navigation finished) | `level`, `msg` |
| `mission` | every `/g1/mission/status` message (5 Hz) and on connect | the g1_mission status JSON as is: `state` (idle\|running\|paused\|succeeded\|failed\|aborted), `step` (running tree node), `instrument` (current target or null), `tree` [{`name`, `status` RUNNING\|SUCCESS\|FAILURE\|IDLE, `depth`, `type`, `message`}], `message`, `kind` (scrub_nurse \| goto:<loc>), `queue`, `instruments`, `instrument_info` {name: {desc, standin, handle_z}}, `locations`, `mode`, `station_error` [dx m, dy m, dyaw deg] or null, `history` [{instrument, success, duration, message}], `counts` {ok, failed}, `recording`, `sources` {objects, surgeon, base} |
| `result` | reply to a request that carried an `id` | `id`, `op`, `ok`, `message`, `data` |

The `state` fields are:
```
mode        latest Mode (as in the `mode` message) or null
controller  JSON of /g1/controller/status (object) or null
tracking    JSON of /g1/teleop/tracking_status (contract keys + extras: framing_detail, calibrated,
            latency_ms, confidence{left,right:{arm,hand,arm_state,hand_state}}, ptz{yaw_right_deg,
            pitch_up_deg,zoom}, message) or null
manager     JSON of /g1/teleop/manager_status (cmd_vel, last_key, last_message, …) or null
sim         JSON of /sim/status (sim_time, rtf, …) or null
battery     {soc, voltage, current, source} from sensor_msgs/BatteryState /battery_state or
            unitree_hg/BmsState /lf/bmsstate; null if neither is published
temps       {max, hottest, joints[29], voltage} from /lowstate motor temperatures (2 Hz); null if
            absent or all zero (the MuJoCo sim does not model temperatures)
amcl        {x, y, yaw, std_xy} from /amcl_pose or null
stacks      {slam|nav|mock: {state: stopped|starting|running|stopping|failed|external, pid, since,
            args, exit_code, cmd}}   ("external" = the nodes exist but were not started by the dashboard)
nav         {state: idle|sending|active|paused|canceling|succeeded|canceled|aborted|rejected|failed,
            kind: goal|waypoints, goal, waypoints[], index, feedback{distance_remaining, eta,
            recoveries, elapsed}, message, server_ready}
active_map  name of the saved map loaded into map_server, or null
topics      {topic: seconds since the last message} for the topics above (+ "camera")
camera      {fps, age}
mission_link {status_age (s since the last /g1/mission/status, null if never), request_service (bool),
            head_camera {fps, viewers, age, subscribed, size [w,h]}, detections_age}
services    {set_mode, navigate, g1_interfaces}  (availability)
nodes       ROS node names in the graph
```

## Browser → server

The browser sends `{"op": "<name>", "id": <optional int>, ...args}`. If the request carries an `id`, the server
replies with a `result`. The browser normally sends the high-rate ops (`key`, `cmd_vel`) without `id`. The
table lists the ops.

| op | args | effect |
|---|---|---|
| `ping` | – | `result` with `data.t` |
| `set_mode` | `mode`: int or name | calls `g1_interfaces/srv/SetMode` on `/g1/set_mode` with `source="ui"`; result carries the manager's `accepted`/`message` (rejections are shown as toasts) |
| `estop` | – | publishes key `x` + zero `/g1/cmd_vel_teleop`, cancels Nav2, then SetMode(DAMP) |
| `key` | `key`: one of r l w s a d q e space p m n g x (contract) or c f h u (camera teleop node) | publishes `std_msgs/String` on `/g1/teleop/key` |
| `cmd_vel` | `vx`, `vy`, `wz` | clamped to the contract limits, published on `/g1/cmd_vel_teleop` (the manager uses it in LOCO; latest source wins, 0.5 s timeout) |
| `initial_pose` | `x`, `y`, `yaw` | `PoseWithCovarianceStamped` on `/initialpose` (frame `map`, σxy 0.25 m, σyaw 15°) |
| `nav_goal` | `x`, `y`, `yaw` | ensures mode NAV (SetMode, fails if the manager rejects), then `nav2_msgs/NavigateToPose` on `/navigate_to_pose` |
| `nav_waypoints` | `poses`: [{x,y,yaw}], `start` (index) | ensures NAV, then `nav2_msgs/FollowWaypoints` on `/follow_waypoints` |
| `nav_pause` | – | cancels the Nav2 goal but remembers it (and the waypoint index) |
| `nav_resume` | – | re-sends the remembered goal / remaining waypoints |
| `nav_cancel` | – | cancels and forgets |
| `stack_start` | `stack`: `slam` \| `nav` \| `mock`; for `nav` optional `map` (saved map name) | `ros2 launch g1_navigation slam.launch.py` / `nav.launch.py map:=…` (map_server + AMCL + Nav2) or `nav.launch.py slam:=true` (Nav2 on the live SLAM map) as a managed subprocess |
| `stack_stop` | `stack` | SIGINT to the launch's process group, SIGTERM after 8 s, SIGKILL after 12 s |
| `map_save` | `name` | writes the latest `/map` as `<maps_dir>/<name>.pgm/.yaml` (map_saver format, trinary 0.65/0.25) and asks slam_toolbox to serialize its pose graph (best effort) |
| `maps_list` | – | `data.maps`: [{name, yaml, resolution, width, height, ground_truth, has_posegraph, mtime, preview}] |
| `map_load` | `name` | if AMCL navigation is running: `nav2_msgs/LoadMap` on `/map_server/load_map`; else starts `nav` with that map |
| `map_delete` | `name` | deletes the map files (+ pose graph, waypoint routes) |
| `routes_list` | `map` | `data.routes`: {route_name: [{x,y,yaw,label}]} |
| `route_save` | `map`, `name`, `poses` | stores a named waypoint route in `<maps_dir>/<map>.waypoints.json` |
| `route_delete` | `map`, `name` | |
| `get_map` | – | re-sends the current `map` message to this client |
| `mission_command` | `command`: `start` \| `abort` \| `pause` \| `resume` \| `reset` \| `clear_queue` \| `goto:<location>` | published on `/g1/mission/command` (fails if no mission status has been received) |
| `mission_request` | `instrument` | `g1_interfaces/RequestInstrument` on `/g1/mission/request_instrument` (requester `ui`); the mission's answer (accepted, message) is the result; a request starts the mission when it is idle |

The server publishes a zero `/g1/cmd_vel_teleop` when the last browser disconnects. The browser sends movement
keys and joystick commands only while the mode is LOCO. It re-sends a held key every `key_repeat_ms` (the mode
manager key timeout is 0.5 s), and it sends `space` when all movement keys are released. The mode manager
remains the authority for every transition.

## HTTP

The table lists the v1 HTTP endpoints.

| path | |
|---|---|
| `GET /` | v1: the console, now at `/console/` (see v2 HTTP below) |
| `GET /ws` | WebSocket |
| `GET /stream/camera.mjpg` | MJPEG (`multipart/x-mixed-replace`) of `/g1/teleop/camera/annotated/compressed` |
| `GET /api/camera/snapshot.jpg` | latest camera frame (404 if none) |
| `GET /stream/head_camera.mjpg` | MJPEG of the robot head RGB camera `/g1/head_camera/image_raw` (≤10 fps, JPEG q80). The server subscribes only while at least one stream is open (and unsubscribes 5 s after the last one closes), because the sim renders the camera only while subscribed. Overlay: the mission's target instrument projected from sim ground truth (amber, labelled "GT overlay = sim cheat"; other instruments thin grey) and detections from `/g1/perception/detections` drawn as oriented boxes (green; `bbox_obb` = `[cx, cy, w, h, angle_deg]` in pixels, w = long side, angle in degrees in [0, 180)) |
| `GET /api/head_camera/snapshot.jpg` | latest head-camera frame (404 until a stream has been opened) |
| `GET /api/maps/<name>.png?theme=light\|dark` | preview of a saved map |
| `GET /api/health` | `{ok, clients, stacks, topics}` |

---

<a id="v2"></a>
# v2: implemented (2026-09-30; it was "v2: draft" earlier the same day)

v2 is implemented in `hospital-sim-ui/server` (`v2.py`, `auth.py`, `alarms.py`, `audit.py`, `pending.py`,
`incidents.py`, `catalog.py`, `checks.py`) and in `g1_teleop_manager`. The executable specification is
`hospital-sim-ui/tools/v2_check.py` (50 checks, mock robot) and `hospital-sim-ui/tools/sim_hold_check.py`
(MuJoCo simulator). The unit tests are in `hospital-sim-ui/server/tests/`.

The implementation differs from the draft in four points:

- `alarm_ack` takes `alarm_id` (not `id`, which is the request id);
- the server `hello` also carries `session`;
- v2 clients must hold the lease for manual ops (`code:"need_lease"`);
- `set_mode` HOLD/DAMP and `key` o/x are routed to `stop`/`power_off`.

The design brief is `docs/ui/README.md` decisions 1 to 5, 9, 10 and 13 to 15; `docs/ui/04` sections 3, 5, 7
and 10; and `docs/ui/02`.

## Transport

The table lists the v2 transport URLs.

| URL | What |
|---|---|
| `https://<host>:8443/` | iPad app (`hospital-sim-ui/app/`); `/console/` = engineering console (`hospital-sim-ui/web/`) |
| `wss://<host>:8443/ws` | WebSocket (same JSON frames as v1) |
| `http://127.0.0.1:8080/` | localhost dev only (plain HTTP is bound to loopback unless `--http-host` says otherwise) |
| `GET /tls/ca.crt` | the local CA certificate to install on the iPad (public; see hospital-sim-ui/README.md) |

## Session and roles

The roles are `clinical` < `operator` < `technician`. Each role includes the ops of the lower ones, except
where the table says otherwise. A new connection starts as clinical (walk-up-and-use). Loopback clients on
plain HTTP (the console on the robot PC) start as `technician` (a development convenience, `--localhost-role`).

The `hello` message of the server (on connect) adds these fields: `session` (the provisional one),
`mode_info`, `roles`, `stop_reasons`, `places` (clinical view), `zones`, `timeline` (last 100 events),
`undo_s` (3), `heartbeat_hz_min` (5), `watchdog_s` (1.0) and `versions` {protocol, server, app (from
`hospital-sim-ui/app/VERSION`), policy, placeholder, map, ros_distro, sim}. In addition, `modes` includes
`6:"HOLD"`, `transitions` includes HOLD, and `keys` includes `o` (stop). The sign-in sequence is:

1. Client → `{"op":"hello","id":1,"protocol":2,"device_id":"ipad-or1-7f3a","device_name":"iPad OR-1","room":"theatre_1","app":"g1-ipad","version":"0.1.0","token":<optional>}`
   - The `device_id` is stable per device: generate it once and keep it in localStorage. The `token` comes
     from an earlier `login`; it restores the role after a reconnect if the session has not idled out.
   - The result `data` is `{session}` (below). The server replies with `hello` on connect regardless (v1 + v2
     fields).
2. `{"op":"login","role":"operator","pin":"123456","user":"R. Kumar"}` → result `data.session`. A wrong PIN
   gives `ok:false` and `data.code:"bad_pin"`. After 5 wrong PINs in 5 min the server answers `code:"locked"`
   for 60 s. `{"op":"badge_login","badge":"04A1B2C3"}` is a stub; the badge ids come from
   `hospital-sim-ui/server/config/auth.yaml`. A technician needs badge and PIN when the configuration says
   `two_factor: true` (the default is false for testing).
3. `{"op":"logout"}` → back to clinical. An idle session (no op other than heartbeat/ping) falls back to
   clinical after 10 min for an operator and after 5 min for a technician. The server then pushes `session`.

`session` (server → client, on every change): `{type:"session", id, token, role, user, device_id, device_name,
room, idle_timeout_s, idle_left_s, allowed_ops:[...], lease_holder:bool}`.

### Per-role op allow-list (enforced by the server; the UI only hides)

For a refused op the server returns
`{"type":"result","ok":false,"message":"… not allowed for role clinical","data":{"code":"forbidden","need":"operator"}}`
and writes the op to the audit log. The table lists the allowed ops per role.

| Op | clinical | operator | technician | notes |
|---|---|---|---|---|
| `hello` `ping` `heartbeat` `login` `badge_login` `logout` | ✓ | ✓ | ✓ | |
| **`stop`** `stop_reason` **`power_off`** (`estop` = v1 alias of power_off) | ✓ | ✓ | ✓ | from any device, lease or not |
| `resume` | ✓ | ✓ | ✓ | slide-to-confirm is the app's job |
| `alarm_ack` `incident_create` `event_log` | ✓ | ✓ | ✓ | |
| `send_to` `cancel_task` `instrument_request` `undo` | ✓ | ✓ | ✓ | place `allowed_roles` also checked |
| `mission_command` `pause` / `abort` | ✓ | ✓ | ✓ | |
| `places_list` `instruments_list` `checks_run` `checks_record` `checks_status` `handover_card` `lease_status` `get_map` `maps_list` `routes_list` `zones_list` | ✓ | ✓ | ✓ | read-only |
| `lease_acquire` `lease_release` `lease_steal` | – | ✓ | ✓ | |
| `set_mode` `key` `cmd_vel` | – | ✓ (lease) | ✓ (lease) | `key` c f h u (camera node) need no lease |
| `nav_goal` `nav_waypoints` `nav_pause` `nav_resume` `nav_cancel` `initial_pose` `map_load` | – | ✓ | ✓ | goals need the lease if someone else holds it |
| `mission_command` (all others: start, resume, goto:…, reset, clear_queue) `mission_request` | – | ✓ | ✓ | |
| `route_save` `route_delete` | – | ✓ | ✓ | |
| `stack_start` `stack_stop` `map_save` `map_delete` | – | – | ✓ | |
| `audit_list` `audit_verify` `incidents_list` `incident_get` `alarm_suppress` `alarm_stats` `logs_get` | – | – | ✓ | |

The lease rule applies in the server and in the mode manager. While a lease is held, only its holder may send
motion: `set_mode` to LOCO/MANIP/NAV/AUTO, movement keys, `cmd_vel`, nav goals, `send_to`,
`instrument_request`, and mission start or resume. Everyone may `stop`, `power_off`, `resume` (to standing)
and acknowledge alarms.

## Control lease (authoritative in g1_teleop_manager, service `/g1/control/lease`)

- `{"op":"lease_acquire","reason":"drive to theatre"}` → ok if the lease is free, or already yours.
- `{"op":"lease_release"}`.
- `{"op":"lease_steal","reason":"R. Kumar left the iPad"}` → always succeeds for operator and above; the
  reason is required. The previous holder gets an `event` + a `toast`. If the robot is in LOCO/MANIP, it goes
  to HOLD, and the new holder must resume deliberately.
- Heartbeat: every client sends `{"op":"heartbeat"}` (no `id`) at 5 Hz or more (the console sends it at
  6.7 Hz). For the lease holder, the server forwards it to the mode manager (`/g1/ui/heartbeat`). If the
  heartbeat of the holder is missing for more than 1.0 s while in LOCO/MANIP, the mode manager goes to HOLD
  (source `watchdog`). It also raises a Medium alarm "Manual control lost. Robot is holding still.". The lease
  itself expires after 30 s without heartbeat.
- The v1 console gets an implicit lease on its first motion op when the lease is free. The server releases it
  when the robot leaves LOCO/MANIP. v2 clients must send `lease_acquire` explicitly.
- `lease` (server → client, on change + in `state.lease`): `{type:"lease", holder: null | {id, device_id,
  device_name, role, user, since, expires_in, implicit}, you: bool}`.

## Modes: HOLD (= "Stopped")

The message `g1_interfaces/Mode` gains `HOLD=6`. `hello.modes` = `{0:"DAMP",…,5:"AUTO",6:"HOLD"}`. The
field `hello.mode_info` gives the plain-language label and the family per mode, as in the table.

| mode | family | label | colour family (05) |
|---|---|---|---|
| DAMP | `off` | Powered down | grey |
| STAND | `standby` | Standing by | slate |
| HOLD | `stopped` | Stopped | red band |
| LOCO | `person` | Manual walking | magenta + stripes + hand icon |
| MANIP | `person` | Manual arms | magenta + stripes + hand icon |
| NAV | `robot` | Driving | blue |
| AUTO | `robot` | Working (task) | blue |

In HOLD the velocity is zero, the arms are frozen where they are (no blend), and the hands keep their command.
The Nav2 goal or the mission is paused and can be resumed. The robot keeps balancing.

Only an explicit resume leaves HOLD. The two resumes are HOLD → STAND and HOLD → AUTO. In HOLD → STAND the arms
blend to rest over 2 s or more. HOLD → AUTO resumes the paused mission, and is allowed only if the robot was in
AUTO when stopped. HOLD → DAMP (power off) is always allowed. Stop in DAMP does nothing.

- Also: `{"op":"set_mode","mode":"HOLD"}` and `{"op":"key","key":"o"}` = stop; `set_mode` DAMP / key `x` = power_off.
  Mode manager keys sent with `key` go to `/g1/teleop/key_ui` with the device identity; the lease rule applies
  in the mode manager too. The camera-node keys c f h u go to `/g1/teleop/key`.
- `{"op":"stop","reason":null}` → send it on pointerdown, with no confirmation. The result is `ok:true` as soon
  as the mode manager accepted (`message` "LOCO -> HOLD"). Stop is never refused, except "already powered off"
  (ok:true).
- `{"op":"stop_reason","reason":"person_in_way"|"wrong_task"|"behaving_oddly"|"other","note":""}` → audit.
- `{"op":"resume","to":"stand"|"task"}` → `stand`: HOLD → STAND. `task`: continue the paused task (mission →
  AUTO + resume; a server-side nav goal → STAND → NAV + re-send). The result `data.did` describes what happened.
- `{"op":"power_off"}` → DAMP (the hold-to-confirm of 1.5 s is the job of the app). It raises the latched High
  alarm "Robot powered down by …".
- `state.hold`: `null` or `{since, source, by (who pressed Stop on a UI: {device_id, device_name, role, user}),
  by_label ("iPad OR-1 (R. Kumar)" / "safety watchdog (controller lost)" / "hardware e-stop" / "robot keyboard"),
  reason, detail, held_from:"AUTO"|"NAV"|…, resume_task:{kind:"mission"|"nav", text:"Continue the instrument task
  (Scalpel)"}|null, resume_blocked: null|"Release the hardware e-stop first"}`.
- `resume` result: `data.did` = what happened ("Standing by (arms return to rest)", the task text).

The mode `source` strings are:

- `ui:<device_id>` (a UI device; its name is in `state.devices`);
- `keyboard`;
- `mission`;
- `watchdog` (UI heartbeat lost);
- `estop_hw` (hardware e-stop pressed or heartbeat lost);
- `lease` (control taken over);
- `safety` (fall);
- `nav`.

## Motion interlocks (`state.motion`)

The field is `{locked: bool, reasons: ["hardware e-stop not seen", …], estop: {ok, pressed, age, dev_override},
zone: {name, cap} | null, link_ok}`. The mode manager refuses the motion modes (LOCO/MANIP/NAV/AUTO) while the
hardware e-stop heartbeat (`/g1/estop/heartbeat`, 10 Hz) is missing or pressed. Pressing the e-stop → HOLD.
The development override (`estop_required:=false`, mode manager parameter `DEV_ONLY_ignore_estop_heartbeat`)
shows as `dev_override:true`. The app must display it.

## Alarms (server-side alarm manager, IEC 60601-1-8 by analogy)

`alarms` (server → client, on every change and on connect):
```
{type:"alarms", active:[{id, code, priority:"high"|"medium"|"low", what, do, who, text (what · do),
  since, latched, condition_active, acknowledged:{by, device, t}|null, silenced_until, tech_code}],
 counts:{high, medium, low}, suppressed:[code…]}
```
- `{"op":"alarm_ack","alarm_id":…}` is allowed for any role (`id` is the request id). A High alarm latches
  until it is acknowledged, even if the condition clears. Medium and Low alarms clear when the condition is
  resolved. An acknowledgement silences a Medium alarm for 2 min; it sounds again if the condition is still
  true.
- `{"op":"alarm_suppress","code":…}` is for technicians, Low alarms only, for the session.
  `{"op":"alarm_stats"}` is for technicians: per code, it counts raised, acknowledged,
  acknowledged-without-action and auto-cleared.
- The initial codes, by priority, are:
  - High: `fall`, `power_off` (latched), `estop_pressed` (latched);
  - Medium: `link_lost`, `manual_control_lost`, `nav_blocked`, `localisation_uncertain`, `grasp_failed`,
    `battery_low_task`, `joint_hot`;
  - Low: `placeholder_policy` (technician only), `battery_low`, `camera_stale`, `no_controller_connected`.
- The robot channels (the primary audible channel) are `/g1/indicator/light` (std_msgs/String JSON
  `{"colour":"red|amber|cyan|blue|magenta|white|off","pattern":"steady|flash_2hz|pulse_0.6hz"}`) and
  `/g1/speech/say` (std_msgs/String). The simulator has log-only stubs.

The timeline (information, not alarms) is `{type:"event", t, kind, text, by}`. The last 100 events are in
`hello.timeline`.

## Closed-loop requests with undo (readback)

The server holds `send_to` and `instrument_request` for 3 s before it dispatches them:

- `{"op":"send_to","place":"theatre_door"}` → result `data.pending` `{id, kind:"send_to", text:"Going to
  Theatre 1", speak, dispatch_at, undo_s:3}`. The robot says the text.
- `{"op":"instrument_request","instrument":"needle_driver","requester":"surgeon"}` → `data.pending` with
  `text:"Needle driver → surgeon, handle first"`.
- `{"op":"undo","pending_id":…}` within the window → cancelled (`pending_done` with `cancelled:true`).
- `pending` / `pending_done` (server → all clients): `{type:"pending", …}`, `{type:"pending_done", id,
  ok, cancelled, message}`.
- `pending` carries `{id, kind, text, speak, by, args, created, dispatch_at, undo_s}`, and `state.pending` lists
  the open ones. The server refuses `send_to` and `instrument_request` (ok:false, plain message) while the
  robot is stopped, powered down or driven by hand. An `instrument_request` with `rack_count 0` →
  `code:"not_on_rack"`; without the mission node → `code:"no_mission"`.
- `{"op":"cancel_task"}` → undoes the pending requests, aborts the mission and cancels the navigation; the
  robot stays standing.
- "Come here" = `send_to` the place of the `room` of the device; "Go to dock" = `send_to` `dock`.

## Data for the app

- `{"op":"places_list"}` → `data.places:[{id, name, room, icon, kind:"place"|"dock"|"standby"|"station",
  x, y, yaw, allowed_roles:[…], allowed:bool}]`. The data comes from `g1_mission/config/locations.yaml` and the
  display overlay `hospital-sim-ui/server/config/places.yaml`. The server also pushes it in `hello.places`.
- `{"op":"instruments_list"}` → `data.instruments:[{id, name, desc, slot, on_rack:0|1, rack_count, held_by:
  null|"robot"|"surgeon", available, standin}]`. The data comes from `hospital-sim-env/objects/catalog.json` and
  `/sim/objects`. The server pushes it as `{type:"instruments", instruments}` when it changes (at most 1 Hz).
- `{"op":"zones_list"}` → speed zones `[{name, cap, polygon:[[x,y]…]}]` in the map frame; the mode manager
  clamps the speed.
- Start-of-day: `{"op":"checks_run"}` → `data:{items:[{id, name, status:"ok"|"warn"|"fail"|"unknown",
  value, fix}], motion_locked, ready}`; `{"op":"checks_record","part":"nurse"|"technician","answers":{…}}`;
  `{"op":"checks_status"}` → the last record of today (`ready_for_today`).
- `{"op":"handover_card"}` → `{since, now, mode, task, lease, trips, instruments_handed:[{name,t}],
  alarms_open, alarms_today, incidents_open, battery, suppressed, notes}`.
- Incident: `{"op":"incident_create","chips":["stuck"],"note":""}` → `data:{id:"INC-0930-07", file}`. The
  server writes a zip of the last 5 min ring buffer to `hospital-sim-ui/server/incidents/`. The buffer holds
  modes, commands, alarms, controller and mode manager status, pose and versions; it holds no images and no
  PHI. Technician ops: `incidents_list`, `incident_get {id}`,
  `GET /api/incidents/<id>.zip?token=<technician token>`.
- Audit (technician): `{"op":"audit_list","limit":200,"before_seq":null}`, `{"op":"audit_verify"}`.

## `state` (2 Hz) additions

The new `state` fields are `hold`, `lease` (the raw mode manager lease state), `motion` `{locked, reasons,
estop, zone, manual_cap, link_ok}`, `devices` ({device_id: {name, room, role, user, connected, heartbeat_age,
v2}}), `session_count`, `pending` and `mission_paused_by_hold`. The `mission` messages carry `paused_by_hold`.

The other server → client types are `session`, `lease`, `alarms`, `event`, `pending`, `pending_done` and
`instruments` (on change). The `event` type is the timeline; its kinds are mode, hold, lease, send_to,
instrument, cancel, checks, incident, stop_reason, and more.

## HTTP (v2 additions)

The table lists the HTTP endpoints that v2 adds.

| path | |
|---|---|
| `GET /` | iPad app (`hospital-sim-ui/app/index.html`; placeholder page until it exists); static files of `hospital-sim-ui/app/` under `/` |
| `GET /console/` | engineering console (`hospital-sim-ui/web/`) |
| `GET /tls/ca.crt` | robot CA certificate (DER) for the iPad |
| `GET /api/incidents/<id>.zip?token=<technician session token>` | incident bundle |
| `GET /api/health` | now also `protocol` |


## v2.1: implemented (2026-09-30, from `hospital-sim-ui/app/NEEDS_FROM_BACKEND.md`)

The table lists the nine additions of v2.1.

| # | What | Shape |
|---|---|---|
| 1 | Handed-instrument times | `handover_card.instruments_handed: [{name, instrument, t (unix s), duration}]`; `mission.history[]` entries also carry `t` |
| 2 | Proximity | `state.proximity` and a `{type:"proximity"}` message at 5 Hz: `{sectors:[left, front, right] (m, null = no return), named:{left,front,right}, order, source:"/scan", age, frame, front_deg:30, side_deg:110}` from the lidar `/scan` (scan frame, x forward). The sim publishes `/scan`; no depth camera is used yet |
| 3 | Gripper override | `{"op":"hand","side":"left"\|"right","close":0..1}`: Operator+, lease rule, audited; **only while stopped (HOLD) or with the arms held in MANIP** (otherwise the camera stream owns the hands): else `ok:false, code:"not_now"`. All six Revo2 DoF are set to `close`. `state.hand_override_allowed` says when the buttons are live |
| 4 | Hold arms inside MANIP | `{"op":"manip_hold","on":true\|false}`: Operator+, lease holder. The robot stays in MANIP; camera-teleop arm/hand streams are not forwarded; the controller freezes the arms at the measured pose (as in HOLD). `on:false` → the arms follow the operator again (at ≤ 1.5 rad/s towards the operator's current pose: ask the user to match the robot first). Any mode change clears it. `state.arms_hold` |
| 5 | Pose in the fixed-base sim | when there is no `map` TF, `pose` uses `/sim/ground_truth` (world = map frame of `hospital_gt`): `{frame:"map", …, source:"sim_ground_truth"}`; scan points follow |
| 6 | Resume text | `state.hold.resume_task.text` = "Continue to Theatre 1 (4 m)" for a `send_to` (mission goto or Nav2 fallback), `place` = place id |
| 7 | Task sentence | `state.task: {text, kind, place, distance, eta, step?, paused_task?, label}`, for example "Going to Theatre 1 · 8 m · ~40 s", "Picking up the needle driver", "Handing the scalpel to the surgeon", "Standing by at Theatre 1", "Manual arms — iPad OR-2 (arms held)", "Stopped by iPad OR-1 (R. Kumar)" |
| 8 | Failed request → alarm | Medium `handover_failed` ("Handover failed: Angled tweezers (Handover: surgeon did not take the instrument). Hand the instrument to the surgeon manually. Scrub nurse.") or `grasp_failed` (pick/locate failures) + `event` kind `task_failed`; a successful request (`event` kind `handed`) clears them |
| 9 | Incident download | `{"op":"incident_link","incident_id":…}` (technician) → `{url:"/api/incidents/<id>.zip?dl=<one-time token>", expires_in:60}`; the token works once. `?token=<session>` still works but is **deprecated** (logged) |

Note: `incident_get` and `incident_link` take `incident_id`, not `id`. The field `id` is the request id; an
`{id}` argument overwrites the request id, and the reply never matches.
