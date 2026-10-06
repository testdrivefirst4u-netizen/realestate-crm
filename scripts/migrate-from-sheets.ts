/**
 * One-off migration: Google Sheet (old CRM database) → MongoDB.
 *
 *   1. In the CRM spreadsheet: File → Download → Microsoft Excel (.xlsx)
 *   2. npx tsx scripts/migrate-from-sheets.ts ./Amaya-CRM.xlsx --company amaya --dry-run   (report only, writes nothing)
 *   3. npx tsx scripts/migrate-from-sheets.ts ./Amaya-CRM.xlsx --company amaya             (import into an empty company database)
 *      npx tsx scripts/migrate-from-sheets.ts ./Amaya-CRM.xlsx --company amaya --wipe      (re-run: clears imported collections first)
 *
 * The company must exist (scripts/create-company.ts); everything is written inside its context (its own
 * database), and every imported user's e-mail is claimed in the platform directory (conflicts → warnings).
 *
 * Imports every tab of the old CRM (Enquiry Log, Archived Leads, Tasks, Inventory, Users, Timeline, Events,
 * Chat360 Messages/Contacts, Calls, Documents, Templates, Notes, Checklist, Config, Settings, Audit Log, Error Log).
 * Not imported: Sessions (everyone signs in again), Code Versions (Developer Mode is retired), Report Snapshots
 * (they point at Drive files). Secrets from Script Properties cannot be exported — re-enter them in
 * Settings → Integrations or set them as environment variables.
 *
 * Users keep their passwords: the old salted SHA-256 hashes are imported and upgraded to bcrypt at first sign-in.
 * Id counters are moved past the highest imported id so new records never reuse an old id.
 * Sheet date-times are wall-clock Asia/Kolkata; they are converted to real instants here.
 */
import fs from 'node:fs';
import path from 'node:path';

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}

type Row = Record<string, unknown>;

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const ci = args.indexOf('--company');
  const companySlug = ci >= 0 ? args[ci + 1] || '' : '';
  const file = args.find((a, i) => !a.startsWith('--') && i !== ci + 1);
  const dryRun = args.includes('--dry-run');
  const wipe = args.includes('--wipe');
  if (!file || !fs.existsSync(file) || !companySlug || companySlug.startsWith('--')) {
    console.error('Usage: npx tsx scripts/migrate-from-sheets.ts <export.xlsx> --company <slug> [--dry-run] [--wipe]');
    process.exit(1);
  }
  const { getTenantBySlug, claimEmail, PCOLL } = await import('../server/platform/registry');
  const { runWithTenant } = await import('../server/core/tenant');
  const tenant = await getTenantBySlug(companySlug);
  if (!tenant) {
    console.error(`No company with slug "${companySlug}". Create it first: npx tsx scripts/create-company.ts …`);
    process.exit(1);
  }
  console.log(`Company: ${tenant.name} (${tenant.id}) → database "${tenant.dbName}"`);

  const ExcelJS = (await import('exceljs')).default;
  const { CFG } = await import('../server/core/config');
  const { col, getDb, pcol, ensureCounterAtLeast, bumpVersion } = await import('../server/core/db');
  const { makeZoned, parseDate, str, num, bool, last10, e164, normalizeUnitType, safeJsonParse } = await import('../server/core/utils');
  const { blankLeadDoc, fromUiPatch, parseFollowup, FOLLOWUP_RE } = await import('../server/core/leadShape');
  const { normalizeRole } = await import('../server/core/auth');

  /* ------------------------------ read workbook ------------------------------ */

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  /** exceljs reads a sheet date-time as if it were UTC; re-anchor the wall clock to the CRM zone. */
  const fixDate = (d: Date) => makeZoned(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());

  const cellValue = (v: any): unknown => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return fixDate(v);
    if (typeof v === 'object') {
      if ('result' in v) return cellValue(v.result); // formula
      if ('richText' in v) return (v.richText as any[]).map((r) => r.text).join('');
      if ('text' in v) return String(v.text); // hyperlink
      if ('error' in v) return '';
    }
    return v;
  };

  const readTab = (name: string): Row[] => {
    const ws = wb.getWorksheet(name);
    if (!ws) return [];
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => (headers[i] = String(cellValue(c.value) ?? '').trim()));
    const rows: Row[] = [];
    ws.eachRow({ includeEmpty: false }, (r, n) => {
      if (n === 1) return;
      const o: Row = {};
      let any = false;
      r.eachCell({ includeEmpty: true }, (c, i) => {
        const h = headers[i];
        if (!h) return;
        const v = cellValue(c.value);
        if (v !== '' && v !== null) any = true;
        o[h] = v;
      });
      if (any) rows.push(o);
    });
    return rows;
  };

  const date = (v: unknown) => (v instanceof Date ? v : parseDate(v));
  const seqOf = (id: unknown) => {
    const m = String(id ?? '').match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : 0;
  };
  const report: Array<[string, number, string?]> = [];
  const warnings: string[] = [];

  /* --------------------------------- leads ---------------------------------- */

  /** A sheet row → lead document (same conversion the API uses for updates). */
  const toLeadDoc = (r: Row) => {
    const id = str(r[CFG.LEAD.ID]);
    const doc: any = blankLeadDoc(id);
    const ui: Record<string, unknown> = {};
    const fu: any[] = [];
    for (const [k, v] of Object.entries(r)) {
      const m = k.match(FOLLOWUP_RE);
      if (m) {
        const text = str(v instanceof Date ? v.toISOString() : v);
        if (text) fu.push(parseFollowup(Number(m[1]), text, ''));
      } else if (k !== 'Archived At' && k !== 'Archived By') {
        ui[k] = v;
      }
    }
    const p = fromUiPatch(ui);
    Object.assign(doc, p.set);
    doc.extra = { ...doc.extra, ...p.extra };
    doc.followups = fu.sort((a, b) => a.n - b.n);
    doc.unitType = normalizeUnitType(doc.unitType);
    doc.phoneLast10 = last10(doc.phone);
    doc.createdAt = doc.createdAt || doc.enquiryDate || new Date();
    doc.updatedAt = doc.updatedAt || doc.createdAt;
    doc.updatedBy = doc.updatedBy || 'Migration';
    return doc;
  };

  const leadRows = readTab('Enquiry Log');
  const leads: any[] = [];
  const seenLeadIds = new Set<string>();
  for (const r of leadRows) {
    const id = str(r[CFG.LEAD.ID]);
    if (!id) {
      warnings.push(`Enquiry Log: skipped a row without Enquiry ID (${str(r[CFG.LEAD.NAME]) || 'no name'})`);
      continue;
    }
    if (seenLeadIds.has(id)) {
      warnings.push(`Enquiry Log: duplicate Enquiry ID ${id} — kept the first row`);
      continue;
    }
    seenLeadIds.add(id);
    leads.push(toLeadDoc(r));
  }
  report.push(['leads (Enquiry Log)', leads.length]);

  const archived = readTab('Archived Leads')
    .filter((r) => str(r[CFG.LEAD.ID]) && !seenLeadIds.has(str(r[CFG.LEAD.ID])))
    .map((r) => ({ ...toLeadDoc(r), archivedAt: date(r['Archived At']) || new Date(), archivedBy: str(r['Archived By']) || 'Migration' }));
  report.push(['archivedLeads', archived.length]);

  /* --------------------------------- users ---------------------------------- */

  const usedEmails = new Set<string>();
  const users = readTab('Users')
    .filter((r) => str(r['User ID']) && str(r['Email']))
    .filter((r) => {
      const e = str(r['Email']).toLowerCase();
      if (usedEmails.has(e)) {
        warnings.push(`Users: duplicate email ${e} — kept the first`);
        return false;
      }
      usedEmails.add(e);
      return true;
    })
    .map((r) => {
      const email = str(r['Email']).toLowerCase();
      const hash = str(r['Password Hash']);
      return {
        _id: str(r['User ID']),
        name: str(r['Name']) || email,
        email,
        emailLower: email,
        passwordHash: hash,
        legacySalt: str(r['Salt']),
        role: normalizeRole(r['Role']),
        status: str(r['Status']) === 'Disabled' ? 'Disabled' : 'Active',
        createdAt: date(r['Created At']) || new Date(),
        lastLoginAt: date(r['Last Login At']),
        mustChangePassword: bool(r['Must Change Password']) || !hash,
        avatar: str(r['Photo']),
      };
    });
  report.push(['users', users.length, 'passwords carried over; upgraded to bcrypt at first sign-in']);

  /* --------------------------------- tasks ---------------------------------- */

  const tasks = readTab('Tasks')
    .filter((r) => str(r['Task ID']) || str(r['Task Name']))
    .map((r, i) => {
      const completed = bool(r['Completed']) || str(r['Status']) === 'Completed';
      return {
        _id: str(r['Task ID']) || `TASK-M${i + 1}`,
        name: str(r['Task Name']),
        lead: str(r['Related Lead']),
        leadId: str(r['Lead ID']),
        dateTime: date(r['Date Time']),
        status: completed ? 'Completed' : 'Pending',
        completed,
        checklist: (() => {
          const v = safeJsonParse<any[]>(r['Checklist'], null);
          return Array.isArray(v) ? v.map((c) => (typeof c === 'string' ? { text: c, checked: false } : { text: str(c?.text), checked: !!c?.checked })) : [];
        })(),
        assignedTo: str(r['Assigned To']),
        createdAt: date(r['Created At']),
        completedAt: date(r['Completed At']),
        snoozedUntil: date(r['Snoozed Until']),
        createdBy: str(r['Created By']),
      };
    });
  report.push(['tasks', tasks.length]);

  /* ------------------------------- inventory -------------------------------- */

  const seenUnits = new Set<string>();
  const units = readTab('Inventory')
    .filter((r) => str(r['Inventory ID']) || str(r['Unit Number']))
    .map((r, i) => {
      const unitNumber = str(r['Unit Number']);
      const key = unitNumber.toUpperCase();
      const dupe = !!key && seenUnits.has(key);
      if (key) seenUnits.add(key);
      if (dupe) warnings.push(`Inventory: duplicate unit number ${unitNumber} — imported without the uniqueness key`);
      return {
        _id: str(r['Inventory ID']) || `INV-M${i + 1}`,
        unitNumber,
        ...(key && !dupe ? { unitKey: key } : {}),
        tower: str(r['Tower']),
        floor: str(r['Floor']),
        unitType: normalizeUnitType(r['Unit Type']),
        carpetArea: num(r['Carpet Area']),
        totalArea: num(r['Built-up Area']),
        uds: num(r['UDS']),
        facing: str(r['Facing']),
        status: str(r['Status']) || 'Available',
        price: num(r['Price']),
        availability: str(r['Availability']),
        bookingStatus: str(r['Booking Status']),
        customerName: str(r['Customer Name']),
        contact: str(r['Contact']),
        leadId: str(r['Lead ID']),
        bookedDate: date(r['Booked Date']),
        notes: str(r['Notes']),
        ownership: str(r['Ownership']),
        mortgaged: bool(r['Mortgaged']),
        lastModified: date(r['Last Modified']) || new Date(),
        modifiedBy: str(r['Modified By']) || 'Migration',
        syncStatus: 'Synced',
        syncError: '',
      };
    });
  report.push(['units (Inventory)', units.length]);

  /* ------------------------- timeline, events, logs ------------------------- */

  const timeline = readTab('Timeline')
    .filter((r) => str(r['Lead ID']))
    .map((r, i) => ({
      _id: str(r['Entry ID']) || `TL_m${i}`,
      leadId: str(r['Lead ID']),
      timestamp: date(r['Timestamp']) || new Date(0),
      type: str(r['Type']),
      title: str(r['Title']),
      details: str(r['Details']),
      actor: str(r['Actor']),
      refType: str(r['Ref Type']),
      refId: str(r['Ref ID']),
    }));
  report.push(['activities (Timeline)', timeline.length]);

  const events = readTab('Events')
    .filter((r) => str(r['Event ID']))
    .map((r) => ({
      _id: str(r['Event ID']),
      seq: seqOf(r['Event ID']),
      key: str(r['Event Key']),
      type: str(r['Type']),
      recordType: str(r['Record Type']),
      recordId: str(r['Record ID']),
      title: str(r['Title']),
      message: str(r['Message']),
      createdAt: date(r['Created At']) || new Date(0),
      actor: str(r['Actor']),
      payload: safeJsonParse(r['Payload'], null),
    }));
  report.push(['events', events.length]);

  const audit = readTab('Audit Log').map((r, i) => ({
    _id: str(r['Log ID']) || `LOG_m${i}`,
    timestamp: date(r['Timestamp']) || new Date(0),
    user: str(r['User']),
    role: str(r['Role']),
    action: str(r['Action']),
    entityType: str(r['Entity Type']),
    entityId: str(r['Entity ID']),
    details: str(r['Details']),
    ip: '',
  }));
  report.push(['auditLogs', audit.length]);

  const errors = readTab('Error Log').map((r) => ({
    timestamp: date(r['Timestamp']) || new Date(0),
    scope: str(r['Scope']),
    code: str(r['Code']),
    message: str(r['Message']),
    stack: str(r['Stack']),
    user: str(r['User']),
    context: str(r['Context']),
  }));
  report.push(['errorLogs', errors.length]);

  /* ------------------------------- WhatsApp --------------------------------- */

  const seenKeys = new Set<string>();
  const waMessages = readTab('Chat360 Messages')
    .filter((r) => str(r['Phone']))
    .map((r, i) => {
      const eventId = str(r['Event ID']);
      const id = str(r['Message ID']) || `MSG_m${i}`;
      const dedupe = eventId && !seenKeys.has(eventId) ? eventId : '';
      if (dedupe) seenKeys.add(dedupe);
      return {
        _id: id,
        eventId,
        ...(dedupe ? { dedupeKey: dedupe } : {}),
        direction: str(r['Direction']) || 'Inbound',
        phone: e164(r['Phone']),
        phoneLast10: last10(r['Phone']),
        contactName: str(r['Contact Name']),
        leadId: str(r['Lead ID']),
        messageType: str(r['Message Type']) || 'text',
        text: str(r['Text']),
        mediaUrl: str(r['Media URL']),
        status: str(r['Status']),
        timestamp: date(r['Timestamp']) || new Date(0),
        agent: str(r['Agent']),
        raw: '',
        createdAt: date(r['Timestamp']) || new Date(0),
      };
    });
  report.push(['waMessages', waMessages.length]);

  const seenPhones = new Set<string>();
  const waContacts = readTab('Chat360 Contacts')
    .filter((r) => {
      const k = last10(r['Phone']);
      if (!k || seenPhones.has(k)) return false;
      seenPhones.add(k);
      return true;
    })
    .map((r) => ({
      phone: e164(r['Phone']),
      phoneLast10: last10(r['Phone']),
      contactName: str(r['Contact Name']),
      leadId: str(r['Lead ID']),
      lastMessageAt: date(r['Last Message At']),
      lastMessage: str(r['Last Message']),
      unreadCount: num(r['Unread Count']),
      assignedRM: str(r['Assigned RM']),
      status: str(r['Status']) || 'Open',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  report.push(['waContacts', waContacts.length]);

  /* --------------------------------- calls ---------------------------------- */

  const lines = (v: unknown) => {
    const s = str(v);
    const p = safeJsonParse<unknown>(s, null);
    return Array.isArray(p) ? p.map(String) : s.split('\n').map((x) => x.replace(/^[-•]\s*/, '').trim()).filter(Boolean);
  };
  const calls = readTab('Calls')
    .filter((r) => str(r['Call ID']))
    .map((r) => ({
      _id: str(r['Call ID']),
      leadId: str(r['Lead ID']),
      customerName: str(r['Customer Name']),
      phone: str(r['Phone']),
      phoneLast10: last10(r['Phone']),
      direction: str(r['Direction']) === 'Inbound' ? 'Inbound' : 'Outbound',
      callDate: date(r['Call Date']),
      startTime: date(r['Start Time']),
      endTime: date(r['End Time']),
      durationSec: Math.max(0, Math.round(num(r['Duration (sec)']))),
      status: str(r['Status']) || 'Completed',
      outcome: str(r['Outcome']),
      provider: str(r['Provider']),
      providerCallId: str(r['Provider Call ID']),
      // Drive recordings stay where they are; the link keeps working for people with Drive access.
      recordingUrl: str(r['Recording URL']),
      recordingFileId: '',
      transcriptFileId: '',
      driveRecordingFileId: str(r['Recording File ID']),
      transcript: str(r['Transcript']),
      aiSummary: str(r['AI Summary']),
      keyPoints: lines(r['Key Points']),
      followupActions: lines(r['Follow-up Actions']),
      loggedBy: str(r['Logged By']),
      createdAt: date(r['Created At']) || new Date(),
      notes: str(r['Notes']),
    }));
  report.push(['calls', calls.length, 'recordings remain in Google Drive (links kept)']);

  /* ------------------------------ records ----------------------------------- */

  const documents = readTab('Documents')
    .filter((r) => str(r['Document ID']))
    .map((r) => {
      const url = str(r['File URL']);
      return {
        _id: str(r['Document ID']),
        leadId: str(r['Lead ID']),
        name: str(r['Name']),
        category: str(r['Category']),
        fileUrl: /^https:\/\//i.test(url) ? url : '',
        driveFileId: str(r['Drive File ID']),
        uploadedDate: date(r['Uploaded Date']) || new Date(),
        uploadedBy: str(r['Uploaded By']),
        description: str(r['Description']),
      };
    });
  report.push(['documents', documents.length, 'files remain in Google Drive (links kept)']);

  const templates = readTab('Templates')
    .filter((r) => str(r['Template ID']))
    .map((r) => ({ _id: str(r['Template ID']), type: str(r['Type']) || 'WhatsApp', name: str(r['Name']), message: str(r['Message']), updated: date(r['Updated']) || new Date() }));
  report.push(['templates', templates.length]);

  const notes = readTab('Notes')
    .filter((r) => str(r['Note ID']) && str(r['User ID']))
    .map((r) => ({ _id: str(r['Note ID']), userId: str(r['User ID']), text: str(r['Text']), created: date(r['Created']) || new Date(), updated: date(r['Updated']) || new Date() }));
  report.push(['notes', notes.length]);

  const checklist = readTab('Checklist')
    .filter((r) => str(r['Item ID']) && str(r['User ID']))
    .map((r) => ({ _id: str(r['Item ID']), userId: str(r['User ID']), text: str(r['Text']), completed: bool(r['Completed']), updated: date(r['Updated']) || new Date() }));
  report.push(['checklistItems', checklist.length]);

  /* --------------------------- config & settings ---------------------------- */

  const dropdowns = readTab('Config')
    .filter((r) => str(r['Field']) && str(r['Option']))
    .map((r, i) => ({ field: str(r['Field']), option: str(r['Option']), order: i }));
  report.push(['dropdownOptions (Config)', dropdowns.length]);

  const RETIRED_SETTINGS = ['deploymentId', 'devAutoDeploy'];
  const settings = readTab('Settings')
    .filter((r) => str(r['Key']) && !RETIRED_SETTINGS.includes(str(r['Key'])))
    .map((r) => ({ _id: str(r['Key']), value: str(r['Value']), updatedAt: date(r['Updated At']) || new Date(), updatedBy: str(r['Updated By']) || 'Migration' }));
  report.push(['settings', settings.length]);

  /* ------------------------------ integrity --------------------------------- */

  const leadIds = new Set([...leads, ...archived].map((l) => l._id));
  const orphanTasks = tasks.filter((t) => t.leadId && !leadIds.has(t.leadId)).length;
  const orphanCalls = calls.filter((c) => c.leadId && !leadIds.has(c.leadId)).length;
  if (orphanTasks) warnings.push(`${orphanTasks} task(s) point at a Lead ID that no longer exists (kept as-is)`);
  if (orphanCalls) warnings.push(`${orphanCalls} call(s) point at a Lead ID that no longer exists (kept as-is)`);
  const phoneDupes = new Map<string, number>();
  leads.forEach((l) => l.phoneLast10 && phoneDupes.set(l.phoneLast10, (phoneDupes.get(l.phoneLast10) || 0) + 1));
  const dupeCount = [...phoneDupes.values()].filter((n) => n > 1).length;
  if (dupeCount) warnings.push(`${dupeCount} phone number(s) appear on more than one lead (kept; review in the CRM)`);
  const fuTotal = leads.reduce((s, l) => s + l.followups.length, 0);

  console.log('\nAmaya CRM migration — ' + path.basename(file) + (dryRun ? ' (DRY RUN)' : ''));
  console.log('─'.repeat(64));
  for (const [name, n, note] of report) console.log(`${name.padEnd(28)} ${String(n).padStart(7)}${note ? '   ' + note : ''}`);
  console.log(`${'follow-up entries'.padEnd(28)} ${String(fuTotal).padStart(7)}`);
  console.log('─'.repeat(64));
  if (warnings.length) {
    console.log('Warnings:');
    warnings.slice(0, 50).forEach((w) => console.log('  • ' + w));
    if (warnings.length > 50) console.log(`  … and ${warnings.length - 50} more`);
  }
  if (dryRun) {
    console.log('\nDry run only — nothing was written.');
    process.exit(0);
  }

  /* ---------------------------------- write --------------------------------- */

  // Every database access below runs inside the company's context (tenant isolation guard in db.ts).
  await runWithTenant(tenant, async () => {
  const db = await getDb();
  const targets: Array<[string, any[]]> = [
    [CFG.COLL.LEADS, leads], [CFG.COLL.ARCHIVE, archived], [CFG.COLL.USERS, users], [CFG.COLL.TASKS, tasks],
    [CFG.COLL.INVENTORY, units], [CFG.COLL.TIMELINE, timeline], [CFG.COLL.EVENTS, events], [CFG.COLL.AUDIT_LOG, audit],
    [CFG.COLL.ERROR_LOG, errors], [CFG.COLL.CHAT_MESSAGES, waMessages], [CFG.COLL.CHAT_CONTACTS, waContacts],
    [CFG.COLL.CALLS, calls], [CFG.COLL.DOCUMENTS, documents], [CFG.COLL.TEMPLATES, templates], [CFG.COLL.NOTES, notes],
    [CFG.COLL.CHECKLIST, checklist], [CFG.COLL.CONFIG, dropdowns], [CFG.COLL.SETTINGS, settings],
  ];

  const existing = await (await col(CFG.COLL.LEADS)).countDocuments({}, { limit: 1 });
  const existingUsers = await (await col(CFG.COLL.USERS)).countDocuments({}, { limit: 1 });
  if ((existing || existingUsers) && !wipe) {
    console.error('\nThe database already contains data. Re-run with --wipe to replace it (this deletes the imported collections first).');
    process.exit(1);
  }
  if (wipe) {
    for (const [name] of targets) await db.collection(name).deleteMany({});
    await db.collection(CFG.COLL.COUNTERS).deleteMany({});
    await db.collection(CFG.COLL.SESSIONS).deleteMany({});
    // the wiped users' directory entries are re-claimed below for the imported users
    await (await pcol(PCOLL.DIRECTORY)).deleteMany({ companyId: tenant.id });
    console.log('\nCleared existing data.');
  }

  for (const [name, docs] of targets) {
    for (let i = 0; i < docs.length; i += 1000) {
      await db.collection(name).insertMany(docs.slice(i, i + 1000) as any[], { ordered: false });
    }
  }

  // Counters continue after the highest imported ids (never reuse an old id).
  const maxSeq = (list: any[], prefix: string) => list.reduce((m, d) => (String(d._id).startsWith(prefix + '-') ? Math.max(m, seqOf(d._id)) : m), 0);
  const counters: Array<[string, number]> = [
    ['seq:ENQ', maxSeq([...leads, ...archived], 'ENQ')],
    ['seq:USR', maxSeq(users, 'USR')],
    ['seq:TASK', maxSeq(tasks, 'TASK')],
    ['seq:INV', maxSeq(units, 'INV')],
    ['seq:CALL', maxSeq(calls, 'CALL')],
    ['seq:DOC', maxSeq(documents, 'DOC')],
    ['seq:TPL', maxSeq(templates, 'TPL')],
    ['seq:NOTE', maxSeq(notes, 'NOTE')],
    ['seq:CHK', maxSeq(checklist, 'CHK')],
    ['events', events.reduce((m, e) => Math.max(m, e.seq), 0)],
  ];
  for (const [name, n] of counters) if (n > 0) await ensureCounterAtLeast(name, n);
  await bumpVersion();

  // Users sign in by e-mail alone, so each imported e-mail must be registered to this company.
  const claimConflicts: string[] = [];
  for (const u of users) {
    try {
      await claimEmail(u.emailLower);
    } catch (e: any) {
      claimConflicts.push(`${u.emailLower}: ${e?.message || e}`);
    }
  }

  console.log('\nImported. Counters set past the highest existing ids:');
  counters.filter(([, n]) => n > 0).forEach(([k, n]) => console.log(`  ${k.padEnd(10)} → next is ${n + 1}`));
  console.log(`\nPlatform directory: ${users.length - claimConflicts.length} user e-mail(s) registered to ${tenant.name}.`);
  if (claimConflicts.length) {
    console.warn(`Warnings — ${claimConflicts.length} e-mail(s) belong to another company; those users cannot sign in until resolved:`);
    claimConflicts.forEach((w) => console.warn('  • ' + w));
  }
  });
  console.log('\nNext: sign in with an existing account (old passwords work), then re-enter the API keys in');
  console.log('Settings → Integrations (or set them as environment variables) and update the Chat360 and');
  console.log('telephony webhook URLs to the ones shown there.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
