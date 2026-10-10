# G1 Theatre: the visual system as implemented

Source of truth for the rules: [`docs/ui/05_design_direction.md`](../../docs/ui/05_design_direction.md). This file
records what the code does (`css/tokens.css`, `css/app.css`) and where it differs.

The mood is a quiet clinical instrument: neutral surfaces with a slight blue-grey bias, one semantic colour per state,
large system type, and nothing lit or moving unless it means something ("dark cockpit"). The only saturated objects
at rest are the red **STOP** and the mode ribbon.

## Colour tokens

All colours are CSS custom properties on `:root` (Light) and `:root[data-theme="dim"]` (Theatre dim). The theme is
set before first paint from `localStorage`, and the `<html>` background is written inline, so dim never flashes white.
Theme changes cross-fade over 300 ms.

| Token | Light | Theatre dim | Use |
|---|---|---|---|
| `--bg` | #F4F6F8 | #07090C | page |
| `--surface` / `-2` / `-3` | #FFFFFF / #EEF1F4 / #E3E8ED | #10141A / #171C24 / #1E2530 | cards / wells, idle rail items / pressed |
| `--border` | #C9D1DA | #2A3342 | hairlines (decorative) |
| `--border-strong` | #7F8A97 | #56627A | control outlines (≥ 3:1) |
| `--text` / `--text-2` | #0E1621 / #4A5563 | #D9DEE6 / #8E99A8 | text; dim text is not pure white (glare) |
| `--robot-driving` (+`-soft`, `--fill-robot`) | #1F5FD6 | #6B9BFF (fill #2F63C9) | NAV / AUTO, accent, links |
| `--person-driving` (+`-soft`, `--fill-person`) | #B0307A | #FF7EB6 (fill #A8306F) | LOCO / MANIP, always with stripes + hand icon |
| `--standby` / `--fill-standby` | #516173 | #94A3B8 / #3D4A5B | STAND |
| `--off` | #7A8591 | #6B7686 | DAMP (non-text) |
| `--ok` | #0B7A5C | #3CC59A | OK, passed checks |
| `--alarm-high` / `-fill` | #C81E1E | #FF5A4E / #D92D20 | High alarm, Stop, stopped band |
| `--alarm-med` / `-fill` | #8A4B00 / #F5A524 | #F5A524 | Medium alarm, needs you, link lost |
| `--alarm-low` / `-fill` | #0B6A80 / #2CC5DD | #3FD0E6 | Low alarm |

`--fill-*` exist because the bright dim-theme state colours are for text on dark; white text needs a darker fill
(every white-on-fill pair ≥ 4.8:1). Full contrast table for both themes: `docs/a11y_report.md` (0 failures).

**Colour is never alone.** Every state is colour + icon + word, and the person-driving ribbon adds a 45° stripe
texture (6–14 % white). Red is used only for Stop, the stopped band and High alarms; the Stop button is red but
steady. Flashing is used only for alarms: High 2 Hz (50 % duty) and Medium 0.6 Hz, on the banner only, and it stays
on under reduced motion because it is a safety signal. Low is steady cyan.

Theatre dim: camera images and illustrations at 80 % brightness (`--media-dim`), no large white surfaces, the
across-room view is black, and Stop (#D92D20) is still the brightest red object.

## Type

`-apple-system, system-ui` (SF Pro Text/Display on iPad; no web fonts), `ui-monospace` for technician values,
tabular figures everywhere. Scale from 05 §2, pt = CSS px:

| Token | Size / line | Where |
|---|---|---|
| `display-xl` | 88/96 semibold | across-room status word, clean-screen countdown |
| (display) | 64/72 | across-room activity (spec: 56–64) |
| `hero` | 44/52 | hero status word, readback sentence |
| `title-1` | 34/40 | hero activity, screen titles |
| `title-2` | 28/34 | sheet titles, big values |
| `title-3` | 22/28 | tile titles, "next" line, questions |
| `body` | 17/24 | minimum body text in Clinical |
| `callout` | 15/20 | secondary lines, technician body |
| `caption` | 13/16 | technician metadata and rail labels only |

Sentence case; the only all-caps word is **STOP**. Units after numbers are lighter ("~20 **s**").

## Space, shape, targets

4-pt spacing scale (4, 8, 12, 16, 20, 24, 32, 40, 48). Radii: 20 cards and tiles, 14 buttons, 24 Stop and sheets,
999 pills. Light theme separates with 1-pt hairlines and a very soft shadow; dim uses surface tone only.

| Target | Size |
|---|---|
| Stop | 96 × 120 (landscape rail), 112 × 88 (portrait band); nothing else within 12 pt |
| Clinical tiles | 144 tall, shrinking to the 120 minimum when a tall alarm banner takes height |
| Clinical buttons, chips, segmented controls | ≥ 64 tall (forced for every control in Clinical mode) |
| Slide-to-confirm | 72 track, 64 thumb, 70 % travel |
| Operator controls | ≥ 56 |
| Technician controls | ≥ 44 |
| Joystick | 220, thumb 88 |

Interaction: act on release (click) everywhere except Stop, which acts on `pointerdown`. Slides for Resume, taking
control, starting manual modes, starting a mission; hold 1.5 s for Power off (filling ring, a callout explains what
will happen while held); hold for destructive technician actions (delete map, clear calibration). No double-tap,
pinch or swipe is needed anywhere; the map has +/−/Fit/centre buttons. Text selection, callouts and tap highlight are
off; `touch-action: manipulation`.

## Layout

Landscape (1194 × 834 for iPad Pro 11): nav rail 104 (widened from 88 so "Instruments" fits) · content · safety rail 112; status bar 56, ribbon 64, banners
(auto), content. Home: hero 7 fr / tiles 5 fr, timeline strip below; the hero fits the viewport and the floor plan
takes the remaining height (hidden by a container query if under 110 pt). Operator screens: map/camera left, 340-pt
control column right. Overlays (sheets, across-room, readback) cover content but never the safety rail.

Portrait: status bar · ribbon · banners · content · tab bar 72 · safety band 104 (Stop on the right thumb side;
the left-handed setting mirrors the rail and puts Stop on the left).

## Signature components

- **Safety rail**: STOP (hand glyph + STOP + "Holds still" / "No link"), hardware e-stop heartbeat, manual control
  holder, alarm count (takes the alarm colour), Power off (hold). Identical on every screen and role.
- **Mode ribbon**: family fill, icon, sentence ("Going to Sterile store · 4 m · ~20 s"), "changed by …" (bold for
  5 s after a change), "Controlled by …". The one large motion in the app: a 300 ms left-to-right reveal when the
  family changes.
- **Hero**: status word (OK / Needs you / Stopped / Alarm) + activity + next + progress or request stepper + live
  floor plan (rooms from `hospital-sim-env/isaac/scene/layout.py`, robot dot with heading, destination pin, dotted path). While the link
  is down it switches to "Last known …" and fades the plan.
- **Readback card**: kicker, 44-pt sentence, "The robot says this out loud", 72-pt Undo with a 3-s ring and
  countdown; ends as "Sent to the robot" or "Not sent: …" in amber. A soft scrim dims the content behind it.
- **Tiles**: icon in a tinted square, 22-pt title, one line that turns into the reason when blocked.
- **Across-room**: black (dim) or white, status 88 pt, activity 64, next 40, arc + ETA; first tap only wakes.
- **Alarm banner**: what (22 pt) · do · "Who: …", Acknowledge (white on fill), Send to technician, All alarms.
- **Proximity strip** (Arms): three segments over the top of the robot view, green "clear" / distance, amber "close" < 1 m, red "very close" < 0.5 m, always with the word and the distance.
- **Release steps** (Arms held): a two-step list with a coloured left rule (magenta = current step, green = done); the release slide stays disabled until the pose-match step is confirmed.

## Motion

Screen push 220 ms (12-pt rise + fade), sheets 220 ms, readback 160 ms scale-in, ribbon reveal 300 ms, theme
cross-fade 300 ms, across-room 400 ms fade. Nothing animates at rest except alarm flashing and the link-lost spinner.
`prefers-reduced-motion`: fades only; alarm flashing stays.

## Sound

Web Audio earcons, 500–1000 Hz sine + a quiet octave: High = 10 pulses (3+2, pause, 3+2) every 10 s until
acknowledged, Medium = 3 rising pulses every 30 s, Low = two soft notes once, plus "arrived" and "done". High plays
on every iPad; Medium/Low only on the iPad with manual control, or on all when nobody has control. The robot speaker
is the primary channel. Readbacks are spoken with `speechSynthesis` when "iPad speaks readbacks" is on (default on).
No haptics (iOS Safari has none).

## Icons

One outline set (24-unit grid, 2-unit stroke, round joins) drawn for this app in `js/icons.js`, including the custom
robot-arrow, robot-hand, hand-walk, hand-arm, hand-stop and handover glyphs. Instrument illustrations are simple line
drawings in `js/data.js`.

## Copy

Plain and active, people and places named ("Stopped by you (this iPad)", "Going to Theatre 1"), alarms as
what · do · who, server refusal codes mapped to plain words, raw FSM names and topic paths only in Technician views.

## Deviations from 05

- Nav rail: 6 items for Operator and 7 for Technician (05 says at most 5). Clinical has exactly 5. Operators reach
  Places/Instruments/Checks/Status from Home; technicians get one "System" screen with tabs instead of six rail items.
- The Stop button is 96 × 120 rather than 96 × 112 so the "Holds still" line fits at 12 pt.
- Help is a sheet from the status bar rather than a rail item (to keep Clinical at 5).
- Occupancy colour in Light is #56606E (softer than the text colour) so SLAM maps read as calm grey shapes.
- Across-room activity is 64 pt (the upper end of 56–64) because it is the most-read line.
