import type { Ctx } from './auth';

/** One backend action. `fn` receives the request's `data` object and the resolved context. */
export interface ActionDef {
  fn: (data: any, ctx: Ctx) => Promise<unknown> | unknown;
  /** Permission required (see CFG.PERMISSIONS). Omit for "any signed-in user". */
  perm?: string;
  /** No session needed (ping, setupStatus, login, createFirstAdmin, logError). */
  public?: boolean;
}

export type ActionMap = Record<string, ActionDef>;
