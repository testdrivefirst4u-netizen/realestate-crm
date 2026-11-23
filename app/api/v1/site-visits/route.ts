/** GET /api/v1/site-visits — read-only site visits. Auth: Authorization: Bearer <read key>. */
import { readSiteVisits, serveRead } from '@/server/modules/dataApi';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (req: Request) => serveRead(req, readSiteVisits);
