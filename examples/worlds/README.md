# Stateful Synthetic World Example

This local-only workflow keeps one synthetic persona and organization consistent across Stripe, GitHub, email, and generic REST state.

```bash
ghostapi world create --id subscription-recovery --seed demo-seed
npm run build
node examples/worlds/subscription-recovery.mjs
ghostapi world inspect subscription-recovery --json
```

The workflow atomically creates a Stripe customer and past-due subscription, records a generic REST payment failure, sends a synthetic email to a `ghostapi.invalid` inbox, and opens a synthetic GitHub recovery issue. Re-running the same action is idempotent. Reset and fork remain local:

```bash
ghostapi world reset subscription-recovery
ghostapi world fork subscription-recovery --id subscription-recovery-investigation
```

Worlds are local JSON under `.ghostapi/worlds/`. They are bounded to 512 KiB and 100 workflow receipts, use one file lock plus atomic replacement for each transition, and intentionally do not call provider APIs or contain real credentials, inboxes, or PII.
