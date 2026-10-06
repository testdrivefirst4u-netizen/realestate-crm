/**
 * GET /api/reports/<snapshotId> — download a saved report snapshot as CSV.
 * Requires a signed-in session with `reports.view`. Every cell is formula-escaped (csvSafe) and quoted.
 */
import { NextResponse } from 'next/server';
import { can, validateSession } from '@/server/core/auth';
import { errEnvelope } from '@/server/core/errors';
import { requestBase, withRequestTenant } from '@/server/core/request';
import { csvSafe, dateKey } from '@/server/core/utils';
import { getReportSnapshot } from '@/server/modules/reports';
import { restrictionFor } from '@/server/core/scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (status: number, code: string, message: string) =>
  NextResponse.json(errEnvelope(code, message), { status, headers: { 'Cache-Control': 'no-store' } });

const csvCell = (v: unknown) => '"' + csvSafe(v).replace(/"/g, '""') + '"';
const csvLine = (cells: unknown[]) => cells.map(csvCell).join(',');

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withRequestTenant(() => handle(_req, ctx));
}

async function handle(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const base = await requestBase();
  const session = await validateSession(base.token);
  if (!session) return json(401, 'AUTH_REQUIRED', 'Please sign in');
  if (!can(session.user, 'reports.view')) return json(403, 'FORBIDDEN', `Your role (${session.user.role}) cannot perform: reports.view`);

  const { id } = await params;
  const snap = await getReportSnapshot(id);
  // snapshots can contain any lead: users limited to their own leads only get the ones they generated
  const own = (await restrictionFor(session.user)) === null || (snap && String(snap.generatedBy).trim().toLowerCase() === session.user.name.trim().toLowerCase());
  if (!snap || !own) return json(404, 'NOT_FOUND', 'Report not found');

  const lines = [csvLine(snap.headers), ...snap.rows.map((r) => csvLine(r))];
  const csv = '﻿' + lines.join('\r\n') + '\r\n';
  const name = `${snap.title} ${dateKey(snap.generatedAt)}`.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() + '.csv';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[";]/g, '_');
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=0',
    },
  });
}
