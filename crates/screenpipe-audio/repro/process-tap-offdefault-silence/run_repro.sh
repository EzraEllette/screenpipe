#!/usr/bin/env bash
# screenpipe #4638 Sequoia repro runner. Two BlackHole virtual outputs make a
# default vs non-default split — no AirPods needed.
set -uo pipefail
ROOT="${ROOT:-$HOME/screenpipe-4638}"
REPO_DIR="${REPO_DIR:-$ROOT/screenpipe}"
BIN="$REPO_DIR/target/debug/examples"
LOG="$ROOT/logs"; mkdir -p "$LOG"
DEFAULT_DEV="${DEFAULT_DEV:-BlackHole 16ch}"   # anchor = system default output
OFFDEV="${OFFDEV:-BlackHole 2ch}"              # NON-default output (the 'AirPods' analog)

[ -x "$BIN/process_tap_anchor_repro" ] || { echo "build missing — run the setup script first"; exit 1; }

echo "== setting default output to '$DEFAULT_DEV' (capturing original) =="
OUT="$("$BIN/set_default_output" "$DEFAULT_DEV")" || { echo "set_default_output failed:"; echo "$OUT"; exit 1; }
echo "$OUT"
ORIG="$(printf '%s\n' "$OUT" | awk -F\' '/OLD default output/{print $2; exit}')"

run () {  # args: mode target label
  local mode="$1" target="$2" label="$3"
  local log="$LOG/${mode}_${label}.log"
  echo; echo "### MODE=$mode  audio->'$target'  [$label]  default='$DEFAULT_DEV'"
  MODE="$mode" DURATION_SECS=60 RUST_LOG=info,screenpipe_audio=info "$BIN/process_tap_anchor_repro" >"$log" 2>&1 &
  local h=$!
  sleep 3
  TONE_DEVICE="$target" TONE_SECS=52 "$BIN/play_tone_coreaudio" >"$LOG/tone_${mode}_${label}.log" 2>&1 &
  wait "$h"
  local a s
  a=$(grep -c 'capture: AUDIO' "$log" 2>/dev/null || true); a=${a:-0}
  s=$(grep -c 'capture: SILENT' "$log" 2>/dev/null || true); s=${s:-0}
  echo "   -> AUDIO=$a  SILENT=$s   (sample lines:)"
  grep -nE 'capture:' "$log" | sed -n '1p;20p;46p;58p'
  if grep -qiE 'delivered only silence|re-anchor' "$log"; then
    echo "   watchdog: FIRED"; grep -niE 'delivered only silence|re-anchor' "$log" | head -3
  else
    echo "   watchdog: no hits"
  fi
}

for MODE in tap sck; do
  run "$MODE" "$DEFAULT_DEV" "control_default"   # sanity: audio to default  -> expect AUDIO
  run "$MODE" "$OFFDEV"      "bug_offdefault"    # the test: audio off-default -> SILENT on Sequoia = bug
done

[ -n "${ORIG:-}" ] && "$BIN/set_default_output" "$ORIG" >/dev/null 2>&1 || true
echo
echo "==================== INTERPRETATION ===================="
echo "control_default  : expect AUDIO. If SILENT -> grant 'Screen & System Audio"
echo "                   Recording' to your terminal, OR this box can't capture"
echo "                   BlackHole audio (then we need a different output method)."
echo "bug_offdefault   : AUDIO = NO repro (same as macOS 26)."
echo "                   SILENT = #4638 REPRODUCED on this macOS version."
echo "Logs: $LOG"
