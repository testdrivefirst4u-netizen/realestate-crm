/**
 * /api/public/unsubscribe?c=<company>&e=<email>&s=<signature> — the link in every drip e-mail. Opening it only shows a button,
 * because mail scanners open links by themselves; the POST (the button, or the mail app's one-click) records it.
 */
import { NextResponse } from 'next/server';
import { runWithTenant } from '@/server/core/tenant';
import { getTenantById } from '@/server/platform/registry';
import { unsubscribeEmail, unsubSigOk } from '@/server/modules/dripCampaigns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string, status = 200) => new NextResponse(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head><body style="font-family:Arial,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1f2933;line-height:1.5"><h1 style="font-size:20px">${esc(title)}</h1>${body}</body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
);

function read(req: Request) {
  const q = new URL(req.url).searchParams;
  const company = q.get('c') || '', email = (q.get('e') || '').trim().toLowerCase(), sig = q.get('s') || '';
  return { company, email, sig, ok: !!company && !!email && !!sig && unsubSigOk(company, email, sig) };
}

export async function GET(req: Request) {
  const r = read(req);
  if (!r.ok) return page('This link is not valid', '<p>Please use the link from your e-mail.</p>', 404);
  const action = `/api/public/unsubscribe?${new URLSearchParams({ c: r.company, e: r.email, s: r.sig }).toString()}`;
  return page('Stop these e-mails?', `<p>${esc(r.email)} will get no more of these e-mails.</p><form method="post" action="${esc(action)}"><button type="submit" style="padding:10px 18px;font-size:14px;cursor:pointer">Unsubscribe</button></form>`);
}

export async function POST(req: Request) {
  const r = read(req);
  if (!r.ok) return page('This link is not valid', '<p>Please use the link from your e-mail.</p>', 404);
  const tenant = await getTenantById(r.company);
  if (!tenant) return page('This link is not valid', '<p>Please use the link from your e-mail.</p>', 404);
  await runWithTenant(tenant, () => unsubscribeEmail(r.email));
  return page('You are unsubscribed', '<p>You will get no more of these e-mails.</p>');
}
