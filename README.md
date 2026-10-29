# zwaveEditor

A sound editor for desktop, built so the same codebase can target mobile later.

It imports audio files, draws their waveforms, plays them back — several files
at once, in sync, as a multitrack session — and lets you trim them and export
the result.

## Running it

```bash
npm install
npm run tauri dev      # desktop app with hot reload
npm run tauri build    # packaged .app / .dmg (or .exe / .deb)
```

Requires Node 20+ and a Rust toolchain (`rustup`). On macOS you also need the
Xcode command line tools.

You can also open files straight from the shell:

```bash
npm run tauri dev -- -- track-one.wav track-two.mp3
```

## What works

- **Import** — native file picker (pick as many files as you like) or drag them
  onto the window. Each file becomes a track.
- **Formats** — wav, mp3, flac, ogg/vorbis, m4a/aac, alac, aiff, caf, and audio
  tracks inside mkv/webm. Decoding is done by [symphonia](https://github.com/pdeljanov/symphonia),
  in pure Rust, so there is no ffmpeg dependency to ship.
- **Playback** — play/pause, stop, click anywhere to seek. Tracks play in
  parallel; files of different sample rates and channel counts stay locked to
  the same timeline.
- **Start points** — every track starts at zero until you move it: type a start
  time (in seconds) into the field in its header, or ⌘/Ctrl + drag its waveform
  along the timeline. Playback and the master export both honour it.
- **Mixing** — per-track mute, solo and volume, plus a checkbox choosing whether
  a file belongs to the master track. Unchecked files stay loaded and visible
  but are left out of both playback and export.
- **Editing** — drag across a track to select a range, then delete it or crop
  the track down to it.
- **Copy and paste** — copy or cut a selection, then paste it over another
  selection or, with nothing selected, at the playhead on the track you last
  clicked. Audio pasted from a different file is converted to that track's
  sample rate and channel layout. The playhead moves to the end of what you
  pasted, so pasting again adds another copy right after it. Every edit is undoable per track (twelve steps deep),
  and **nothing is written to the original file** — edits live in memory until
  you export.
- **Export** — write the checked files as one summed stereo master mix, or each
  one to its own file (as the clip itself, without its start offset). WAV at
  16-bit, 24-bit or 32-bit float.
- **Waveforms** — one lane per channel, min/max peaks with an RMS core, each
  track drawn at its true extent so you can see where a shorter file ends.
- **Navigation** — ⌘/Ctrl + scroll to zoom, shift + scroll to pan, ⌥ + drag to
  slide the view, plus a session minimap you can drag. Keys: `space` play/pause,
  `+` / `-` zoom, `0` fit, `Home` / `End` jump, `delete` remove the selection,
  `esc` clear it, `⌘/Ctrl + C` / `X` / `V` copy, cut and paste, `⌘/Ctrl + Z`
  undo.

## Beat mode

A switch in the header (and on the start screen) flips between **Editor**, the app exactly as described above, and **Beat**, which adds tools for making music. Switching back to Editor restores the original behaviour: no grid, no snapping, and the mix is summed exactly as before. The mode and the beat settings are remembered between launches.

Beat mode adds:

- **Tempo and grid** — set the BPM; the ruler counts bars instead of seconds, and bar/beat lines are drawn across every lane. The toolbar shows the playhead as `bar.beat.sixteenth`.
- **Snap** — bar, beat, 1/8 or 1/16 (or off). Clicking to seek, drag-selecting and ⌘/Ctrl-dragging a track all land on the grid.
- **Master bus** — a master volume and a brickwall limiter on the summed mix, applied identically in playback and in the master export, so a dense session no longer clips.
- **Pattern maker** — a 16-step grid of built-in synthesised voices (kick, 808, snare, clap, hat, open hat, chime), each row with its own volume, note (808 and chime), choke and mute. Any row can load a sample file instead. Set the length in bars and the swing, audition it with **Preview loop** (edits are heard live), then **Add to session**: it is rendered to an ordinary clip at the start of the bar the playhead is in. Sounds that ring past the end wrap round to the start, so the clip loops seamlessly with Repeat or paste. The ▦ button on a pattern track reopens its grid.

The voices are generated in `audio/synth.rs` — no sample files ship with the app, so there is nothing to license.

## How it is put together

```
src/                      React + TypeScript UI (this is what mobile will reuse)
  components/             ImportScreen, SessionScreen, Timeline, TrackWaveform,
                          TrackHeader, TransportBar, SessionMinimap
  lib/api.ts              the only place that calls into Rust
  lib/useTransport.ts     follows the engine's playhead
  lib/waveform.ts         canvas drawing and view maths
src-tauri/src/
  audio/decode.rs         any container/codec -> planar f32
  audio/peaks.rs          samples -> (min, max, rms) buckets
  audio/engine.rs         cpal output stream + the mixer
  audio/edit.rs           delete, crop, copy and paste over sample buffers
  audio/export.rs         master rendering and WAV writing
  audio/master.rs         master bus: gain and limiter (beat mode)
  audio/synth.rs          built-in drum and chime voices (beat mode)
  audio/pattern.rs        step pattern -> clip renderer (beat mode)
  audio/mod.rs            ClipStore (decoded audio, undo history) and Clipboard
  commands.rs             import / peaks / mix / transport / edit / clipboard / export
```

The rule the project follows: **audio data never crosses into JavaScript.**
Decoded samples stay in the Rust `ClipStore`, and the UI asks for exactly as
many peak buckets as it has pixels for the visible range. Drawing a 3-minute
file and a 3-hour file cost the same. The mixer shares those very same buffers
by `Arc`, so playing a file costs no extra memory.

Playback runs on a `cpal` output stream rather than through Web Audio. The audio
callback is lock-free — it reads an `ArcSwap` track list and a couple of
atomics — and the UI polls the playhead a few times a second, predicting it
locally in between. The whole mixer is a plain function over sample buffers,
which is what makes it testable and what makes the mobile port a build-target
change rather than a rewrite.

To check that audio output works on a given machine:

```bash
cd src-tauri && cargo run --example engine_probe -- ../some-file.wav
```

## Next steps

In rough dependency order:

1. **More edits** — gain, normalise and fades, following the same shape as
   `delete_range` and `crop_range`.
2. **Encoded export** — mp3 and flac need encoders; symphonia only decodes.
3. **Mobile** — `npm run tauri android init` / `ios init`. The UI already lays
   out for narrow screens and uses pointer events, so the work is device I/O and
   file access, not the interface.

Known limits today:

- Files are decoded fully into memory (roughly 10 MB per stereo minute at
  44.1 kHz), so multi-hour files should stream from disk before this ships.
- Sample-rate conversion during playback, and when pasting between files of
  different rates, is linear interpolation, which is fine
  for monitoring but not for export. A proper resampler (`rubato`) belongs in
  the render path.
- Tracks are summed without headroom management, so a dense session can clip at
  the output, on export as well as in playback. A master gain stage is the fix.
- Undo keeps a whole copy of the clip per step, which is simple but memory-hungry
  on long files. Storing the operations instead would fix it.
- Export is WAV only.
- Moving a track is not part of its undo history; undo only reverts edits to
  the audio.
