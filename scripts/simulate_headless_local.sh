#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_directory}/.." && pwd)"
backend_directory="${project_root}/backend"

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <lo-seed> <hi-seed>" >&2
    exit 2
fi

lo_seed="$1"
hi_seed="$2"

integer_pattern='^-?[0-9]+$'
if [[ ! "${lo_seed}" =~ ${integer_pattern} || ! "${hi_seed}" =~ ${integer_pattern} ]]; then
    echo "Both seed bounds must be integers." >&2
    exit 2
fi

if (( lo_seed > hi_seed )); then
    echo "The low seed (${lo_seed}) cannot be greater than the high seed (${hi_seed})." >&2
    exit 2
fi

total_seeds=$((hi_seed - lo_seed + 1))
completed_seeds=0
failed_seeds=()

for ((seed = lo_seed; seed <= hi_seed; seed += 1)); do
    echo
    echo "=== Simulating seed ${seed} ($((seed - lo_seed + 1))/${total_seeds}) ==="
    if npm --prefix "${backend_directory}" run simulate -- "${seed}"; then
        completed_seeds=$((completed_seeds + 1))
    else
        failed_seeds+=("${seed}")
    fi
done

echo
echo "Completed ${completed_seeds}/${total_seeds} headless simulations for seeds ${lo_seed} through ${hi_seed}."
if (( ${#failed_seeds[@]} > 0 )); then
    echo "Failed seeds: ${failed_seeds[*]}" >&2
    exit 1
fi
