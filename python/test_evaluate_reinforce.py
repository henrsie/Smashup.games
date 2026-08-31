"""Tests for checkpoint evaluation and result aggregation."""

from __future__ import annotations

import unittest

try:
    import torch

    from evaluate_reinforce import (
        DEFAULT_OPPONENTS,
        build_evaluation_jobs,
        run_evaluation_game,
        summarize_evaluation,
    )
except ModuleNotFoundError:
    torch = None


class FirstLogitPolicy:
    def __call__(self, observation, legal_actions):
        return torch.tensor([1.0] * len(legal_actions))


class FakeEvaluationEnvironment:
    def __init__(self) -> None:
        self.game_result = None

    def reset(self, **kwargs):
        self.game_result = None
        return {
            "observation": {
                "observerPlayerId": "player-1",
                "players": [{"id": "player-1"}, {"id": "player-2"}],
            },
            "legalActions": [{"type": "end-turn"}],
            "info": {"actorId": "player-1"},
        }

    def choose_builtin_action(self, policy_version):
        return 0

    def step(self, action_index):
        self.game_result = {
            "winnerId": "player-1",
            "standings": [
                {"playerId": "player-1", "rank": 1, "vp": 16, "factions": ["Robots"]},
                {"playerId": "player-2", "rank": 2, "vp": 12, "factions": ["Aliens"]},
            ],
        }
        return {
            "observation": {"observerPlayerId": "player-1"},
            "legalActions": [],
            "terminated": True,
            "truncated": False,
            "info": {"actorId": "player-1"},
        }

    def result(self):
        return {"decisionCount": 1, "gameResult": self.game_result}


@unittest.skipIf(torch is None, "PyTorch is not installed in this environment.")
class EvaluationTests(unittest.TestCase):
    def test_default_rotation_includes_every_built_in_opponent(self) -> None:
        self.assertEqual(DEFAULT_OPPONENTS, (
            "random-v1",
            "first-legal-v1",
            "greedy_heuristic_1",
            "greedy_heuristic_2",
        ))

    def test_evaluation_jobs_rotate_each_seed_through_every_seat(self) -> None:
        jobs = build_evaluation_jobs(
            opponents=("random-v1", "first-legal-v1"),
            games_per_seat=2,
            player_count=3,
            seed=380,
            max_decisions=500,
            sample_actions=True,
        )

        self.assertEqual(len(jobs), 12)
        self.assertEqual(
            [job["learnedSeat"] for job in jobs[:3]],
            [0, 1, 2],
        )
        self.assertEqual({job["seed"] for job in jobs[:3]}, {380})
        self.assertEqual({job["seed"] for job in jobs[3:6]}, {381})
        self.assertEqual(jobs[6]["opponentPolicy"], "first-legal-v1")
        self.assertEqual(len({job["policySeed"] for job in jobs}), len(jobs))
        self.assertTrue(all(job["sampleActions"] for job in jobs))

    def test_evaluation_game_records_the_checkpoint_seat_result(self) -> None:
        record = run_evaluation_game(
            FakeEvaluationEnvironment(),
            FirstLogitPolicy(),
            opponent_policy="random-v1",
            learned_seat=0,
            player_count=2,
            seed=380,
        )

        self.assertTrue(record["won"])
        self.assertEqual(record["rank"], 1)
        self.assertEqual(record["victoryPoints"], 16)
        self.assertEqual(record["decisionCount"], 1)

    def test_summary_separates_opponents_and_seats(self) -> None:
        records = [
            {
                "opponentPolicy": "random-v1",
                "learnedSeat": 0,
                "terminated": True,
                "truncated": False,
                "won": True,
                "rank": 1,
                "victoryPoints": 16,
                "decisionCount": 100,
            },
            {
                "opponentPolicy": "random-v1",
                "learnedSeat": 1,
                "terminated": True,
                "truncated": False,
                "won": False,
                "rank": 2,
                "victoryPoints": 12,
                "decisionCount": 120,
            },
            {
                "opponentPolicy": "greedy_heuristic_1",
                "learnedSeat": 0,
                "terminated": False,
                "truncated": True,
                "won": False,
                "rank": None,
                "victoryPoints": None,
                "decisionCount": 10_000,
            },
        ]

        summary = summarize_evaluation(records)

        self.assertEqual(summary["games"], 3)
        self.assertEqual(summary["completedGames"], 2)
        self.assertEqual(summary["truncatedGames"], 1)
        self.assertEqual(summary["wins"], 1)
        self.assertEqual(summary["winRate"], 0.5)
        self.assertEqual(summary["byOpponent"]["random-v1"]["winRate"], 0.5)
        self.assertEqual(summary["bySeat"]["0"]["games"], 2)


if __name__ == "__main__":
    unittest.main()
