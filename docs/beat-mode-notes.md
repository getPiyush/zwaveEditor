# Beat mode: session notes

Notes from the chat with Claude on 29 Oct 2026, kept here so the work can be picked up later.

- **Branch:** `beat-mode`
- **Pull request:** https://github.com/getPiyush/zwaveEditor/pull/2 (mergeable into `main`)
- **Status:** built and tested by Claude; waiting on a hands-on test with real speakers

---

## 1. Where the discussion started

The goal is to **make hip hop music with zwaveEditor**, and the first question was where to get beats and chimes.

### Where sounds come from

| Use | Sources | Licence notes |
|---|---|---|
| Sounds for your own tracks | Splice (subscription), Looperman, Freesound, Cymatics / Producer Spot free packs | Royalty-free samples are fine to release in your music |
| Sounds bundled *inside* the app | Freesound filtered to **CC0**, VSCO 2 Community Edition (CC0: glockenspiel, chimes, tubular bells), GeneralUser GS / FluidR3 SoundFonts, Kenney / OpenGameArt | Most sample sites forbid redistributing raw files, which shipping them in an app would be |
| Full beats to rap over | BeatStars, Airbit, YouTube "type beats" | Free versions are for practice; releasing needs a lease |

**The licence question was avoided entirely:** the drum and chime sounds in Beat mode are synthesised in code (`audio/synth.rs`), so no sample files ship with the app.

### Tips for working with loops in the editor
- Keep loops at **one BPM** (hip hop is usually 80–95). Many packs put BPM and key in the file name.
- At 90 BPM one bar is 2.667 s. Beat mode's grid now does this maths for you.
- Short WAV one-shots, trimmed and normalised, work best. Name melodic samples with their root note (`bell_C4.wav`).

---

## 2. What Beat mode is

A switch in the header flips between:

- **Editor**: the app exactly as it was. No grid, no snapping, and the mix is summed exactly as before (master bus at unity, limiter off).
- **Beat**: adds the music tools below.

The mode and the beat settings are remembered between launches (`localStorage` keys `zwave.mode` and `zwave.beat`).

### Features
1. **Tempo and grid**: set the BPM; the ruler counts bars and beats, and grid lines run across every track. The toolbar shows the playhead as `bar.beat.sixteenth`.
2. **Snap**: bar / beat / 1/8 / 1/16 / off. Applies to click-seek, drag-select and ⌘/Ctrl-drag track moves.
3. **Master bus**: master volume plus a brickwall limiter (−0.5 dBFS). It is applied identically in playback and in the master export, so a busy session no longer clips.
4. **Pattern maker**: open it with **+ New pattern** in the toolbar, or **Start a beat** on the empty screen.
   - 16 steps = 1 bar of sixteenth notes; click or drag across steps to paint them.
   - Built-in voices: Kick, 808, Snare, Clap, Hat, Open hat, Chime.
   - Each row has volume, a note (808 and Chime), **C** (choke: each hit cuts off the last, good for 808s and open hats) and **M** (mute).
   - Any row can use **Load sample…** to play your own file instead (C4 plays it as recorded).
   - Length is 1–16 bars, and swing goes from 0 to 60%.
   - **Preview loop** plays the pattern on its own while you edit it.
   - **Add to session** renders it to a normal track at the start of the current bar.
   - Tails wrap round to the start, so the clip loops seamlessly with Repeat or paste.
   - The **▦** button on a pattern track reopens its grid.

The default pattern is a boom-bap starter at 90 BPM: kick on steps 1, 8 and 11, an 808 on 1 and 11, snare on 2 and 4, eighth-note hats, and 20% swing.

---

## 3. How it is built

### Rust (`src-tauri/src/`)
| File | What it does |
|---|---|
| `audio/master.rs` | `MasterBus` (gain + limiter flag) and `Limiter` (stereo-linked, instant attack, 150 ms release). The default is transparent. |
| `audio/synth.rs` | The voices. Kick: pitch-swept sine. 808: tuned sine with a glide and saturation. Snare: tone plus high-passed noise. Clap: three noise bursts plus a tail. Hats: six-square "808 metal" plus noise. Chime: FM bell. Deterministic noise, normalised to a 0.9 peak. |
| `audio/pattern.rs` | `Pattern` → stereo clip at 44.1 kHz. Handles swing, choke (with a 6 ms fade), tail wrap-around and a 0.98 ceiling. |
| `audio/engine.rs` | `Mixer::fill_with` applies the master bus. A **pattern loop** (`set_pattern_loop`) plays through the master. It is separate from main's quick-tunes preview (`start_preview` / `fill_preview`). |
| `audio/export.rs` | `render_master_with` uses the same master bus as playback. |
| `commands.rs` | New: `set_master`, `render_pattern`, `preview_pattern`, `stop_pattern_preview`. `export_master` takes an optional `master`. |

### Frontend (`src/`)
| File | What it does |
|---|---|
| `lib/beat.ts` | Grid maths (`snapTime`, `floorToBar`, `formatBarBeat`), voice table, default pattern, saved settings |
| `components/ModeSwitch.tsx` | Editor / Beat toggle |
| `components/BeatBar.tsx` | Tempo, snap, position, + New pattern, master volume, limiter |
| `components/PatternDialog.tsx` | The step grid |
| `components/Timeline.tsx` | Takes an optional `beat` prop. With it: beat ruler, grid lines, snapping. Without it: the original code paths. |
| `components/EmptySession.tsx` | The "Start a beat" button, shown in Beat mode only |
| `App.tsx` | Mode and beat state, sends the master bus to the engine, adds or updates pattern tracks |

**Design rule kept:** audio never crosses into JavaScript. Patterns are rendered in Rust, and the UI only sends the grid as JSON.

---

## 4. Merge with `main` (PR #1: tunes, workspace, projects)

`main` was merged into `beat-mode`, not rebased, so no force-push was needed. These were the decisions taken while resolving conflicts:

- The **tune preview** (main) and the **pattern loop** (Beat mode) both stay. The pattern loop was renamed so the two can't be confused, and both can play at once.
- **"Start a beat"** moved from the old import screen into `EmptySession`.
- **`styles.css`** is now main's stylesheet plus the Beat block appended whole. Git's line merge had split a rule (`.project-list__meta`), which silently disabled all the Beat styles.
- **`.empty`** now uses `justify-content: safe center`, with plain `center` as a fallback. The drop zone's top was getting cut off when the window is short, a latent issue the Beat toolbar made visible.

---

## 5. What was verified

- `cargo test`: **57 pass**. That covers all the original tests, main's workspace tests, and new tests for the limiter, the voices (tuning, no clicks, determinism), pattern timing, swing, choke, loop wrap and clipping.
- `cargo build` and `npm run build`: clean, with no warnings.
- Headless-browser click-through with a mocked backend, at desktop and phone width:
  - Editor mode sends unity gain with no limiter.
  - Snapping applies only in Beat mode. A selection snapped to exactly 2.667–10.667 s at 90 BPM.
  - Switching back to Editor restores the original UI.
- A rendered test beat was checked visually: hits land on the grid. The chime decay was shortened after that check because it was smearing.
- **Not yet done:** listening on real speakers.

---

## 6. Test checklist for your machine

```bash
git fetch origin
git checkout beat-mode
npm install
npm run tauri dev
```

- [ ] The app opens in the mode you last used. Flip **Editor ⇄ Beat** in the header.
- [ ] **Editor:** everything behaves exactly as before (ruler in seconds, free dragging, no toolbar).
- [ ] **Beat → Start a beat** (no tracks open), then **Preview loop**. Does the default pattern sound right? Are the drums punchy, the 808 audible, any clicks?
- [ ] Paint and erase steps while previewing; the loop should update without restarting.
- [ ] Try the **808 note**, **Chime note**, **swing** and **choke** controls.
- [ ] Use **Load sample…** on a row with one of your own one-shots.
- [ ] **Add to session**, then press play. The track should land at the start of the current bar.
- [ ] ⌘/Ctrl-drag a track: it should snap to the grid. Drag-select a range: the edges should snap.
- [ ] Change the **tempo** and check that the ruler and grid follow.
- [ ] Turn **Master** up past 0 dB with the **Limiter** on. It should get louder without harsh clipping. Turn the limiter off and compare.
- [ ] **Export → master mix** in Beat mode. The file should match what you heard, limiter included.
- [ ] Use ▦ on a pattern track to edit it and **Update track**.
- [ ] Quick tunes still work, including auditioning a tune while the pattern preview loops.
- [ ] Save and open a project (see the known gap below).

Note anything that sounds or looks off, especially **which drum sounds need work**. The synth parameters live in `audio/synth.rs`.

---

## 7. Known gaps and possible next steps

1. **Saved projects don't keep the step grid.** A reopened project's pattern tracks play fine, but ▦ is gone. Fix: store `track.pattern` in the project file (`workspace.rs` `ProjectTrack`) and return it from `open_project`.
2. **Keyboard shortcuts while a dialog is open.** Space and Delete still reach the session, the same as with the existing dialogs. Worth gating if it gets in the way.
3. **Sound tuning.** The voices are a first pass; adjust them after listening.
4. Possible additions:
   - a metronome for recording over a beat
   - per-step velocity or accents
   - 32-step patterns
   - a "fit selection to bars" edit
   - drag-and-drop of quick tunes onto pattern rows

---

## 8. Picking up the conversation

When you come back, tell Claude what you found in testing, for example "808 too quiet, hats too harsh, snapping felt off when…". Point it to this file and PR #2 for context.
