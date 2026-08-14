# Draft Privacy Policy For Legal Review

> **Draft only. Not legal advice and not an operative privacy policy.** This document describes the current GhostAPI local-product behavior and proposed commercial boundaries as of August 8, 2026. Qualified counsel must review and replace it before any hosted service, paid pilot, public collection form, or commercial launch.

## Scope

GhostAPI is an open-source local developer tool. The published local runtime does not require an account and does not send product traffic, source code, prompts, secrets, or telemetry to GhostAPI by default.

The `hosted/` directory is an undeployed pilot architecture, not an operating service. This draft does not represent that a hosted service is currently collecting data.

## Current Local Processing

The local runtime processes the API requests that an operator directs to `127.0.0.1` or another configured local bind address. It stores local simulation state, bounded events, scenarios, reports, and other files described in the project documentation. These files remain under the operator's configured local data directory unless the operator independently exports or shares them.

The local runtime may mask secret-looking values before local logs, cache, dashboard, events, and prompts, but automatic sanitization is not a guarantee that every sensitive value is removed. Operators must review artifacts before sharing them.

## Optional Local Telemetry

Product telemetry is disabled by default. If an operator runs `ghostapi telemetry enable`, the implementation records only a bounded local aggregate of four counters and activity weeks. It has no network transport, automatic upload, background process, account identifier, repository identifier, provider name, command capture, source code, traffic, prompt, credential, or personal-data field. `ghostapi telemetry disable` deletes that local aggregate.

## Proposed Commercial And Pilot Data

Before a paid pilot, the parties should collect only the business information necessary for contracting, invoicing, support, and agreed pilot reporting. Possible categories include business contact details, contracting entity details, invoice and payment status metadata, and a customer-approved sanitized outcome summary.

GhostAPI should not request or retain production credentials, payment-card data, raw provider traffic, source code, prompts, customer end-user data, or full evidence payloads for sales, invoicing, or metrics. Any approved accounting provider must collect payment-card information directly.

## Sharing

The current local runtime has no GhostAPI-operated telemetry endpoint. A future commercial service must document each processor, purpose, legal basis, transfer location, retention term, and security measure before launch. It must not share data for advertising, sell personal information, or train external models on customer code, traffic, prompts, or secrets without separate, explicit authorization and a reviewed agreement.

## Retention And Deletion

The local runtime follows its documented bounded local retention behavior. Commercial records and any future hosted data need jurisdiction-specific retention schedules, deletion/export processes, backup treatment, and legal-hold exceptions approved by counsel before collection. Do not promise a deletion period until those controls are implemented and verified.

## Rights And Contact

Before an operative policy is published, establish a legal/privacy contact, request-verification process, response timelines, and region-specific disclosures. This repository intentionally does not invent a legal entity, address, contact email, or jurisdiction.

## Required Counsel Review

Counsel should determine, at minimum: controller/processor roles, applicable privacy laws, lawful bases, notice/consent, data-processing agreements, cross-border transfers, subprocessors, security disclosures, retention, data-subject rights, children's data, marketing rules, breach notification, records of processing, and the relationship between the open-source license and any commercial terms.
