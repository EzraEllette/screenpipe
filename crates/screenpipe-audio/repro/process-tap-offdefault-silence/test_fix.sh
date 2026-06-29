#!/bin/bash
# #4638 fix validation v2: baseline vs TAP-ONLY aggregate, off-default + control
set -uo pipefail
ROOT=$HOME/screenpipe-4638; REPO=$ROOT/screenpipe; BIN=$REPO/target/debug/examples
LOG=$ROOT/logs; mkdir -p "$LOG"
"$BIN/set_default_output" "BlackHole 16ch" >/dev/null 2>&1

run() {  # label  tone_target  [extra env...]
  local label="$1" target="$2"; shift 2
  local log="$LOG/fx2_${label}.log"
  echo; echo "### $label  — tone->'$target'  default='BlackHole 16ch'"
  env "$@" MODE=tap DURATION_SECS=30 RUST_LOG=info,screenpipe_audio=info "$BIN/process_tap_anchor_repro" >"$log" 2>&1 &
  local h=$!
  sleep 3
  TONE_DEVICE="$target" TONE_SECS=24 "$BIN/play_tone_coreaudio" >"$LOG/tone_$label.log" 2>&1 &
  wait "$h"
  local a s
  a=$(grep -c 'capture: AUDIO' "$log" 2>/dev/null || true); a=${a:-0}
  s=$(grep -c 'capture: SILENT' "$log" 2>/dev/null || true); s=${s:-0}
  echo "   RESULT: AUDIO=$a  SILENT=$s"
  grep -E 'TAP-ONLY aggregate' "$log" | head -1
  grep -nE 'capture:' "$log" | sed -n '6p;15p;24p'
}

run "baseline_offdefault" "BlackHole 2ch"                  # expect SILENT (bug present)
run "taponly_offdefault"  "BlackHole 2ch"  SP_TAP_ONLY=1   # THE FIX: expect AUDIO
run "taponly_control"     "BlackHole 16ch" SP_TAP_ONLY=1   # no-regression: expect AUDIO

"$BIN/set_default_output" "BlackHole 16ch" >/dev/null 2>&1
echo; echo "DONE_FIXTEST"
