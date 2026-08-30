"""Batching helpers for variable-action Smash Up trajectory transitions."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

import torch
from torch import Tensor
from torch.nn.utils.rnn import pad_sequence


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _finite_float(value: Any, field: str, sample_index: int) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
    ):
        raise ValueError(f"Sample {sample_index} field {field!r} must be a finite number.")
    return float(value)


def collate_trajectory_batch(samples: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Collate raw transitions without running their trainable encoders.

    Variable-size observations and legal-action lists remain as Python objects.
    Fixed-size learning targets become CPU tensors, and ``action_mask`` marks the
    real positions in the future padded action tensor.
    """
    if not isinstance(samples, Sequence) or isinstance(samples, (str, bytes)):
        raise TypeError("samples must be a sequence of trajectory transitions.")
    if not samples:
        raise ValueError("Cannot collate an empty trajectory batch.")

    observations = []
    legal_actions = []
    next_observations = []
    action_counts = []
    chosen_action_indices = []
    rewards = []
    vp_rewards = []
    terminal_rewards = []
    terminated = []
    truncated = []
    done = []
    player_ids = []
    game_ids = []
    decision_indices = []
    resolution_ids = []
    decision_types = []
    step_indices = []
    trajectory_indices = []
    source_paths = []
    trajectory_metadata = []

    for sample_index, sample in enumerate(samples):
        if not isinstance(sample, Mapping):
            raise TypeError(f"Sample {sample_index} must be a mapping.")
        observation = sample.get("observation")
        next_observation = sample.get("nextObservation")
        actions = sample.get("legalActions")
        if not isinstance(observation, Mapping):
            raise TypeError(f"Sample {sample_index} observation must be a mapping.")
        if not isinstance(next_observation, Mapping):
            raise TypeError(f"Sample {sample_index} nextObservation must be a mapping.")
        if not isinstance(actions, list) or not actions:
            raise ValueError(f"Sample {sample_index} legalActions must be a non-empty list.")
        if not all(isinstance(action, Mapping) for action in actions):
            raise TypeError(f"Every legal action in sample {sample_index} must be a mapping.")

        chosen_index = sample.get("chosenActionIndex")
        if not _is_integer(chosen_index) or not 0 <= chosen_index < len(actions):
            raise ValueError(
                f"Sample {sample_index} chosenActionIndex must index legalActions."
            )
        sample_flags = {}
        for field in ("terminated", "truncated", "done"):
            value = sample.get(field)
            if not isinstance(value, bool):
                raise TypeError(f"Sample {sample_index} field {field!r} must be a boolean.")
            sample_flags[field] = value
        if sample_flags["terminated"] and sample_flags["truncated"]:
            raise ValueError(f"Sample {sample_index} cannot terminate and truncate.")
        if sample_flags["done"] != (
            sample_flags["terminated"] or sample_flags["truncated"]
        ):
            raise ValueError(
                f"Sample {sample_index} done must equal terminated OR truncated."
            )

        observations.append(observation)
        legal_actions.append(actions)
        next_observations.append(next_observation)
        action_counts.append(len(actions))
        chosen_action_indices.append(chosen_index)
        rewards.append(_finite_float(sample.get("reward"), "reward", sample_index))
        vp_rewards.append(_finite_float(sample.get("vpReward"), "vpReward", sample_index))
        terminal_rewards.append(_finite_float(
            sample.get("terminalReward"),
            "terminalReward",
            sample_index,
        ))
        terminated.append(sample_flags["terminated"])
        truncated.append(sample_flags["truncated"])
        done.append(sample_flags["done"])
        player_ids.append(sample.get("playerId"))
        game_ids.append(sample.get("gameId"))
        decision_indices.append(sample.get("decisionIndex"))
        resolution_ids.append(sample.get("resolutionId"))
        decision_types.append(sample.get("decisionType"))
        step_indices.append(sample.get("stepIndex"))
        trajectory_indices.append(sample.get("trajectoryIndex"))
        source_paths.append(sample.get("sourcePath"))
        trajectory_metadata.append(sample.get("trajectoryMetadata"))

    action_count_tensor = torch.tensor(action_counts, dtype=torch.long)
    max_action_count = int(action_count_tensor.max().item())
    action_mask = torch.arange(max_action_count).unsqueeze(0) < action_count_tensor.unsqueeze(1)

    return {
        "observations": observations,
        "legal_actions": legal_actions,
        "next_observations": next_observations,
        "action_counts": action_count_tensor,
        "action_mask": action_mask,
        "chosen_action_indices": torch.tensor(chosen_action_indices, dtype=torch.long),
        "rewards": torch.tensor(rewards, dtype=torch.float32),
        "vp_rewards": torch.tensor(vp_rewards, dtype=torch.float32),
        "terminal_rewards": torch.tensor(terminal_rewards, dtype=torch.float32),
        "terminated": torch.tensor(terminated, dtype=torch.bool),
        "truncated": torch.tensor(truncated, dtype=torch.bool),
        "done": torch.tensor(done, dtype=torch.bool),
        "player_ids": player_ids,
        "game_ids": game_ids,
        "decision_indices": decision_indices,
        "resolution_ids": resolution_ids,
        "decision_types": decision_types,
        "step_indices": step_indices,
        "trajectory_indices": trajectory_indices,
        "source_paths": source_paths,
        "trajectory_metadata": trajectory_metadata,
    }


def encode_trajectory_batch(
    batch: Mapping[str, Any],
    *,
    observation_encoder: Any,
    action_encoder: Any,
) -> dict[str, Any]:
    """Apply trainable encoders and pad legal-action vectors for one raw batch.

    Call this inside the training step, not from a multi-worker DataLoader. This
    keeps the encoder operations in the autograd graph and on the model's device.
    """
    observations = batch.get("observations")
    next_observations = batch.get("next_observations")
    legal_action_groups = batch.get("legal_actions")
    action_counts = batch.get("action_counts")
    action_mask = batch.get("action_mask")
    if not isinstance(observations, list) or not observations:
        raise ValueError("batch observations must be a non-empty list.")
    if not isinstance(next_observations, list) or len(next_observations) != len(observations):
        raise ValueError("batch next_observations must match observations.")
    if not isinstance(legal_action_groups, list) or len(legal_action_groups) != len(observations):
        raise ValueError("batch legal_actions must match observations.")
    if not isinstance(action_counts, Tensor) or action_counts.dtype != torch.long:
        raise TypeError("batch action_counts must be a torch.long tensor.")
    if not isinstance(action_mask, Tensor) or action_mask.dtype != torch.bool:
        raise TypeError("batch action_mask must be a torch.bool tensor.")

    flat_actions = [
        action
        for actions in legal_action_groups
        for action in actions
    ]
    expected_action_count = int(action_counts.sum().item())
    if len(flat_actions) != expected_action_count:
        raise ValueError("batch action_counts do not match legal_actions.")

    state_vectors = observation_encoder(observations)
    next_state_vectors = observation_encoder(next_observations)
    flat_action_vectors = action_encoder(flat_actions)
    if not isinstance(state_vectors, Tensor) or state_vectors.ndim != 2:
        raise ValueError("observation_encoder must return [batch, state_width].")
    if (
        not isinstance(next_state_vectors, Tensor)
        or next_state_vectors.shape != state_vectors.shape
    ):
        raise ValueError("next observation vectors must match state vector shape.")
    if not isinstance(flat_action_vectors, Tensor) or flat_action_vectors.ndim != 2:
        raise ValueError("action_encoder must return [total_actions, action_width].")
    if flat_action_vectors.shape[0] != expected_action_count:
        raise ValueError("action_encoder returned the wrong number of action vectors.")
    if state_vectors.device != flat_action_vectors.device:
        raise ValueError("observation and action encoders must use the same device.")

    action_vector_groups = flat_action_vectors.split(action_counts.tolist(), dim=0)
    padded_action_vectors = pad_sequence(
        action_vector_groups,
        batch_first=True,
        padding_value=0.0,
    )
    device = state_vectors.device
    encoded_batch = dict(batch)
    for field in (
        "action_counts",
        "action_mask",
        "chosen_action_indices",
        "rewards",
        "vp_rewards",
        "terminal_rewards",
        "terminated",
        "truncated",
        "done",
    ):
        value = encoded_batch.get(field)
        if isinstance(value, Tensor):
            encoded_batch[field] = value.to(device=device)
    encoded_batch.update({
        "state_vectors": state_vectors,
        "next_state_vectors": next_state_vectors,
        "action_vectors": padded_action_vectors,
    })
    return encoded_batch

