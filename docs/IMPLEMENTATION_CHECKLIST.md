# Implementation checklist — Amaya sales foundation

Branch: `improve/amaya-sales-foundation` (from `main` @ `16b330a`, the commit the review covered; no later upstream commits).
Status key: `[ ]` todo · `[~]` in progress · `[x]` done and verified by tests · `[!]` blocked / needs a decision.

## 0. Setup and evidence

- [x] Repository cloned to `~/Claude/realestate-crm`; isolated branch created.
- [x] AGENTS.md read (Next.js 16 warning: read `node_modules/next/dist/docs/` before Next-specific code).
- [x] Supplied review: only the seven findings in the brief were supplied. No separate backlog file was found in the repo or the Amaya folder.
- [x] Prior local work found: `~/Claude/crm-test/meta-lead-fixes.patch` (branch `fix/meta-lead-intake`, F-001…F-005). It was written against an older base and does not apply to `16b330a` (conflicts in 5 files; upstream had already rewritten intake/metaSync). Its findings are re-checked below instead of force-applied.
- [x] "Reverse Engineer Anything" skill: installed on request from `smartworldarafath/REA_Skill` @ `36102f1` (MIT) — **only** `skills/rea-core/reverse-engineer-anything` was copied to `~/.claude/skills/`, after reading it. The other 242 bundled skills (attack payloads, "unblocked prompts", etc.) and the `rea` MCP server were not installed. Without the MCP tools, the skill's method is applied manually: question checklist, evidence ledger (observed / inferred / unknown), bounded searches, and normal repository tools for open-source Frappe CRM.
- [ ] Baseline: typecheck ✅ · full test suite (see `docs/VERIFICATION.md`).

## Release A — access, ownership, booking integrity, release safety

| # | Finding | Reproduced? | Fix | Test |
|---|---|---|---|---|
| A1 | Inventory/bootstrap disclose other agents' customer name, phone, lead ID, money | | | |
| A2 | Concurrent unit updates can both "book" | | | |
| A3 | Renaming an agent orphans their leads (name-based ownership) | | | |
| A4 | Webhooks acknowledge failures with 200; social inbox swallows errors | | | |
| A5 | Visit slots overbook (check then write) | | | |
| A6 | Reports: stage rank as conversion, responded-only SLA, revenue from notes | | | |
| A7 | Recovery: same-database lead snapshots only | | | |
| A8 | Drip test non-determinism (real-time enrolment vs fixed worker clock) | | | |

## Release B — agent workspace and family-to-booking journey
- [ ] Linked people / household per opportunity (enquirer, resident, decision-maker, payer)
- [ ] Contact preferences: channel, language, time zone, consent
- [ ] Owner + next action on every active opportunity; "Today" workspace
- [ ] Visit history (attendees, mode, confirm, reschedule, attended / no-show, feedback)
- [ ] Unit shortlist; versioned, approved quotation
- [ ] Time-limited holds, booking approval, cancellation/release, audit history
- [ ] Few meaningful stage gates

## Release C — integrations and recovery
- [ ] Durable webhook inbox (persist-before-ack, dedupe, retry, dead letter, replay)
- [ ] Connector contract + health / reconnect states
- [ ] WhatsApp consent/suppression policy across manual, campaign, bot, drip
- [ ] Full international phone identity (E.164), suffix-collision tests
- [ ] Recovery runbook + isolated restore procedure

## Release D — reporting and post-sales
- [ ] Event-based funnel, overall SLA, estimated vs quoted vs booked vs collected
- [ ] Payment milestones and receipts (ledger, not an editable total)
- [ ] Viewer/founder report with data freshness
