# Local Product Telemetry

Product telemetry is disabled by default and has no network transport.

When explicitly enabled, GhostAPI stores four aggregate counters and up to eight ISO week labels in `.ghostapi/product-telemetry.json`. It does not record source code, request or response traffic, commands, provider names, repository identity, credentials, or secrets.

```bash
ghostapi telemetry enable
ghostapi telemetry status
ghostapi telemetry export --json
ghostapi telemetry disable
```

`disable` deletes the local telemetry file. The data is not uploaded by GhostAPI; exporting or sharing it is an operator action.
