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

## Not verified

- No browser check of Release A screens yet (the inventory drawer notices). Covered in Release B's browser pass.
- No test against a real MongoDB Atlas replica set (transactions, real network failures), real Meta / Chat360 /
  telephony deliveries, or production data volumes.
- Migration scripts were run only against synthetic test databases.
