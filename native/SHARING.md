# HAZEN Sampler — read me first

A sampler plugin. Load an audio file, it mangles or chops it into a loop, you drag
the result onto a track.

**macOS only, VST3 only.** More on both below, because it is better to know now
than after ten minutes of it not showing up.

## Install

1. Unzip.
2. Move `HAZEN Sampler.vst3` into:

   ```
   ~/Library/Audio/Plug-Ins/VST3/
   ```

   In Finder: **Go → Go to Folder**, paste that path. Create the `VST3` folder if
   it is not there.

3. **Clear the download flag.** Open Terminal and run:

   ```bash
   xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/VST3/"HAZEN Sampler.vst3"
   ```

   This step is not optional and it is not me being lazy about instructions.
   macOS quarantines anything that arrives from the internet, and it refuses to
   load a quarantined plugin that has not been notarised by Apple. Notarising
   needs a paid Apple Developer account, which this build does not have — so the
   bundle is ad-hoc signed and you have to tell macOS you trust it. Without this
   the plugin either will not appear or your DAW will report it as failing to
   load, with no useful explanation either way.

4. Rescan plugins in your DAW and look for **HAZEN** → **HAZEN Sampler**. It is
   an *instrument*, not an effect, so it goes on an instrument/MIDI track.

## Using it

- Drag an audio file onto the plugin window, or press `load a sample`.
- `mode` picks **mangle** (a chain of destructive effects, bar-locked) or
  **chop** (cuts a vocal into a 16-bar chopped loop).
- Press `play` to hear it. A MIDI note also triggers it. With `sync` on it
  follows the host transport and restarts on the bar.
- `reroll` in mangle mode rolls a random chain, with `<` `>` to step back
  through past rolls. `rechop` and `rechop + mangle` are the chop-mode
  equivalents.
- **`drag to a track`** drags the loop out as a 24-bit WAV, straight onto an
  audio track. `export wav` is the same file through a save dialog.

Sample length is capped at 30 seconds; longer files are truncated and the status
line says so.

## What it works in

Tested here in Ableton Live 12. VST3 is a shared format, so it should also load
in **Bitwig, Reaper, Cubase, Studio One, FL Studio, Ardour** — but those are
untested by me, so treat them as likely rather than promised.

It will **not** work in:

- **Logic Pro** or **GarageBand** — those need Audio Unit (AU), and AU cannot be
  built on the machine this was compiled on (it needs a full Xcode install, which
  is not present). This is a real limitation, not an oversight.
- **Pro Tools** — needs AAX, which requires an Avid developer agreement.
- **Windows or Linux** — this is a macOS build. A Windows version would need
  compiling on Windows; nothing here can cross-compile it.

## Architecture

Universal: **arm64 and x86_64**, so it runs natively on both Apple Silicon and
Intel Macs. Verify with:

```bash
lipo -info ~/Library/Audio/Plug-Ins/VST3/"HAZEN Sampler.vst3/Contents/MacOS/HAZEN Sampler"
```

## If it does not show up

In order of likelihood:

1. The quarantine flag is still set. Re-run the `xattr` command above, then
   restart the DAW completely — a rescan alone sometimes is not enough.
2. It is in the wrong folder. It must be `~/Library/Audio/Plug-Ins/VST3/`, which
   is inside your *home* Library, not `/Library` at the root of the disk.
3. VST3 scanning is off. In Live: Settings → Plug-Ins → **Use VST3 Plug-In System
   Folders** on, then **Rescan**.
4. You are looking under effects. It is an instrument.

## Honest notes

- **Unsigned by Apple.** No Developer ID, no notarisation. Everything above about
  quarantine follows from that. If your DAW warns you about an unidentified
  developer, that is expected and it is the same warning any unsigned local build
  gets.
- **Parameter changes are not instant.** The plugin renders the whole loop offline
  and plays the result, rather than streaming effects per block. That is on
  purpose — it is what makes what you hear identical to what you export — but it
  means a knob move queues a re-render. The status line says when one is running.
- Presets save the sample *path*, not the audio. Move or rename the file and the
  plugin will not find it again.
