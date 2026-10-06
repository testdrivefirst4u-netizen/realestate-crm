/**
 * Meta (Facebook / Instagram) Lead Ads webhook — one URL for the whole platform (see server/modules/metaQueue.ts).
 *
 *   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  → the challenge (text/plain) or 403
 *   POST X-Hub-Signature-256 over the raw body (≤ 1 MB) → 401 when it does not match the app secret;
 *        leadgen changes are queued and the answer is 200 at once; the leads are fetched after the response.
 */
import { after } from 'next/server';
import { handleMetaWebhookGet, handleMetaWebhookPost } from '@/server/modules/metaQueue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  return handleMetaWebhookGet(req);
}

export async function POST(req: Request) {
  return handleMetaWebhookPost(req, (fn) => {
    const run = () => fn().catch((e) => console.error('[webhook:meta] processing failed', e?.message));
    try {
      after(run);
    } catch {
      // outside a Next.js request scope (scripts): run in the background; the cron retries anything left pending
      void run();
    }
  });
}
