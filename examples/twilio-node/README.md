# Twilio Node Example

Send a Twilio-like SMS through GhostAPI. This does not send a real SMS.

## Run

Start GhostAPI:

```bash
ghostapi start
```

Send a message:

```bash
curl -X POST http://localhost:8080/2010-04-01/Accounts/AC_mock/Messages.json \
  -H "content-type: application/x-www-form-urlencoded" \
  -d "To=+15551234567&From=+15557654321&Body=Hello%20from%20GhostAPI"
```

GhostAPI detects Twilio from the `/2010-04-01/Accounts/...` path and returns a local message SID.
