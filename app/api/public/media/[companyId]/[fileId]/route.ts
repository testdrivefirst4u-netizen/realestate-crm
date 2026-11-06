/**
 * GET /api/public/media/<company>/<file>?sig=… — a social post image or video, or a WhatsApp attachment, for the platforms to fetch.
 * Only those files and only with the signature the CRM made for them. Videos can be asked for in ranges.
 */
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { runWithTenant } from '@/server/core/tenant';
import { getTenantById } from '@/server/platform/registry';
import { mediaSigOk, POST_IMAGE_CATEGORY } from '@/server/modules/socialPosts';
import { POST_VIDEO_CATEGORY } from '@/server/modules/socialPostVideo';
import { WHATSAPP_FILE_CATEGORY } from '@/server/modules/chat360';
import { openFileStream, statFile } from '@/server/modules/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const notFound = () => new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function GET(req: Request, ctx: { params: Promise<{ companyId: string; fileId: string }> }) {
  const { companyId, fileId } = await ctx.params;
  const sig = new URL(req.url).searchParams.get('sig') || '';
  if (!/^[a-f0-9]{24}$/i.test(fileId) || !sig || !mediaSigOk(companyId, fileId, sig)) return notFound();
  const tenant = await getTenantById(companyId);
  if (!tenant || tenant.status !== 'Active') return notFound();
  return runWithTenant(tenant, async () => {
    const info = await statFile(fileId);
    const image = info?.category === POST_IMAGE_CATEGORY && /^image\//.test(info.mime);
    const video = info?.category === POST_VIDEO_CATEGORY && /^video\//.test(info.mime);
    const whatsapp = info?.category === WHATSAPP_FILE_CATEGORY;
    if (!info || (!image && !video && !whatsapp)) return notFound();
    const headers = { 'Content-Type': info.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
    const asked = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range') || '');
    if (asked) {
      const start = Number(asked[1]);
      const end = Math.min(asked[2] ? Number(asked[2]) + 1 : info.size, info.size);
      if (start >= end) return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
      const part = await openFileStream(info, { start, end });
      return new NextResponse(Readable.toWeb(part) as unknown as ReadableStream, { status: 206, headers: { ...headers, 'Content-Length': String(end - start), 'Content-Range': `bytes ${start}-${end - 1}/${info.size}` } });
    }
    const stream = await openFileStream(info);
    return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers: { ...headers, 'Content-Length': String(info.size) } });
  });
}
