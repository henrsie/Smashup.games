"""Tests for bot-mode checkpoint inference choices."""

from __future__ import annotations

import unittest

try:
    import torch

    from rl_policy_worker import (
        RL_DETERMINISTIC_POLICY_VERSION,
        RL_STOCHASTIC_POLICY_VERSION,
        choose_rl_action,
        normalize_generator_seed,
    )
except ModuleNotFoundError:
    torch = None


class FakePolicy:
    def __call__(self, observation, legal_actions):
        return torch.tensor([-1.0, 2.0])

    def sample_action(self, observation, legal_actions, *, generator=None):
        return int(torch.multinomial(
            torch.tensor([0.25, 0.75]),
            1,
            generator=generator,
        ).item())


@unittest.skipIf(torch is None, "PyTorch is not installed in this environment.")
class RlPolicyWorkerTests(unittest.TestCase):
    def test_text_seeds_are_stable_and_distinct(self) -> None:
        self.assertEqual(normalize_generator_seed("match-1"), normalize_generator_seed("match-1"))
        self.assertNotEqual(normalize_generator_seed("match-1"), normalize_generator_seed("match-2"))

    def test_deterministic_policy_uses_the_highest_logit(self) -> None:
        action_index = choose_rl_action(
            FakePolicy(),
            {},
            [{"type": "one"}, {"type": "two"}],
            policy_version=RL_DETERMINISTIC_POLICY_VERSION,
            generator=torch.Generator().manual_seed(7),
        )

        self.assertEqual(action_index, 1)

    def test_stochastic_policy_returns_a_legal_sample(self) -> None:
        action_index = choose_rl_action(
            FakePolicy(),
            {},
            [{"type": "one"}, {"type": "two"}],
            policy_version=RL_STOCHASTIC_POLICY_VERSION,
            generator=torch.Generator().manual_seed(7),
        )

        self.assertIn(action_index, (0, 1))


if __name__ == "__main__":
    unittest.main()
