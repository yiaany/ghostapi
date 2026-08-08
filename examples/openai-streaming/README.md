# OpenAI Streaming And Tool Call Starter

This starter exercises OpenAI-shaped chat completions against local GhostAPI. It uses a fake key and never requires a live OpenAI account.

```bash
npx @yiaany/ghostapi start
node examples/openai-streaming/streaming-tool-call.mjs
```

When running on a supported Linux host, execute the app through the egress boundary:

```bash
npx @yiaany/ghostapi run -- node examples/openai-streaming/streaming-tool-call.mjs
```

Windows and macOS process isolation is unsupported/experimental; use `ghostapi start` and local SDK base URLs there.
