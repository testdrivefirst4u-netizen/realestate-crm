/**
 * GET /api/public/media/<company>/<file>?sig=… — a social post image for Instagram, Pinterest and Google to fetch.
 * Only files of the post scheduler (category 'Social posts') and only with the signature the CRM made for them.
 */
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { runWithTenant } from '@/server/core/tenant';
import { getTenantById } from '@/server/platform/registry';
import { mediaSigOk, POST_IMAGE_CATEGORY } from '@/server/modules/socialPosts';
import { openFileStream, statFile } from '@/server/modules/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () => new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function GET(req: Request, ctx: { params: Promise<{ companyId: string; fileId: string }> }) {
  const { companyId, fileId } = await ctx.params;
  const sig = new URL(req.url).searchParams.get('sig') || '';
  if (!/^[a-f0-9]{24}$/i.test(fileId) || !sig || !mediaSigOk(companyId, fileId, sig)) return notFound();
  const tenant = await getTenantById(companyId);
  if (!tenant || tenant.status !== 'Active') return notFound();
  return runWithTenant(tenant, async () => {
    const info = await statFile(fileId);
    if (!info || info.category !== POST_IMAGE_CATEGORY || !/^image\//.test(info.mime)) return notFound();
    const stream = await openFileStream(info);
    return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: { 'Content-Type': info.mime, 'Content-Length': String(info.size), 'Cache-Control': 'public, max-age=86400' },
    });
  });
}
