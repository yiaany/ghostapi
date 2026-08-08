# GhostAPI Starter Examples

- `stripe-node/`: Stripe checkout, subscription, refund, and local webhook starter using fake local keys.
- `openai-streaming/`: OpenAI-shaped streaming/tool-call request against local GhostAPI.
- `ci-smoke/`: CI policy pass/fail fixtures, including an intentional production-egress failure.
- `record-replay/`: Sanitized HAR import plus deterministic replay with no live provider traffic.
- `evals/`: Agent eval spec starter scored from sanitized evidence.
- `worlds/`: Stateful synthetic world starter for a subscription recovery workflow.

Run `npx @yiaany/ghostapi doctor` before using `ghostapi run`; Linux namespace enforcement is not claimed on Windows or macOS.
