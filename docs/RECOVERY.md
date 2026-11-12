# Recovery runbook — Amaya CRM

What can be lost, where each copy lives, and how to prove a restore works. Written for the operator (platform
support / developer), not for sales staff.

## 1. What exists today — and what is not evidenced

| Layer | What it is | Where it lives | Survives losing the database? |
|---|---|---|---|
| In-app lead snapshots (Settings › Backups) | Daily gzip of the `leads` collection, 14 kept, read back by a daily restore test | **Inside the same company database** (`leadBackups`) | **No.** Good for undoing a bad import or bulk edit only |
| Independent export (`scripts/recovery.ts export`) | Every collection of a company, including GridFS media (`files.files`, `files.chunks`: lead documents, call recordings), as EJSON + a SHA-256 manifest | A directory you choose, outside MongoDB | **Yes**, if that directory is stored elsewhere |
| MongoDB Atlas backups / point-in-time restore | Cluster-level snapshots | Atlas | Yes — **but there is no evidence in this repository that they are switched on.** The README only recommends an M10+ cluster. Check *Atlas › Cluster › Backup* and record the policy below |
| `SECRETS_ENCRYPTION_KEY` | Decrypts every stored API key / token (`secrets` collection) | Vercel env (and wherever it was generated) | Not by any backup. **Without it the exported secrets are unreadable**; every integration then has to be reconnected |
| Platform directory (`amaya_platform`) | Companies, e-mail → company map, super admins, Meta page claims | Same cluster, separate database | Export it the same way (`--company` is not needed: point the script's source at it) |

Record here once confirmed (do not fill in without checking the Atlas console):

- Atlas backup policy: _unverified_
- Point-in-time window: _unverified_
- Where exports are stored (bucket / drive), who can read them: _unverified_
- Where `SECRETS_ENCRYPTION_KEY` is kept besides Vercel: _unverified_

## 2. Recovery objectives (proposed, to be agreed)

- RPO (data you can afford to lose): 24 h with nightly exports; minutes only if Atlas PITR is confirmed on.
- RTO (time to working CRM): 2 h for one company.

## 3. Taking an independent export

```bash
MONGODB_URI=… npx tsx scripts/recovery.ts export --company amaya --out /secure/exports/amaya-2026-11-10
```

The export contains customer personal data and encrypted secrets: store it encrypted, with access limited to the
people who may restore. It skips short-lived collections (sessions, login attempts, rate limits).

## 4. Restore drill (isolated — run monthly and after schema changes)

Never restore over a live database. The script refuses a target that is not empty and requires a database name
starting with `restore_`.

```bash
# best: a separate, non-production cluster
RESTORE_MONGODB_URI=<drill cluster> SECRETS_ENCRYPTION_KEY=<from the password manager> \
MONGODB_URI=<production, read access is enough> \
npx tsx scripts/recovery.ts drill --company amaya --out /secure/exports/drill-2026-11-10
```

`drill` = export → restore into a new `restore_drill_…` database → verify → drop. Verification checks, per
collection, the document count and a SHA-256 over the canonical EJSON; that every GridFS file has all its chunks;
and that the supplied key decrypts every stored secret (values are never printed). Exit code 2 = verification
failed. Record the result (date, duration, ok) in the table at the end.

Covered by an automated test: `tests/release-a-recovery.test.ts` (media chunk loss and a wrong key are detected;
a non-empty target is refused).

## 5. Real recovery (database lost or corrupted)

1. Freeze writes: put the company in *Suspended* in Super Admin (webhooks then answer 404; Meta, telephony and
   Chat360 retry on their side for a while — Meta Lead Ads are also recovered by the daily Facebook check).
2. Choose the copy: Atlas PITR to just before the incident if confirmed on; else the newest independent export.
3. Restore into a NEW database (`restore` with `--into restore_amaya_YYYYMMDD`), run `verify`.
4. Point the company at it: in the platform `companies` document set `dbName` to the restored database (one
   field; keep the old one for forensics). Re-activate the company.
5. Check: sign in as an agent and a manager; open a lead with a recording; Settings › Integrations shows each
   connector healthy (if `SECRETS_ENCRYPTION_KEY` was lost, reconnect each integration there).
6. Replay: Settings › Integrations › webhook problems — replay anything dead-lettered; run *Facebook sync* for
   the incident window; JustConnect history sync catches up calls.

## 6. Data migrations on this branch (run on a restored copy first)

| Script | Dry run | Apply | Rollback |
|---|---|---|---|
| `scripts/migrate-owner-ids.ts` (owner ids from names) | default | `--apply` | `--rollback` removes only ids it stamped; names untouched |
| `scripts/backfill-milestones.ts` (journey history) | default | `--apply` | `--rollback` removes only `source: backfill` marks |

New fields written by the app (unit `rev`, `holdUntil`; lead `assignedRmId`, `milestones`; `webhookInbox`,
`visitSlots`, `visitBookings`, `unitOps`, `callClaims` collections) are additive: the previous release ignores
them, so a code rollback needs no data rollback.

## Drill log

| Date | Company | Copy used | Duration | Result | By |
|---|---|---|---|---|---|
| — | — | — | — | not yet run against real data | — |
