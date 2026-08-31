"""Persistent JSON-lines inference worker for Node bot-mode matches."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

import torch

from reinforce import load_reinforce_checkpoint


RL_DETERMINISTIC_POLICY_VERSION = "rl_v1_deterministic"
RL_STOCHASTIC_POLICY_VERSION = "rl_v1_stochastic"
RL_POLICY_VERSIONS = (
    RL_DETERMINISTIC_POLICY_VERSION,
    RL_STOCHASTIC_POLICY_VERSION,
)


def normalize_generator_seed(seed: int | str) -> int:
    """Convert numeric or text match seeds into a stable PyTorch generator seed."""
    if isinstance(seed, bool):
        raise TypeError("seed must be a number or string.")
    if isinstance(seed, int):
        return seed % (2 ** 63)
    if not isinstance(seed, str):
        raise TypeError("seed must be a number or string.")
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % (2 ** 63)


@torch.no_grad()
def choose_rl_action(
    policy,
    observation: Mapping[str, Any],
    legal_actions: Sequence[Mapping[str, Any]],
    *,
    policy_version: str,
    generator: torch.Generator,
) -> int:
    """Choose an argmax or sampled index from the same checkpoint policy."""
    if policy_version == RL_DETERMINISTIC_POLICY_VERSION:
        return int(policy(observation, legal_actions).argmax().item())
    if policy_version == RL_STOCHASTIC_POLICY_VERSION:
        return policy.sample_action(
            observation,
            legal_actions,
            generator=generator,
        )
    raise ValueError(f"Unsupported RL policy version: {policy_version}")


def write_message(message: Mapping[str, Any]) -> None:
    sys.stdout.write(f"{json.dumps(message, separators=(',', ':'))}\n")
    sys.stdout.flush()


def run_worker(checkpoint_path: Path, seed: int | str) -> None:
    policy, checkpoint = load_reinforce_checkpoint(checkpoint_path, device="cpu")
    policy.eval()
    generator = torch.Generator(device="cpu")
    generator.manual_seed(normalize_generator_seed(seed))
    write_message({
        "ready": True,
        "checkpointEpisodesCompleted": checkpoint.get("episodesCompleted", 0),
        "checkpointUpdatesCompleted": checkpoint.get("updatesCompleted", 0),
    })

    for raw_line in sys.stdin:
        if not raw_line.strip():
            continue
        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            observation = request.get("observation")
            legal_actions = request.get("legalActions")
            policy_version = request.get("policyVersion")
            if not isinstance(request_id, int):
                raise TypeError("Inference request id must be an integer.")
            if not isinstance(observation, Mapping):
                raise TypeError("Inference observation must be an object.")
            if not isinstance(legal_actions, list) or not legal_actions:
                raise TypeError("Inference legalActions must be a non-empty list.")
            action_index = choose_rl_action(
                policy,
                observation,
                legal_actions,
                policy_version=policy_version,
                generator=generator,
            )
            if not 0 <= action_index < len(legal_actions):
                raise ValueError("RL policy selected an invalid legal-action index.")
            write_message({"id": request_id, "actionIndex": action_index})
        except Exception as error:  # Keep the protocol alive long enough to report the failure.
            write_message({
                "id": request_id,
                "error": str(error),
                "errorType": type(error).__name__,
            })


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--seed", default="0")
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    run_worker(arguments.checkpoint, arguments.seed)
