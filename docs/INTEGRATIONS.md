# Integrations — setup, contract and testing

Every connector follows one contract (`server/modules/connectorHealth.ts`) and reports one of five states:
**connected · needs reconnect · degraded · not configured · disconnected**, with the identity, the last event, failing
and dead-lettered deliveries, and the next step in plain words. Admins see it through `getConnectorHealth`.

## Contract

| Concern | How it is met |
|---|---|
| Identity & permissions | Page name / WhatsApp number & verified name / provider business; granted scopes where the provider reports them (JustConnect *Test* lists missing scopes) |
| Tenant ownership | Credentials and data live in the company's own database; Meta Pages are claimed per company in the platform registry |
| Connect · verify · reconnect · disconnect | Existing screens in Settings › Lead sources / WhatsApp / Integrations; each audited |
| Field mapping + synthetic test | Telephony `telephonyFieldMap`; lead-source field maps; Google Ads "Send test data"; JustConnect *Test* |
| Authenticity & replay | Meta `X-Hub-Signature-256`; JustConnect HMAC with a 5-minute timestamp window; Chat360 / telephony shared secret (header preferred over query) + dedupe by provider event id or body hash |
| Durable intake | `webhookInbox`: stored **before** the answer; 503 if it cannot be stored. Meta leads keep their own durable queue |
| Idempotency | Inbox id = provider + event id (or SHA-256 of the body); telephony calls claimed per provider call id across server instances |
| Correlation | Each inbox event has a `correlationId`, returned to the provider and written to error logs |
| Retries · dead letter · replay | Back-off 1 min → 6 h, dead after 6 attempts, admin replay (`replayWebhookEvent`, audited) |
| Reconciliation | Meta: 10-minute and daily Facebook-vs-CRM checks; JustConnect: history sync. Generic telephony has **no** reconciliation — the provider's own logs are the only second source |

## Per provider

| Provider | Delivery contract we follow | Gaps / not verified |
|---|---|---|
| Meta Lead Ads | 200 quickly, re-delivery on non-2xx; signature on raw body | Live Meta delivery not exercised here (in-memory fake in tests) |
| WhatsApp direct (Meta) | 500 on failure so Meta re-delivers; status receipts move forward only | Meta's 24-hour service window and template rules are enforced by the existing sender; not re-verified against a live account |
| Social inbox (Meta) | Now stored per company before 200; 500 if it cannot be stored | — |
| Chat360 | 200 once stored (CRM retries itself, so Chat360 does not loop on our bugs); 503 if it cannot be stored | Chat360's own retry policy is not documented publicly |
| Telephony (generic) | 200 once stored, 503 if not; out-of-order callbacks never re-open an ended call | **Not "any provider"**: works where the provider can POST/GET call events with a shared secret and fields can be mapped. Dial, recording retrieval and history reconciliation exist only for JustConnect |
| JustConnect | HMAC + 5-minute window; 500 on failure (JustConnect retries); history sync catches up | Live account not used |

### Telephony adapters (target shape)

`dial(agent, number)` · `verifyCallback(request)` · `normalize(event) → {providerCallId, legs, direction, status, startedAt, endedAt, durationSec, recordingRef}` · `fetchRecording(ref)` · `reconcile(since)`.
JustConnect implements all five today (`server/modules/justconnect.ts`, `jcCalls.ts`, `jcSync.ts`); the generic webhook
implements `verifyCallback` + `normalize`. Agent ↔ number mapping is per user (JustConnect agent link / user phone).

## WhatsApp consent

One policy for manual, campaign, bot and drip sends (`server/modules/consent.ts`): per E.164 number with evidence
history; STOP on WhatsApp direct or Chat360 suppresses marketing immediately; campaign sends re-check just before
each message. Company setting `whatsappMarketingConsent`: `optOut` (default, current behaviour) or `explicit`
(recommended under India's DPDP Act — **your decision**: switching it on stops marketing to people never asked).

Uncertain send outcomes: a send whose result is unknown (timeout) is marked failed and never retried automatically
by campaigns ("never twice"); the delivery receipt, if it arrives later, corrects the status.

## Testing an integration end to end (synthetic)

1. `MONGODB_URI=mongodb://127.0.0.1:27027 npx tsx scripts/seed-demo.ts` (refuses non-local databases).
2. Telephony: `curl -X POST "http://localhost:3100/api/webhooks/telephony?company=amaya-demo&provider=test" -H "x-webhook-secret: <secret>" -H "content-type: application/json" -d '{"call_id":"T1","from":"+919845011223","direction":"inbound","status":"missed"}'` — the call appears under Today › Missed calls; repeat it: one call.
3. Stop the database and repeat: the answer is 503 (never 200).
4. Automated equivalents: `tests/release-a-webhooks.test.ts`, `tests/server-whatsapp-campaigns.test.ts`.

## External API (defined, not built)

Do not expose the cookie-authenticated `/api/rpc` as a public API. Proposed `/api/v1`:
- Per-company API keys with scopes (`leads:create`, `leads:read`, `visits:create`, `inventory:read-public`),
  hashed at rest, rotatable, rate limited, every call audited with the key id.
- Resources: `POST /v1/enquiries` (same pipeline as website forms, idempotency-key header), `GET /v1/units`
  (public unit facts only — never buyers), `POST /v1/visits`.
- Signed outbound webhooks: `lead.created`, `visit.booked`, `unit.reserved`, `unit.booked`, `payment.received`;
  body signed `t=<unix>,v1=<HMAC-SHA256(t.body)>`, 5-minute window, at-least-once with event ids, retries with
  back-off and a delivery log. Not implemented in this branch.
