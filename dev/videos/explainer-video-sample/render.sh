#!/usr/bin/env bash
set -euo pipefail
sample_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$sample_dir/../../.." && pwd)
skill_dir="$repo_dir/pi-skill-explainer-video/skills/explainer-video"
build=()
if [[ -x "$HOME/.local/bin/t3-build" ]]; then
    build=("$HOME/.local/bin/t3-build")
fi
"${build[@]}" node "$skill_dir/scripts/validate.mjs" "$skill_dir/examples/stockroom/storyboard.json" --strict
"${build[@]}" node "$skill_dir/scripts/render.mjs" "$skill_dir/examples/stockroom/storyboard.json" \
    --check-layout --report "$sample_dir/layout.json" --out "$sample_dir/visual.mp4"
"${build[@]}" node "$skill_dir/examples/stockroom/score.mjs" "$sample_dir/score.wav"
"${build[@]}" node "$skill_dir/scripts/assemble.mjs" "$skill_dir/examples/stockroom/storyboard.json" \
    --visual "$sample_dir/visual.mp4" --audio "$sample_dir/score.wav" --out "$sample_dir/stockroom.mp4" \
    --description "$sample_dir/youtube-description.txt" --sheet "$sample_dir/sheet.png"
