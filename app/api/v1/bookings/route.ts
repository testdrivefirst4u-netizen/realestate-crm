/** GET /api/v1/bookings — read-only bookings (booked/sold units). Auth: Authorization: Bearer <read key>. */
import { readBookings, serveRead } from '@/server/modules/dataApi';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (req: Request) => serveRead(req, readBookings);
