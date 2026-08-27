# Node–Python headless bridge

The Node process owns the authoritative game state. Python receives observations and ordered legal actions, chooses an `actionIndex`, and sends only that index back to Node for validation and execution.

Start the local environment API from `backend/`:

```bash
npm run env-server
```

In another terminal, run the dependency-free Python smoke test from the repository root:

```bash
python3 python/smoke_test.py --seed 380
```

`NodeSmashUpEnv` in `node_env.py` exposes:

- `reset(...)`: creates or resets an environment and returns its first observation and `legalActions`.
- `step(action_index)`: returns the next observation, legal actions, reward, termination flags, and transition metadata.
- `result()`: returns the episode summary.
- `close()`: deletes the environment from Node memory.

The local server binds to `127.0.0.1:3001` by default. Override it with `HEADLESS_ENV_HOST` and `HEADLESS_ENV_PORT`. Do not expose this development API publicly without authentication, rate limiting, and environment lifecycle limits.
