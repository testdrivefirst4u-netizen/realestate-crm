/**
 * GET /api/files/<fileId> — download a GridFS file (lead documents, call recordings).
 * Requires a signed-in session with `storage.view`. Supports a single byte Range (audio/video seeking).
 */
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { can, validateSession } from '@/server/core/auth';
import { errEnvelope } from '@/server/core/errors';
import { canSeeLead } from '@/server/core/scope';
import { requestBase, withRequestTenant } from '@/server/core/request';
import { openFileStream, statFile } from '@/server/modules/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (status: number, code: string, message: string) =>
  NextResponse.json(errEnvelope(code, message), { status, headers: { 'Cache-Control': 'no-store' } });

/** Shown in the browser: raster images, audio, video and PDF. Everything else (incl. SVG/HTML) downloads. */
function isInline(mime: string) {
  if (mime === 'image/svg+xml') return false;
  return /^image\//.test(mime) || /^audio\//.test(mime) || /^video\//.test(mime) || mime === 'application/pdf';
}

function contentDisposition(kind: 'inline' | 'attachment', name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null; // multi-range / malformed → full response
  let start: number;
  let endIncl: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!suffix) return 'invalid';
    start = Math.max(0, size - suffix);
    endIncl = size - 1;
  } else {
    start = Number(m[1]);
    endIncl = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > endIncl) return 'invalid';
  return { start, end: endIncl + 1 };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withRequestTenant(() => handle(req, ctx));
}

async function handle(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const base = await requestBase();
  const session = await validateSession(base.token);
  if (!session) return json(401, 'AUTH_REQUIRED', 'Please sign in');
  if (!can(session.user, 'storage.view')) return json(403, 'FORBIDDEN', `Your role (${session.user.role}) cannot perform: storage.view`);

  const { id } = await params;
  const info = await statFile(id);
  // lead files follow the lead's visibility (RMs: own leads) — same answer as a missing file
  if (!info || !(await canSeeLead(session.user, info.leadId))) return json(404, 'NOT_FOUND', 'File not found');

  const headers: Record<string, string> = {
    'Content-Type': info.mime,
    'Content-Disposition': contentDisposition(isInline(info.mime) ? 'inline' : 'attachment', info.name),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=0',
    'Accept-Ranges': 'bytes',
  };
  if (info.mime !== 'application/pdf') headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";

  const range = parseRange(req.headers.get('range'), info.size);
  if (range === 'invalid') {
    return new NextResponse(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${info.size}` } });
  }
  if (info.size === 0) return new NextResponse(new Uint8Array(0), { status: 200, headers: { ...headers, 'Content-Length': '0' } });

  const stream = await openFileStream(info, range || undefined);
  const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  if (range) {
    return new NextResponse(body, {
      status: 206,
      headers: { ...headers, 'Content-Length': String(range.end - range.start), 'Content-Range': `bytes ${range.start}-${range.end - 1}/${info.size}` },
    });
  }
  return new NextResponse(body, { status: 200, headers: { ...headers, 'Content-Length': String(info.size) } });
}
