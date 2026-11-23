/** GET /api/v1/tasks — read-only tasks / follow-ups. Auth: Authorization: Bearer <read key>. */
import { readTasks, serveRead } from '@/server/modules/dataApi';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (req: Request) => serveRead(req, readTasks);
