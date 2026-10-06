/**
 * System actions: health, first-run setup, auth, bootstrap, events, settings, users, logs.
 * (Router_bootstrap and the settings/users entries of apps-script/04_Router.gs.)
 *
 * The eight Developer Mode actions (devStatus … devRollback) were removed with live code editing:
 * code changes now go through Git → CI → Vercel. They answer with a clear message so an old
 * browser tab cannot break.
 */
import type { ActionMap } from '../core/actions';
import {
  auditList, changePassword, createUser, Ctx, deleteUser, hasUsers, listUsers, login, logout, updateProfile, updateUser,
} from '../core/auth';
import { CFG } from '../core/config';
import { getVersion, isTestMode } from '../core/db';
import { fail } from '../core/errors';
import { eventsSince, lastEventId, listErrors, logError } from '../core/events';
import { createFirstAdmin, getSettings, setSecret, settingsPublic, updateSettings } from '../core/settings';
import { nowIso, truncate } from '../core/utils';
import { getAllLeads, getLeadsConfig } from './leads';
import { getAllTasks } from './tasks';
import { getAllUnits } from './inventory';
import { listRecords } from './records';
import { filterByLead } from '../core/scope';
import { filterEvents, filterTasks } from '../core/scopeGuards';

async function bootstrap(d: any, ctx: Ctx) {
  const version = await getVersion();
  if (d && d.since && String(d.since) === String(version)) {
    return { version, serverTime: nowIso(), unchanged: true };
  }
  const [leads, config, tasks, inventory, users, documents, templates, notes, checklist, settings, lastId] = await Promise.all([
    getAllLeads(ctx),
    getLeadsConfig(),
    getAllTasks().then((t) => filterTasks(ctx.user, t)),
    getAllUnits(),
    listUsers(),
    listRecords('documents', ctx).then((rows) => filterByLead(ctx.user, rows, (r: any) => r.leadId)),
    listRecords('templates', ctx),
    listRecords('notes', ctx),
    listRecords('checklist', ctx),
    settingsPublic(),
    lastEventId(),
  ]);
  return {
    version,
    serverTime: nowIso(),
    leads,
    config,
    tasks,
    inventory,
    users: users.filter((u) => u.status !== 'Disabled').map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, avatar: u.avatar || '' })),
    documents,
    templates,
    lastEventId: lastId,
    settings,
    notes,
    checklist,
  };
}

const devRemoved = () => {
  throw fail('NOT_CONFIGURED', 'Developer Mode has been retired. Code changes are now made in the Git repository and deployed through Vercel.');
};

export const actions: ActionMap = {
  /* ---- public ---- */
  // SaaS: companies and their first administrator are created by a platform super admin
  // (/superadmin), so the CRM itself never offers first-run setup.
  ping: {
    public: true,
    fn: async () => ({ message: `${CFG.APP_NAME} backend online`, serverTime: nowIso(), version: CFG.VERSION, setupRequired: isTestMode() ? !(await hasUsers()) : false }),
  },
  setupStatus: {
    public: true,
    fn: async () => ({ hasUsers: isTestMode() ? await hasUsers() : true, version: CFG.VERSION, sheetsReady: true }),
  },
  createFirstAdmin: {
    public: true,
    fn: (d, ctx) => {
      if (!isTestMode()) throw fail('FORBIDDEN', 'Accounts are created by your company administrator. Please sign in.');
      return createFirstAdmin(d, ctx);
    },
  },
  login: { public: true, fn: (d, ctx) => login(d.email, d.password, ctx) },
  logError: {
    public: true,
    fn: async (d, ctx) => {
      // Only signed-in reports (inside a company) are stored.
      if (!ctx.user) return;
      await logError(truncate(d.scope || 'frontend', 60), truncate(d.code || 'FRONTEND', 40), d.message, d.stack, ctx.user.email, d.context);
    },
  },

  /* ---- session ---- */
  me: { fn: (_d, ctx) => ({ user: ctx.user, expiresAt: ctx.session?.expiresAt }) },
  logout: { fn: (_d, ctx) => logout(ctx.token) },
  changePassword: { fn: (d, ctx) => changePassword(ctx, d.currentPassword, d.newPassword) },
  updateProfile: { fn: (d, ctx) => updateProfile(ctx, d.data || d) },

  /* ---- data ---- */
  getBootstrap: { fn: (d, ctx) => bootstrap(d, ctx), perm: 'leads.view' },
  getEvents: {
    fn: async (d, ctx) => {
      const res = await eventsSince(d.sinceId);
      return { ...res, events: await filterEvents(ctx.user, res.events) };
    },
    perm: 'leads.view',
  },

  /* ---- settings / users ---- */
  getSettings: { fn: (_d, ctx) => getSettings(ctx), perm: 'settings.view' },
  updateSettings: { fn: (d, ctx) => updateSettings(d.data, ctx), perm: 'settings.edit' },
  setSecret: { fn: (d, ctx) => setSecret(d.key, d.value, ctx), perm: 'secrets.manage' },
  listUsers: { fn: () => listUsers(), perm: 'users.manage' },
  saveUser: {
    perm: 'users.manage',
    fn: async (d, ctx) => {
      if (d.data && d.data.id) return updateUser(d.data, ctx);
      const created = await createUser(d.data || {}, ctx);
      return { ...created.user, ...(created.temporaryPassword ? { temporaryPassword: created.temporaryPassword } : {}) };
    },
  },
  deleteUser: { fn: (d, ctx) => deleteUser(d.id, ctx), perm: 'users.manage' },
  resetPassword: { fn: (d, ctx) => updateUser({ id: d.id, password: d.newPassword }, ctx), perm: 'users.manage' },
  getAuditLog: { fn: (d) => auditList(d.limit), perm: 'audit.view' },
  getErrorLog: { fn: (d) => listErrors(d.limit), perm: 'settings.view' },

  /* ---- retired Developer Mode ---- */
  devStatus: {
    perm: 'developer.view',
    fn: () => ({ apiEnabled: false, scriptId: '', canDeploy: false, autoDeploy: false, protectedFiles: [], message: 'Developer Mode has been retired: changes go through Git and Vercel.' }),
  },
  devListModules: { fn: () => [], perm: 'developer.view' },
  devGetModule: { fn: devRemoved, perm: 'developer.view' },
  devValidate: { fn: devRemoved, perm: 'developer.view' },
  devSaveModule: { fn: devRemoved, perm: 'developer.edit' },
  devDeploy: { fn: devRemoved, perm: 'developer.deploy' },
  devListVersions: { fn: () => [], perm: 'developer.view' },
  devRollback: { fn: devRemoved, perm: 'developer.deploy' },
};
