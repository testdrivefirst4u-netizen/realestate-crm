/** GET /api/v1/users — read-only users / sales owners (no phone or e-mail). Auth: Authorization: Bearer <read key>. */
import { readUsers, serveRead } from '@/server/modules/dataApi';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (req: Request) => serveRead(req, () => readUsers());
