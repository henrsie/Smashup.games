"""Tests for collating and encoding variable-action trajectory batches."""

from __future__ import annotations

import copy
import unittest

try:
    import torch
    from torch.utils.data import DataLoader

    from action_embeddings import create_entity_embeddings
    from observation_encoder import create_observation_encoder
    from test_trajectory_dataset import make_action, make_observation
    from trajectory_batch import collate_trajectory_batch, encode_trajectory_batch
except ModuleNotFoundError:
    torch = None


def make_sample(action_count: int, chosen_index: int = 0) -> dict:
    actions = []
    for action_index in range(action_count):
        action = make_action()
        action["choiceFeatures"]["candidateOrdinal"] = action_index
        actions.append(action)
    return {
        "observation": make_observation("bot-1"),
        "legalActions": actions,
        "chosenActionIndex": chosen_index,
        "chosenAction": copy.deepcopy(actions[chosen_index]),
        "reward": float(chosen_index),
        "vpReward": 0.0,
        "terminalReward": 0.0,
        "nextObservation": make_observation("bot-1"),
        "terminated": False,
        "truncated": False,
        "done": False,
        "playerId": "bot-1",
        "gameId": "game-1",
        "decisionIndex": chosen_index,
        "resolutionId": "resolution-1",
        "decisionType": "turnAction",
        "stepIndex": 0,
        "trajectoryIndex": 0,
        "sourcePath": "/tmp/trajectory.json",
        "trajectoryMetadata": {"policyVersion": "random-v1"},
    }


@unittest.skipIf(torch is None, "PyTorch is not installed in this environment.")
class TrajectoryBatchTests(unittest.TestCase):
    def test_collator_builds_targets_counts_and_action_mask(self) -> None:
        samples = [make_sample(1), make_sample(3, chosen_index=2)]

        batch = collate_trajectory_batch(samples)

        self.assertEqual(batch["action_counts"].tolist(), [1, 3])
        self.assertEqual(batch["action_mask"].tolist(), [
            [True, False, False],
            [True, True, True],
        ])
        self.assertEqual(batch["chosen_action_indices"].dtype, torch.long)
        self.assertEqual(batch["chosen_action_indices"].tolist(), [0, 2])
        self.assertEqual(batch["rewards"].dtype, torch.float32)
        self.assertEqual(batch["done"].dtype, torch.bool)
        self.assertEqual(len(batch["observations"]), 2)
        self.assertEqual(batch["game_ids"], ["game-1", "game-1"])

    def test_collator_works_as_a_pytorch_dataloader_callback(self) -> None:
        loader = DataLoader(
            [make_sample(2), make_sample(1)],
            batch_size=2,
            collate_fn=collate_trajectory_batch,
            shuffle=False,
        )

        batch = next(iter(loader))

        self.assertEqual(tuple(batch["action_mask"].shape), (2, 2))
        self.assertEqual(batch["action_counts"].tolist(), [2, 1])

    def test_trainable_encoders_run_after_collation_and_preserve_gradients(self) -> None:
        entity_embeddings = create_entity_embeddings()
        observation_encoder = create_observation_encoder(
            entity_embeddings=entity_embeddings,
        )
        raw_batch = collate_trajectory_batch([
            make_sample(1),
            make_sample(3, chosen_index=1),
        ])

        encoded = encode_trajectory_batch(
            raw_batch,
            observation_encoder=observation_encoder,
            action_encoder=entity_embeddings,
        )

        self.assertEqual(tuple(encoded["state_vectors"].shape), (2, 256))
        self.assertEqual(tuple(encoded["next_state_vectors"].shape), (2, 256))
        self.assertEqual(
            tuple(encoded["action_vectors"].shape),
            (2, 3, entity_embeddings.action_embedding_size),
        )
        self.assertTrue(torch.equal(
            encoded["action_vectors"][0, 1:],
            torch.zeros_like(encoded["action_vectors"][0, 1:]),
        ))
        loss = (
            encoded["state_vectors"].sum()
            + encoded["next_state_vectors"].sum()
            + encoded["action_vectors"][encoded["action_mask"]].sum()
        )
        loss.backward()
        self.assertIsNotNone(entity_embeddings.action_types.weight.grad)
        self.assertGreater(entity_embeddings.action_types.weight.grad.abs().sum().item(), 0)

    def test_invalid_batches_fail_before_training(self) -> None:
        with self.assertRaisesRegex(ValueError, "empty"):
            collate_trajectory_batch([])

        invalid_choice = make_sample(1)
        invalid_choice["chosenActionIndex"] = 1
        with self.assertRaisesRegex(ValueError, "chosenActionIndex"):
            collate_trajectory_batch([invalid_choice])

        invalid_done = make_sample(1)
        invalid_done["done"] = True
        with self.assertRaisesRegex(ValueError, "done"):
            collate_trajectory_batch([invalid_done])


if __name__ == "__main__":
    unittest.main()
