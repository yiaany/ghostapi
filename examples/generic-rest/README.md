# Generic REST Example

Create a generic task resource through GhostAPI. This path uses the generic fallback, not a native adapter.

## Run

Start GhostAPI:

```bash
ghostapi start
```

Create a task:

```bash
curl -X POST http://localhost:8080/tasks \
  -H "content-type: application/json" \
  -d '{"title":"Write integration tests","status":"open","priority":"high"}'
```

Fetch tasks:

```bash
curl http://localhost:8080/tasks
```

The generic fallback infers the `task` resource from the path and produces local mock IDs like `task_mock_xxx`.
