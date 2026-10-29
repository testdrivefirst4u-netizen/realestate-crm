/**
 * POST /api/calls/recordings — several call recordings in one ZIP (Call History → select → Download recordings).
 * Body: { ids: string[] } (call ids, at most MAX_FILES). Needs a signed-in session with calls.view and storage.view;
 * only calls the user may see are included (the Call History rule: scopeGuards.filterCalls). Files are stored in the
 * ZIP as they are (audio is already compressed) and streamed piece by piece as the browser reads them, named "<who> <yyyy-mm-dd hh-mm>.<ext>".
 */
import { NextResponse } from 'next/server';
import { Zip, ZipPassThrough } from 'fflate';
import { can, validateSession } from '@/server/core/auth';
import { CFG } from '@/server/core/config';
import { col } from '@/server/core/db';
import { errEnvelope } from '@/server/core/errors';
import { isSameOrigin, withRequestTenant } from '@/server/core/request';
import { filterCalls } from '@/server/core/scopeGuards';
import { settingsAll } from '@/server/core/settings';
import { openFileStream, statFile } from '@/server/modules/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// a large download takes a while: let it finish rather than cut the ZIP off part-way
export const maxDuration = 300;

/** Recordings in one download, and their total size. */
const MAX_FILES = 100;
const MAX_BYTES = 300 * 1024 * 1024;

const json = (status: number, code: string, message: string) =>
  NextResponse.json(errEnvelope(code, message), { status, headers: { 'Cache-Control': 'no-store' } });

/** "2026-10-28 13-09" in the company's time zone. */
function stamp(iso: unknown, timeZone: string): string {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}-${p.minute}`;
}

const clean = (s: string) => s.replace(/[^\p{L}\p{N} +_-]/gu, ' ').replace(/\s+/g, ' ').trim();

export async function POST(req: Request) {
  return withRequestTenant((base) => handle(req, base.token));
}

async function handle(req: Request, token: string): Promise<Response> {
  const session = await validateSession(token);
  if (!session) return json(401, 'AUTH_REQUIRED', 'Please sign in');
  if (!can(session.user, 'calls.view') || !can(session.user, 'storage.view')) return json(403, 'FORBIDDEN', 'Your role cannot download call recordings');
  // only from the CRM's own pages (a JSON body cannot be sent by a form on another site without a preflight)
  if (!(await isSameOrigin())) return json(403, 'FORBIDDEN', 'Not allowed from another site');
  if (!String(req.headers.get('content-type') || '').includes('application/json')) return json(400, 'VALIDATION', 'Send the call ids as JSON');

  let body: { ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, 'VALIDATION', 'Send the call ids as JSON');
  }
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return json(400, 'VALIDATION', 'Select the calls to download');
  if (ids.length > MAX_FILES) return json(400, 'VALIDATION', `Download up to ${MAX_FILES} recordings at a time`);

  const rows: any[] = await (await col(CFG.COLL.CALLS))
    .find({ _id: { $in: ids as any[] } }, { projection: { leadId: 1, loggedBy: 1, customerName: 1, phone: 1, startTime: 1, callDate: 1, createdAt: 1, recordingFileId: 1 } })
    .toArray();
  const allowed = (await filterCalls(session.user, rows)).filter((r) => r.recordingFileId);
  if (!allowed.length) return json(404, 'NOT_FOUND', 'None of the selected calls has a recording stored in the CRM');
  // newest first, as the list shows them
  allowed.sort((a, b) => (Date.parse(b.startTime || b.callDate || b.createdAt) || 0) - (Date.parse(a.startTime || a.callDate || a.createdAt) || 0));
  const timeZone = String((await settingsAll()).timeZone || 'Asia/Kolkata');

  // Made as the browser reads it (pull): one recording at a time, piece by piece from storage, so only a few
  // pieces are ever held in memory however many recordings are chosen.
  const out: Uint8Array[] = [];
  let finished = false;
  let failure: unknown = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) failure = err;
    else out.push(chunk);
    if (final) finished = true;
  });
  const used = new Set<string>();
  const skipped: string[] = [];
  let total = 0;
  let next = 0;
  let ended = false;
  let current: { entry: ZipPassThrough; pieces: AsyncIterator<Buffer>; label: string } | null = null;

  /** Feed the ZIP a little more: the next piece of the current recording, or start the next one, or finish. */
  const step = async () => {
    if (current) {
      try {
        const r = await current.pieces.next();
        if (r.done) {
          current.entry.push(new Uint8Array(0), true);
          current = null;
        } else current.entry.push(new Uint8Array(r.value.buffer, r.value.byteOffset, r.value.byteLength));
      } catch {
        skipped.push(`${current.label}: stopped part-way (could not be read)`);
        current.entry.push(new Uint8Array(0), true);
        current = null;
      }
      return;
    }
    if (next < allowed.length) {
      const r = allowed[next++];
      const who = clean(String(r.customerName || '')) || clean(String(r.phone || '')) || 'Call';
      const label = `${who} ${stamp(r.startTime || r.callDate || r.createdAt, timeZone)}`.trim();
      try {
        const info = await statFile(String(r.recordingFileId));
        if (!info) return void skipped.push(`${label}: the file is missing`);
        if (total + info.size > MAX_BYTES) return void skipped.push(`${label}: left out, the download would pass ${Math.round(MAX_BYTES / 1048576)} MB`);
        total += info.size;
        const ext = (/\.[A-Za-z0-9]{1,5}$/.exec(info.name) || ['.wav'])[0];
        let name = label + ext;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${label} (${n})${ext}`;
        used.add(name.toLowerCase());
        const entry = new ZipPassThrough(name);
        zip.add(entry);
        current = { entry, pieces: (await openFileStream(info))[Symbol.asyncIterator](), label };
      } catch {
        skipped.push(`${label}: could not be read`);
      }
      return;
    }
    if (!ended) {
      ended = true;
      if (skipped.length) {
        const note = new ZipPassThrough('Not included.txt');
        zip.add(note);
        note.push(new TextEncoder().encode(skipped.join('\r\n') + '\r\n'), true);
      }
      zip.end();
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!out.length && !finished && !failure) await step();
      if (failure) return controller.error(failure);
      if (out.length) controller.enqueue(out.shift()!);
      else controller.close();
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="Call recordings ${stamp(new Date().toISOString(), timeZone).slice(0, 10)}.zip"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
