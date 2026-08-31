#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_directory}/.." && pwd)"
python_bin="${PYTHON_BIN:-${project_root}/.venv/bin/python}"
base_url="${SMASHUP_BASE_URL:-http://127.0.0.1:3001}"
checkpoint="${SMASHUP_CHECKPOINT:-${project_root}/training-data/checkpoints/reinforce.pt}"

if [[ ! -x "${python_bin}" ]]; then
    echo "Python environment not found or not executable: ${python_bin}" >&2
    echo "Set PYTHON_BIN or create the project's .venv environment." >&2
    exit 1
fi

exec "${python_bin}" "${project_root}/python/reinforce.py" \
    --base-url "${base_url}" \
    --checkpoint "${checkpoint}" \
    --episodes "${SMASHUP_EPISODES:-20}" \
    --episodes-per-update "${SMASHUP_EPISODES_PER_UPDATE:-4}" \
    --checkpoint-every "${SMASHUP_CHECKPOINT_EVERY:-10}" \
    --player-count "${SMASHUP_PLAYER_COUNT:-3}" \
    --seed "${SMASHUP_SEED:-380}" \
    --heuristic-game-probability "${SMASHUP_HEURISTIC_GAME_PROBABILITY:-0.5}" \
    --opponent-policies random-v1 greedy_heuristic_1 greedy_heuristic_2 \
    "$@"
