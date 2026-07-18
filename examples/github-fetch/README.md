# GitHub Fetch Example

Create a GitHub-like issue through GhostAPI using plain `fetch` or `curl`. This does not call GitHub.

## Run

Start GhostAPI:

```bash
ghostapi start
```

Create an issue:

```bash
curl -X POST http://localhost:8080/repos/octo/hello-world/issues \
  -H "content-type: application/json" \
  -H "x-github-api-version: 2022-11-28" \
  -H "authorization: Bearer ghp_local_only" \
  -d '{"title":"Local integration test","body":"Created through GhostAPI"}'
```

Equivalent JavaScript:

```js
await fetch("http://localhost:8080/repos/octo/hello-world/issues", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    authorization: "Bearer ghp_local_only"
  },
  body: JSON.stringify({ title: "Local integration test", body: "Created through GhostAPI" })
});
```
