# Process Tap off-default-output silence (macOS &lt;26)

Reproduction + investigation tooling for the bug fixed in
`crates/screenpipe-audio/src/core/process_tap.rs` (`build_capture`): the CoreAudio
**Process Tap** records **only silence** when the user's audio is routed to a
device that is **not the system default output** (e.g. a call on AirPods while the
system default stays on the built-in speakers).

> These files live outside `examples/` on purpose — cargo only auto-builds
> `examples/`, `tests/`, `benches/`, `src/bin/`, so nothing here is compiled by
> CI. They reference `cidre::core_audio` and only build/run on macOS. To run one,
> copy the `.rs` into `crates/screenpipe-audio/examples/` and
> `cargo run -p screenpipe-audio --example <name>`.

## What the bug is

- Only on the **CoreAudio Process Tap** path, which is opt-in: the
  `experimentalCoreaudioSystemAudio` setting, **default `false`**. The default
  **ScreenCaptureKit** path is unaffected.
- Only on **macOS &lt; 26**. macOS 26 (Tahoe) changed the global-tap behavior so it
  no longer depends on the anchor device; macOS 14/15 (Sonoma/Sequoia) are broken.

## Root cause (this is the non-obvious part)

It is **not** the tap construction. We tested the issue's proposed "real fix"
(option #1, a per-process `with_stereo_mixdown_of_processes` tap) — it **still
records silence** off-default.

The real cause is the **aggregate device**: it is built with the system default
**output** device as its main sub-device. On macOS &lt;26 the tap's audio only
flows through the aggregate while that anchor sub-device is itself active. Route
audio to a different device → the anchor goes idle → the aggregate (and therefore
the tap) delivers zeros, and the watchdog futilely re-anchors to the same dead
device.

**The fix:** make the *tap* the aggregate's main device with **no output
sub-device**, so capture no longer depends on which output device the audio lands
on. Scoped to macOS &lt;26 (26+ keeps the output-anchored aggregate, whose nominal
sample rate tracks the real output device and avoids a 96kHz-DAC 2x-slowmo issue).

## How it was reproduced (no AirPods required)

The trigger is "audio on a non-default output device" — **not** AirPods/SCO
specifically (we confirmed SCO is not required). So it reproduces with two
**BlackHole** virtual outputs: set the system default to `BlackHole 16ch` and play
audio to `BlackHole 2ch`. That makes it reproducible on a headless cloud Mac with
no Bluetooth hardware.

Validated on a Scaleway Mac mini M4, **macOS 15.6.1**:

| path | audio on default | audio off-default |
|------|------------------|-------------------|
| Process Tap (baseline) | AUDIO | **SILENT** + re-anchor loop |
| Process Tap (**fix**) | AUDIO | **AUDIO** ✅ |
| ScreenCaptureKit (default path) | AUDIO | AUDIO (never affected) |

macOS 26.4 could not reproduce it on either path — which is why it needed a real
Sequoia box.

> macOS gotcha: Screen &amp; System Audio Recording (TCC) cannot be granted to an
> SSH-spawned process (granting `sshd` does not work). Run the harness as a child
> of a granted GUI app, e.g. over VNC, or:
> `osascript -e 'tell application "Terminal" to do script "bash run_repro.sh"'`.

## Files

| file | what it does |
|------|--------------|
| `process_tap_anchor_repro.rs` | Main harness. Drives the real `AudioStream::from_device` for "System Audio". `MODE=sck` (default) or `MODE=tap`; prints `[default: <dev>] capture: SILENT/AUDIO` once a second. The fix's env probes `SP_TAP_PROCESS_MIXDOWN` / `SP_TAP_ONLY` were validated through this (now folded into the version-gated fix). |
| `play_tone_coreaudio.rs` | Plays a 440 Hz tone to a **named** output device via a CoreAudio IOProc (`TONE_DEVICE`, `TONE_SECS`) — the "other participant" audio source, independent of the system default. |
| `set_default_output.rs` | Sets the system default **output** device by name substring (CoreAudio). |
| `open_airpods_mic.rs` | Opens a CoreAudio input IOProc on a device to force AirPods into SCO/HFP — used to prove SCO is **not** the trigger. |
| `play_tone_to_device.rs` | cpal tone player. Kept as evidence that the SCK-forked cpal does **not** enumerate Bluetooth output devices (hence the CoreAudio player above). |
| `sequoia_repro_setup.sh` | Turnkey setup for a fresh macOS 15 box (Homebrew, Rust, BlackHole 2ch/16ch, build); embeds the `.rs` tools. |
| `bootstrap.sh` | The no-sudo box bootstrap actually used (Homebrew into a pre-owned `/opt/homebrew`). |
| `run_repro.sh` | Runs control + off-default for both `tap` and `sck`, prints a verdict. |
| `test_fix.sh` | Baseline vs fixed, off-default + control. |

Reproduces / closes the "calls on AirPods record other participants as silence"
report.
