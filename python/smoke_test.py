"""Run a complete Python-controlled game against the local Node environment."""

from __future__ import annotations

import argparse
import json
import random

from node_env import NodeSmashUpEnv


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", default="380")
    parser.add_argument("--url", default="http://127.0.0.1:3001")
    parser.add_argument("--max-decisions", type=int, default=2_000)
    args = parser.parse_args()

    policy_random = random.Random(str(args.seed))
    with NodeSmashUpEnv(args.url) as environment:
        state = environment.reset(
            seed=args.seed,
            max_decisions=args.max_decisions,
        )
        while True:
            legal_actions = state["legalActions"]
            action_index = policy_random.randrange(len(legal_actions))
            state = environment.step(action_index)
            if state["terminated"] or state["truncated"]:
                break

        result = environment.result()
        summary = {
            "environmentId": environment.environment_id,
            "randomSeed": result["randomSeed"],
            "decisionCount": result["decisionCount"],
            "terminated": result["terminated"],
            "truncated": result["truncated"],
            "terminationReason": result["terminationReason"],
            "winner": (result.get("gameResult") or {}).get("winnerName"),
        }
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
