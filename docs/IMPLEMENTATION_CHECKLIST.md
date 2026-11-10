# Implementation checklist — Amaya sales foundation

Branch: `improve/amaya-sales-foundation` (from `main` @ `16b330a`, the commit the review covered; no later upstream commits).
Status key: `[ ]` todo · `[~]` in progress · `[x]` done and verified by tests · `[!]` blocked / needs a decision.

## 0. Setup and evidence

- [x] Repository cloned to `~/Claude/realestate-crm`; isolated branch created.
- [x] AGENTS.md read (Next.js 16 warning: read `node_modules/next/dist/docs/` before Next-specific code).
- [x] Supplied review: only the seven findings in the brief were supplied. No separate backlog file was found in the repo or the Amaya folder.
- [x] Prior local work found: `~/Claude/crm-test/meta-lead-fixes.patch` (branch `fix/meta-lead-intake`, F-001…F-005). It was written against an older base and does not apply to `16b330a` (conflicts in 5 files; upstream had already rewritten intake/metaSync). Its findings are re-checked below instead of force-applied.
- [x] "Reverse Engineer Anything" skill: installed on request from `smartworldarafath/REA_Skill` @ `36102f1` (MIT) — **only** `skills/rea-core/reverse-engineer-anything` was copied to `~/.claude/skills/`, after reading it. The other 242 bundled skills (attack payloads, "unblocked prompts", etc.) and the `rea` MCP server were not installed. Without the MCP tools, the skill's method is applied manually: question checklist, evidence ledger (observed / inferred / unknown), bounded searches, and normal repository tools for open-source Frappe CRM.
- [x] Baseline: typecheck ✅ · 1479 passed / 1 failed (drip test determinism) — see `docs/VERIFICATION.md`.

## Release A — access, ownership, booking integrity, release safety

| # | Finding | Reproduced on main? | Fix | Test | Status |
|---|---|---|---|---|---|
| A1 | Inventory/bootstrap disclose other agents' customers | yes | `inventory.customers` + presentUnits; event feed | release-a-inventory | [x] |
| A2 | Concurrent unit updates both "book" | yes (20 → >1 winner) | mandatory rev + CAS, unitRules, holds, idempotency | release-a-inventory | [x] |
| A3 | Rename orphans leads | yes | owner ids + rename cascade + migration | release-a-ownership | [x] |
| A4 | Webhook failures → 200; social swallowed | yes | webhookInbox persist-before-ack, retry, dead letter, replay | release-a-webhooks | [x] |
| A5 | Visit slots overbook | yes (10 → >2) | atomic slot counter, idempotent, cancel / reschedule | release-a-visits | [x] |
| A6 | Stage-rank funnel, responded-only SLA, notes revenue | yes (100 %) | milestones, salesReport, pipeline.ts fixes | release-a-reporting | [x] |
| A7 | Same-database snapshots only | by inspection | export / isolated restore / verify + runbook | release-a-recovery | [x] |
| A8 | Drip test non-determinism | yes | test uses the worker clock | server-drip | [x] |
| A9 | Cross-tenant isolation | not a defect | — | release-a-tenancy | [x] |

Release A gates: typecheck ✅ · 1517/1517 tests ✅ · build ✅ · audit 0 ✅ (see VERIFICATION.md).

## Release B — agent workspace and family-to-booking journey
- [x] Linked people per opportunity (enquirer, resident, decision-maker, payer, referrer) — journey.ts
- [x] Contact preferences: channel, language, IANA time zone, best time, consent with evidence
- [x] Next action required on every open contact (logDisposition); Today queue "no next step"
- [x] Today (agent) and Team exceptions (manager), audited reassignment with reason
- [x] Visit capacity, idempotent booking, cancel / reschedule (Release A); visit attendance / no-show / feedback fields — [ ] not built
- [x] Versioned quotation, discount approval by another person
- [x] Time-limited holds, booking request gated (approved quote + payer), manager approval, atomic
- [x] Full E.164 phone identity (overseas family numbers stay distinct)
- [x] UI: Today screen, lead Journey tab, tokens, visible focus — browser-checked desktop + mobile, screenshots in docs/screenshots

## Release C — integrations and recovery
- [x] Durable webhook inbox (Release A), connector health contract with reconnect / degraded states
- [x] One WhatsApp consent policy (campaign re-check before each send, drip, inbound STOP on both providers)
- [ ] Telephony adapter refactor of the generic webhook (documented target shape; JustConnect already complete)
- [ ] External versioned API and signed outbound webhooks (specified in INTEGRATIONS.md, not built)
- [x] Recovery runbook + isolated restore drill (Release A)

## Release D — reporting and post-sales
- [x] Event-based funnel, overall SLA, estimated vs quoted vs booked vs collected, freshness (getSalesReport, Today › Business)
- [x] Payment milestones and append-only receipts; paid derived from the ledger
- [ ] Consolidate Dashboard / YTD-MTD / Sales MIS with Today › Business (needs founders' confirmation)

Gates after B–D and the browser pass: typecheck ✅ · 1527 tests ✅ · build ✅.
