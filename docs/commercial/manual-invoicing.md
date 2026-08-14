# Manual Paid-Pilot Invoicing Workflow

## Purpose And Boundary

This is the only commercial collection path while GhostAPI's commercial gate is closed. It is a human-operated workflow for a signed, fixed-scope paid pilot. It does not create a checkout, subscription, payment portal, entitlement service, or card-data handling path.

The OSS local runtime remains available regardless of invoice state. Do not disable, delete, or alter a partner's local data because a pilot expires, is cancelled, or has an overdue invoice.

## Preconditions

Do not issue an invoice until all of the following exist:

1. A dated, sanitized evidence signal supports a paid-pilot discussion.
2. A written pilot proposal identifies the customer legal entity, scope, fixed fee, currency, tax treatment, payment terms, pilot dates, support boundary, success criteria, and cancellation/termination terms.
3. The legal and tax treatment has been reviewed for the seller and customer jurisdictions.
4. A customer billing contact and purchase-order requirements are confirmed through an approved business channel.

## Workflow

1. **Qualify:** Confirm the selected repository/workflow, buyer, measurable success criteria, and security boundary. Never request production credentials, raw traffic, source code, or personal data that is not needed for the commercial relationship.
2. **Approve proposal:** Obtain an executed order form, statement of work, or equivalent written acceptance before delivery beyond the agreed evaluation scope.
3. **Create invoice:** Use an approved accounting or invoicing system. Record only the business information required by that system and applicable law. Do not use GhostAPI local state, traffic logs, evidence artifacts, or source repositories as an invoicing system.
4. **Deliver payment instructions:** Send the invoice through the approved business channel. If the invoicing system offers card payment, the processor must host the payment collection page; GhostAPI must not receive card data.
5. **Record status:** In a private commercial ledger, store only an opaque pilot ID, invoice ID, amount/currency, issue/due/paid dates, status, and a link to the signed commercial record. Restrict access to authorized finance operators.
6. **Handle payment state:** Send a straightforward reminder after the stated due date. Pause only optional hosted or human support that the signed agreement explicitly makes conditional on payment. Preserve local OSS access and customer data.
7. **Close out:** Send the agreed evidence summary, record the buyer decision, and delete or retain commercial records only under the reviewed retention schedule.

## Cancellation And Failed Payment

- Provide the cancellation contact and effective date in the written pilot terms. Do not use a dark pattern or require an impossible support path.
- A disputed, failed, or overdue payment is a finance process, not a reason to erase evidence or local data.
- Never retry a payment through GhostAPI. The accounting provider handles payment retry rules and payment data.
- If a future hosted service is involved, establish a documented read/export and retention path before any access restriction. Do not promise automatic deletion or restoration without a tested implementation.

## Records And Privacy

- Keep commercial records outside the public repository and separate from product telemetry.
- Use an opaque pilot ID in metrics; do not include contact names, email addresses, repository names, provider names, source code, traffic, credentials, or raw evidence.
- Do not put invoice numbers, addresses, banking details, tax identifiers, purchase orders, or payment links in `SESSION_LOG.md`, issue templates, product telemetry, or test fixtures.
- The [data inventory draft](data-inventory.md) and [privacy policy draft](privacy-policy-draft.md) require legal review before any commercial use.

## Transition To Billing

Move beyond this workflow only after the gate is met and the team has selected a billing provider, jurisdictional approach, entitlement contract, webhook/idempotency model, cancellation behavior, payment-failure policy, data-retention policy, and incident/reconciliation runbook. Implement and test those controls before accepting self-serve payment.
