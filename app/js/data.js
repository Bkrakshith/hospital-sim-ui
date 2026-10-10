// Built-in site data, used until the server provides it (v2 `places` / `instruments` ops).
// Rooms: hospital-sim-env/isaac/scene/layout.py (wing-local metres) shifted by WING_ORIGIN (17.93, -4.45) into the map / sim world frame.
// Places: ros2_ws/src/hospital-sim-ros2/g1_mission/config/locations.yaml (same frame). Instruments: g1_mission/config/instruments.yaml.
// No patient data here or anywhere else in the app.

const OX = 17.93, OY = -4.45;
const R = (x0, y0, x1, y1) => [x0 + OX, y0 + OY, x1 + OX, y1 + OY];

export const ROOMS = [
  { id: 'preop', name: 'Pre-op', rect: R(-10, -6, 0, 0), quiet: true },
  { id: 'link', name: 'Link', rect: R(0, -6, 2, 0) },
  { id: 'pacu', name: 'PACU', rect: R(2, -6, 14, 0), quiet: true },
  { id: 'corridor', name: 'Surgical corridor', short: 'Corridor', rect: R(-12, -10, 14, -6) },
  { id: 'store', name: 'Sterile store', short: 'Store', rect: R(-12, -18, -4, -10) },
  { id: 'scrub', name: 'Scrub room', short: 'Scrub', rect: R(-4, -18, 0, -10) },
  { id: 'theatre1', name: 'Theatre 1', rect: R(0, -20, 10, -10), stripe: 1 },
];
// door openings (segments), wing-local -> world
export const DOORS = [
  R(0, 0, 2, 0), R(0, -6, 2, -6), R(-5, -6, -3, -6), R(7, -6, 9, -6), R(-9, -10, -7, -10),
  R(-3, -10, -1, -10), R(7, -10, 9, -10), R(0, -15, 0, -13), R(-4, -15, -4, -13),
];

// Places. `loc` = locations.yaml key (mission goto:<loc>); roles = who may send the robot there.
export const PLACES = [
  { id: 'theatre_instrument_table', name: 'Theatre 1', sub: 'Instrument table · standby', room: 'theatre1', stripe: 1, x: 25.58, y: -20.12, yaw: -1.5708, roles: ['clinical', 'operator', 'technician'], standby: true },
  { id: 'theatre_door', name: 'Theatre 1', sub: 'Just inside the door', room: 'theatre1', stripe: 1, x: 25.93, y: -15.65, yaw: -1.5708, roles: ['clinical', 'operator', 'technician'] },
  { id: 'theatre_surgeon_side', name: 'Theatre 1', sub: 'Surgeon side (operator only)', room: 'theatre1', stripe: 1, x: 23.8, y: -18.25, yaw: -1.5708, roles: ['operator', 'technician'] },
  { id: 'sterile_store', name: 'Sterile store', sub: 'Inside the door', room: 'store', x: 9.93, y: -16.45, yaw: -1.5708, roles: ['clinical', 'operator', 'technician'] },
  { id: 'scrub_room', name: 'Scrub room', sub: 'Inside the door', room: 'scrub', x: 15.93, y: -16.45, yaw: -1.5708, roles: ['clinical', 'operator', 'technician'] },
  { id: 'corridor_theatre', name: 'Corridor', sub: 'Outside Theatre 1', room: 'corridor', x: 25.93, y: -12.45, yaw: -1.5708, roles: ['clinical', 'operator', 'technician'] },
  { id: 'corridor_west', name: 'Dock', sub: 'Corridor, west end', room: 'corridor', x: 8.93, y: -12.45, yaw: 0, roles: ['clinical', 'operator', 'technician'], dock: true },
];
export const DOCK_ID = 'corridor_west';

// Instruments on the tool rack. `kind` picks the illustration. standin = procedural model in the sim.
export const INSTRUMENTS = [
  { id: 'scissors', name: 'Mayo scissors', desc: 'Curved, 190 mm', kind: 'scissors', group: 'Cutting' },
  { id: 'scalpel_handle', name: 'Scalpel', desc: 'Handle with No. 10 blade', kind: 'scalpel', group: 'Cutting', sharp: true },
  { id: 'needle_driver', name: 'Needle driver', desc: 'Stand-in', kind: 'needleDriver', group: 'Suturing', standin: true },
  { id: 'adson_forceps', name: 'Adson forceps', desc: '120 mm · stand-in', kind: 'forceps', group: 'Grasping', standin: true },
  { id: 'angled_tweezers', name: 'Angled tweezers', desc: '160 mm', kind: 'tweezers', group: 'Grasping' },
  { id: 'trocar', name: 'Trocar', desc: 'Laparoscopic', kind: 'trocar', group: 'Access' },
  { id: 'veress_needle', name: 'Veress needle', desc: 'Pneumoperitoneum', kind: 'veress', group: 'Access', sharp: true },
];

// Line illustrations of instruments (72 x 72 viewBox, stroke = currentColor).
export const INSTRUMENT_ART = {
  scissors: '<circle cx="18" cy="52" r="8"/><circle cx="34" cy="58" r="8"/><path d="M23 46L58 12M29 51c10-8 20-22 29-39"/><circle cx="36" cy="33" r="1.8" fill="currentColor"/>',
  scalpel: '<path d="M12 60l30-30"/><path d="M42 30l5-5c4-4 12-9 16-8-1 5-6 12-10 16l-6 2z"/><path d="M16 56l-4 4"/><path d="M20 52l3 3M25 47l3 3M30 42l3 3"/>',
  needleDriver: '<circle cx="16" cy="54" r="7"/><circle cx="30" cy="60" r="7"/><path d="M21 49l34-34M26 55l30-39"/><path d="M55 15l4-5M56 16l5-3"/><path d="M60 8c3 1 4 4 2 6"/>',
  forceps: '<path d="M14 62L40 12c1-2 3-2 4 0l2 4"/><path d="M22 62L44 18"/><path d="M40 12l18 10"/><path d="M26 38l6 3M30 30l6 3"/>',
  tweezers: '<path d="M14 62l30-38 12-12"/><path d="M20 62l28-34 8-3"/><path d="M28 44l5 3"/>',
  trocar: '<rect x="28" y="8" width="16" height="14" rx="4"/><path d="M32 22v34l4 8 4-8V22"/><path d="M24 14h-6M48 14h6"/><path d="M36 30v24"/>',
  veress: '<path d="M36 6v10"/><rect x="29" y="16" width="14" height="12" rx="3"/><path d="M34 28v32l2 6 2-6V28"/><path d="M43 20h8v6"/>',
};

export function placeById(id) { return PLACES.find((p) => p.id === id) || null; }
export function roomAt(x, y) {
  // most specific room containing the point (rooms do not overlap)
  for (const r of ROOMS) { const [x0, y0, x1, y1] = r.rect; if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return r; }
  return null;
}
export function roomById(id) { return ROOMS.find((r) => r.id === id) || null; }
export const WING_BOUNDS = (() => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of ROOMS) { x0 = Math.min(x0, r.rect[0]); y0 = Math.min(y0, r.rect[1]); x1 = Math.max(x1, r.rect[2]); y1 = Math.max(y1, r.rect[3]); }
  return { x0, y0, x1, y1 };
})();

// Plain-language names for the scrub-nurse behaviour tree (g1_mission/tree.py)
export const STEP_WORDS = {
  scrub_nurse: 'Scrub assist',
  EnsureAuto: 'Getting ready',
  ReachStation: 'Going to the instrument table',
  'AtStation?': 'Checking position',
  GoTo: 'Walking',
  ToReady: 'Raising arms to ready',
  FineAlign: 'Lining up at the table',
  Serve: 'Serving requests',
  ServeOrRecover: 'Serving requests',
  ServeOne: 'Serving a request',
  WaitForRequest: 'Ready for a request',
  LocateInstrument: 'Finding the instrument',
  Pick: 'Picking it up',
  ToSurgeon: 'Taking it to the surgeon',
  'SurgeonInReach?': 'Checking the surgeon is in reach',
  CarryToSurgeon: 'Carrying it',
  Carry: 'Holding it close to the body',
  GoToSurgeon: 'Walking to the surgeon side',
  Handover: 'Offering it handle first',
  Retract: 'Moving the hand away',
  ReturnToReady: 'Arms back to ready',
  BackToTable: 'Walking back to the table',
  Done: 'Done',
  Recover: 'Recovering',
  LogFailure: 'Noting the problem',
  RecoverToReady: 'Arms back to ready',
  RecoverToTable: 'Back to the table',
  ReleaseAuto: 'Finishing',
};

// The request stepper the clinical user sees (F3 step 4)
export const REQUEST_STEPS = [
  { id: 'find', label: 'Find', nodes: ['LocateInstrument', 'WaitForRequest'] },
  { id: 'pick', label: 'Pick up', nodes: ['Pick'] },
  { id: 'carry', label: 'Carry', nodes: ['ToSurgeon', 'CarryToSurgeon', 'Carry', 'GoToSurgeon', 'SurgeonInReach?'] },
  { id: 'offer', label: 'Offer', nodes: ['Handover'] },
  { id: 'handed', label: 'Handed', nodes: ['Retract'] },
  { id: 'back', label: 'Back', nodes: ['ReturnToReady', 'BackToTable', 'Done'] },
];
