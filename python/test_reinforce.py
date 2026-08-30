"""Tests for the masked REINFORCE baseline."""

from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

try:
    import torch

    from reinforce import (
        ReinforceTransition,
        calculate_discounted_returns,
        collect_episode,
        create_masked_action_policy,
        get_periodic_checkpoint_path,
        load_reinforce_checkpoint,
        normalize_return_tensor,
        reinforce_update,
        save_reinforce_checkpoint,
    )
    from test_trajectory_dataset import make_action, make_observation
except ModuleNotFoundError:
    torch = None


class FirstActionPolicy:
    def sample_action(self, observation, legal_actions, *, generator=None) -> int:
        return 0


class FakeEnvironment:
    def __init__(self) -> None:
        self.step_index = 0

    @staticmethod
    def _state(actor_id: str) -> dict:
        return {
            "observation": {"observerPlayerId": actor_id},
            "legalActions": [{"type": "end-turn"}],
            "info": {"actorId": actor_id},
        }

    def reset(self, **kwargs) -> dict:
        self.step_index = 0
        return self._state("player-1")

    def step(self, action_index: int) -> dict:
        responses = [
            {
                **self._state("player-2"),
                "reward": 0.0,
                "terminated": False,
                "truncated": False,
                "info": {
                    "actorId": "player-1",
                    "nextActorId": "player-2",
                    "rewardsByPlayer": {"player-1": 0.0, "player-2": 0.0},
                },
            },
            {
                **self._state("player-1"),
                "reward": 0.0,
                "terminated": False,
                "truncated": False,
                "info": {
                    "actorId": "player-2",
                    "nextActorId": "player-1",
                    "rewardsByPlayer": {"player-1": 0.2, "player-2": 0.0},
                },
            },
            {
                "observation": {"observerPlayerId": "player-1"},
                "legalActions": [],
                "reward": 1.0,
                "terminated": True,
                "truncated": False,
                "info": {
                    "actorId": "player-1",
                    "nextActorId": None,
                    "rewardsByPlayer": {"player-1": 1.0, "player-2": -1.0},
                },
            },
        ]
        response = responses[self.step_index]
        self.step_index += 1
        return response

    def result(self) -> dict:
        return {"gameResult": {"winnerId": "player-1"}}


@unittest.skipIf(torch is None, "PyTorch is not installed in this environment.")
class ReinforceTests(unittest.TestCase):
    def test_returns_follow_each_players_decision_sequence(self) -> None:
        transitions = [
            ReinforceTransition("p1", {}, [], 0, reward=0.2),
            ReinforceTransition("p2", {}, [], 0, reward=-1.0),
            ReinforceTransition("p1", {}, [], 0, reward=1.0),
        ]

        returns = calculate_discounted_returns(transitions, gamma=0.5)

        self.assertEqual(returns, [0.7, -1.0, 1.0])

    def test_episode_collection_credits_rewards_earned_during_other_turns(self) -> None:
        rollout = collect_episode(
            FakeEnvironment(),
            FirstActionPolicy(),
            gamma=0.5,
        )

        self.assertTrue(rollout.terminated)
        self.assertFalse(rollout.truncated)
        self.assertEqual([transition.player_id for transition in rollout.transitions], [
            "player-1",
            "player-2",
            "player-1",
        ])
        self.assertEqual(
            [transition.reward for transition in rollout.transitions],
            [0.2, -1.0, 1.0],
        )
        self.assertEqual(
            [transition.discounted_return for transition in rollout.transitions],
            [0.7, -1.0, 1.0],
        )

    def test_policy_scores_only_the_supplied_legal_actions(self) -> None:
        policy = create_masked_action_policy(state_size=32, component_size=16, hidden_size=24)
        observation = make_observation("bot-1")
        legal_actions = [make_action(), make_action()]
        legal_actions[1]["choiceFeatures"]["candidateOrdinal"] = 1

        logits = policy(observation, legal_actions)
        batch_logits, action_mask = policy.forward_batch(
            [observation, observation],
            [legal_actions[:1], legal_actions],
        )

        self.assertEqual(tuple(logits.shape), (2,))
        self.assertEqual(tuple(batch_logits.shape), (2, 2))
        self.assertEqual(action_mask.tolist(), [[True, False], [True, True]])
        for _ in range(10):
            self.assertIn(policy.sample_action(observation, legal_actions), (0, 1))

    def test_reinforce_update_backpropagates_through_shared_encoders(self) -> None:
        torch.manual_seed(7)
        policy = create_masked_action_policy(state_size=32, component_size=16, hidden_size=24)
        optimizer = torch.optim.Adam(policy.parameters(), lr=1e-3)
        observation = make_observation("bot-1")
        legal_actions = [make_action(), make_action()]
        legal_actions[1] = copy.deepcopy(legal_actions[1])
        legal_actions[1]["choiceFeatures"]["candidateOrdinal"] = 1
        transitions = [
            ReinforceTransition(
                "bot-1",
                observation,
                legal_actions,
                action_index=0,
                discounted_return=1.0,
            ),
            ReinforceTransition(
                "bot-2",
                observation,
                legal_actions,
                action_index=1,
                discounted_return=-1.0,
            ),
        ]
        before = policy.entity_embeddings.action_types.weight.detach().clone()

        metrics = reinforce_update(
            policy,
            optimizer,
            transitions,
            batch_size=1,
            entropy_coefficient=0.01,
        )

        self.assertTrue(torch.isfinite(torch.tensor(metrics["loss"])))
        self.assertGreater(metrics["gradientNorm"], 0.0)
        self.assertFalse(torch.equal(
            before,
            policy.entity_embeddings.action_types.weight.detach(),
        ))

    def test_return_normalization_handles_constant_and_single_values(self) -> None:
        self.assertEqual(normalize_return_tensor(torch.tensor([2.0])).tolist(), [2.0])
        self.assertEqual(
            normalize_return_tensor(torch.tensor([3.0, 3.0])).tolist(),
            [0.0, 0.0],
        )

    def test_checkpoint_loader_reconstructs_the_saved_policy(self) -> None:
        policy = create_masked_action_policy(state_size=32, component_size=16, hidden_size=24)
        optimizer = torch.optim.Adam(policy.parameters(), lr=1e-3)
        observation = make_observation("bot-1")
        legal_actions = [make_action(), make_action()]
        legal_actions[1]["choiceFeatures"]["candidateOrdinal"] = 1

        with tempfile.TemporaryDirectory() as directory:
            checkpoint_path = Path(directory) / "reinforce.pt"
            save_reinforce_checkpoint(
                checkpoint_path,
                policy=policy,
                optimizer=optimizer,
                episodes_completed=12,
                updates_completed=3,
                training_config={"algorithm": "reinforce", "learningRate": 1e-3},
            )
            loaded_policy, checkpoint = load_reinforce_checkpoint(checkpoint_path)

        self.assertEqual(checkpoint["episodesCompleted"], 12)
        self.assertEqual(checkpoint["updatesCompleted"], 3)
        self.assertEqual(loaded_policy.observation_encoder.state_size, 32)
        self.assertEqual(loaded_policy.observation_encoder.component_size, 16)
        self.assertEqual(loaded_policy.hidden_size, 24)
        self.assertTrue(torch.allclose(
            policy(observation, legal_actions),
            loaded_policy(observation, legal_actions),
        ))

    def test_periodic_checkpoint_path_preserves_the_latest_filename(self) -> None:
        latest = Path("training-data/checkpoints/reinforce.pt")

        milestone = get_periodic_checkpoint_path(latest, 30)

        self.assertEqual(
            milestone,
            Path("training-data/checkpoints/reinforce-episodes-000030.pt"),
        )


if __name__ == "__main__":
    unittest.main()
