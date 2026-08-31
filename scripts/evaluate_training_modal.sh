#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_directory}/.." && pwd)"
modal_bin="${MODAL_BIN:-${project_root}/.venv/bin/modal}"
checkpoint="${SMASHUP_CHECKPOINT:-${project_root}/training-data/checkpoints/reinforce.pt}"
evaluation_output="${SMASHUP_EVALUATION_OUTPUT:-${project_root}/training-data/evaluations/reinforce-modal.json}"

if [[ ! -x "${modal_bin}" ]]; then
    echo "Modal CLI not found or not executable: ${modal_bin}" >&2
    echo "Install python/requirements.txt in .venv, or set MODAL_BIN." >&2
    exit 1
fi

exec "${modal_bin}" run "${project_root}/python/modal_evaluate.py" \
    --checkpoint "${checkpoint}" \
    --output "${evaluation_output}" \
    --games-per-seat "${SMASHUP_GAMES_PER_SEAT:-5}" \
    --player-count "${SMASHUP_PLAYER_COUNT:-3}" \
    --seed "${SMASHUP_EVALUATION_SEED:-10000}" \
    --max-workers "${SMASHUP_MODAL_MAX_WORKERS:-20}" \
    "$@"
