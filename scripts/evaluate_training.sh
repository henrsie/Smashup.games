#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_directory}/.." && pwd)"
python_bin="${PYTHON_BIN:-${project_root}/.venv/bin/python}"
base_url="${SMASHUP_BASE_URL:-http://127.0.0.1:3001}"
checkpoint="${SMASHUP_CHECKPOINT:-${project_root}/training-data/checkpoints/reinforce.pt}"
evaluation_output="${SMASHUP_EVALUATION_OUTPUT:-${project_root}/training-data/evaluations/reinforce.json}"

if [[ ! -x "${python_bin}" ]]; then
    echo "Python environment not found or not executable: ${python_bin}" >&2
    echo "Set PYTHON_BIN or create the project's .venv environment." >&2
    exit 1
fi

exec "${python_bin}" "${project_root}/python/evaluate_reinforce.py" \
    --base-url "${base_url}" \
    --checkpoint "${checkpoint}" \
    --output "${evaluation_output}" \
    --games-per-seat "${SMASHUP_GAMES_PER_SEAT:-5}" \
    --player-count "${SMASHUP_PLAYER_COUNT:-3}" \
    --seed "${SMASHUP_EVALUATION_SEED:-10000}" \
    --opponents random-v1 first-legal-v1 greedy_heuristic_1 greedy_heuristic_2 \
    "$@"
