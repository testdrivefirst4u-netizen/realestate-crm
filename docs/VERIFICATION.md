# Verification record

Environment: macOS (Darwin 25.5), Node 24.15.0, MongoDB from `mongodb-memory-server` (in-memory, per test file),
synthetic data only. No production account, database, provider or message was touched.

## Baseline — `main` @ `16b330a` (the reviewed commit; no later upstream commits)

| Gate | Result |
|---|---|
| `npm ci` | OK |
| `npm run typecheck` | OK |
| Full suite (`vitest run`) | 1479 passed, **1 failed** (`server-drip` "goes step by step…"), 3 unhandled teardown errors → exit 1 |

The drip failure was the test, not production: enrolment is stamped with the real clock while the worker in the
test runs on a fixed `noon` (10 Nov 2026), so on any later day the first step was "not due". Fixed in the test.

## Findings reproduced on the original code

`docs/evidence/reproduce-on-main.test.ts`, run in a worktree of `main` — every assertion below **holds on main**
(i.e. the defect is real); the same file fails on this branch because the defects are fixed:

| # | Defect asserted on main | Result on main |
|---|---|---|
| 1 | An agent's bootstrap contains another agent's buyer name, lead id and paid amount | reproduced |
| 2 | 20 simultaneous reservations of one unit: more than one reports success | reproduced |
| 3 | After an admin renames an agent, the agent sees 0 of their leads | reproduced |
| 4 | A telephony event the CRM fails to save is answered HTTP 200 | reproduced |
| 5 | 10 simultaneous bookings of a 2-place visit slot: more than 2 succeed | reproduced |
| 6 | 1 timely reply + 9 ignored enquiries shows 100 % SLA | reproduced |
| 7 | Backups live in the same database (code reading: `server/modules/backups.ts`) | confirmed by inspection |

Prior local work (`~/Claude/crm-test/meta-lead-fixes.patch`, F-001…F-005, Meta lead intake) targets an older base and
does not apply; on current `main` the intake claim / sync-report code had already been rewritten upstream
(`metaSync.ts` counts only `created` / `duplicate`). Not re-applied.

## Release A — results on this branch

| Gate | Result |
|---|---|
| `npm run typecheck` | OK |
| Full suite | **113 files, 1517 tests passed, 0 failed** (before the teardown-noise filter: exit 1 only from 4 `MongoClientClosedError` teardown errors, now ignored by that exact class) |
| `npm run build` | OK |
| `npm audit --omit=dev` | 0 vulnerabilities |

Acceptance checks (all automated):

| Requirement | Test |
|---|---|
| Restricted customer fields never reach unauthorised users (bootstrap, inventory, write responses, event feed; AI context is built from the same redacted data; report snapshots by owner id) | `tests/release-a-inventory.test.ts` |
| Cross-tenant access denied; suspended company's session stops | `tests/release-a-tenancy.test.ts` |
| Renaming an agent preserves ownership and visibility | `tests/release-a-ownership.test.ts` |
| 20 simultaneous attempts to reserve one unit → exactly one winner | `tests/release-a-inventory.test.ts` |
| Concurrent visit bookings cannot exceed capacity | `tests/release-a-visits.test.ts` |
| Repeated provider events → one business result | `tests/release-a-webhooks.test.ts` |
| Database failure before event persistence → 503, never success | `tests/release-a-webhooks.test.ts` |
| 1 timely + 9 overdue unanswered ≠ 100 % overall SLA | `tests/release-a-reporting.test.ts` |
| Isolated restore drill (media, checksums, key) | `tests/release-a-recovery.test.ts` |

## Browser verification (synthetic demo company, local MongoDB, `next dev`)

Seeded with `scripts/seed-demo.ts`; signed in as each synthetic role. Screenshots in `docs/screenshots/`.

| Check | Result |
|---|---|
| Sign-in lands on Today for every role | fixed during the check (the login API still sent everyone to /dashboard) — now verified |
| Agent Today: uncontacted enquiry past SLA, missed call, overdue callback, visit | correct queues and late markers (01, 07) |
| Journey: outcome → next step via keyboard (Enter), visible focus, confirmation | works (02) |
| Journey: people with roles, Dubai local time, consent; quotation; booking gate | works (02, 03); added during the check: pending booking state instead of a second "Ask a manager" button (04), international number formatting, browser `samePhone` respecting country codes |
| Manager Team: approvals, no owner, late, missed calls, visits, workload | works (05); approvals now show unit number and customer name instead of ids; approving books the unit and updates the queue |
| Founder Business: no controls, numbers reconcile with the seed | works (06, 08): booked ₹2.31 Cr, collected ₹13.1 L, no invented estimate, SLA 25 % (1 of 4 due) |
| Mobile 375 px: no horizontal scroll, 44 px targets, visible 2 px focus | verified (07, 08, 09) |

Pre-existing, not caused by this branch: every page logs a React hydration mismatch from the full-page loader
animation (`bc-loader`, `main` commit `73a9991`), which injects markup before hydration. Worth a separate fix.

Final gates: typecheck ✅ · 115 files / 1527 tests ✅ · build ✅.

## Release E (RERA schedule, engagement)

`tests/release-e-rera-engagement.test.ts` (9 tests): plan validation (100 %, agreement reference, ≤ 10 % before registration,
managers only); booking → 10 % cap on receipts and demands → registered agreement → stage certification raises one demand →
interest at the entered rate → demand letter totals; another agent is refused the statement; deviations need a reason;
oldest-first allocation; engagement health thresholds; SOP customer steps closed by logged touches; Today lists the customer.

Browser (synthetic demo, desktop and 375 px): customer engagement and steps (11), payments statement (10, 15), demand letter (12),
Today customer queue (13), Team construction and plans (14). Fixed during the check: the booking checklist and quotation form
showed on already-booked units; the demand letter opened off-screen; amounts wrapped on mobile; the customer queue named the
selling agent as if they were the owner.

Final gates: typecheck ✅ · 116 files / 1535 tests ✅ · build ✅.

## Not verified

- RERA rules against the notified Telangana gazette text and Amaya's registered agreement (needs counsel).

- Older screens (Dashboard, MIS, Inventory grid) were not restyled or re-checked visually.
- Offline and error states of Today were implemented but only exercised in code, not by cutting the network.
- No test against a real MongoDB Atlas replica set (transactions, real network failures), real Meta / Chat360 /
  telephony deliveries, or production data volumes.
- Migration scripts were run only against synthetic test databases.
