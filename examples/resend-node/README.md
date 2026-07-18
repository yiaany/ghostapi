# Resend Node Example

Send a Resend-like email through GhostAPI. This does not send a real email.

## Run

Start GhostAPI:

```bash
ghostapi start
```

Send an email:

```bash
curl -X POST http://localhost:8080/emails \
  -H "content-type: application/json" \
  -H "authorization: Bearer re_local_only" \
  -d '{"from":"onboarding@example.com","to":"ada@example.com","subject":"Welcome","html":"<p>Hello from GhostAPI</p>"}'
```

GhostAPI detects Resend from `/emails` and returns a local mock email response.
