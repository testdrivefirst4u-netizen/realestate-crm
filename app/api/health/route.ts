import { NextResponse } from 'next/server';
import { platformDb } from '@/server/core/db';
import { CFG } from '@/server/core/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Liveness + database reachability (for uptime monitors). No data is exposed. */
export async function GET() {
  try {
    await (await platformDb()).command({ ping: 1 });
    return NextResponse.json({ status: 'ok', db: 'ok', version: CFG.VERSION, time: new Date().toISOString() });
  } catch {
    return NextResponse.json({ status: 'error', db: 'unreachable', version: CFG.VERSION }, { status: 503 });
  }
}
