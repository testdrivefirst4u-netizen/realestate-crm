/** GET /api/v1/leads — read-only leads for external dashboards. Auth: Authorization: Bearer <read key>. */
import { readLeads, serveRead } from '@/server/modules/dataApi';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (req: Request) => serveRead(req, readLeads);
