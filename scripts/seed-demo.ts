/**
 * Synthetic demo company for local development and screenshots. NEVER run against production: it refuses unless
 * MONGODB_URI points at localhost / 127.0.0.1.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27027 npx tsx scripts/seed-demo.ts
 *
 * Creates company "amaya-demo" with one person per role (password for all: demo-password-1, synthetic accounts):
 *   admin@demo.test (Admin) · meera@demo.test (Manager) · asha@demo.test, ravi@demo.test (Agents) · founder@demo.test (View only)
 * and synthetic families (overseas numbers), units, a missed call, follow-ups, a visit and a pending booking request.
 * All names and numbers are invented.
 */
const uri = process.env.MONGODB_URI || '';
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(uri)) {
  console.error('Refusing: MONGODB_URI must point at a local development database.');
  process.exit(1);
}

async function main() {
  const { createCompany } = await import('../server/platform/companies');
  const { getTenantBySlug } = await import('../server/platform/registry');
  const { runWithTenant } = await import('../server/core/tenant');
  const { createUser, findUserByEmail } = await import('../server/core/auth');
  const { addLead, appendRemark, updateLead } = await import('../server/modules/leads');
  const { addUnit, updateUnit } = await import('../server/modules/inventory');
  const { logCall } = await import('../server/modules/calls');
  const { addTask } = await import('../server/modules/tasks');
  const J = await import('../server/modules/journey');
  const { col } = await import('../server/core/db');
  const PW = 'demo-password-1';

  if (!(await getTenantBySlug('amaya-demo'))) {
    await createCompany({ name: 'Amaya by Vera Vita (demo)', slug: 'amaya-demo', plan: 'enterprise', features: { inventory: true }, admin: { name: 'Admin Demo', email: 'admin@demo.test', password: PW } }, { sa: null, token: '', expiresAt: '', userAgent: 'seed', ip: '' } as any);
  }
  const tenant = (await getTenantBySlug('amaya-demo'))!;
  await runWithTenant(tenant, async () => {
    if (await findUserByEmail('asha@demo.test')) {
      console.log('Demo data already present.');
      return;
    }
    for (const [name, email, role] of [['Meera Iyer', 'meera@demo.test', 'Manager'], ['Asha Menon', 'asha@demo.test', 'RM'], ['Ravi Kumar', 'ravi@demo.test', 'RM'], ['Founder Demo', 'founder@demo.test', 'Viewer']]) {
      await createUser({ name, email, password: PW, role, mustChangePassword: false }, null);
    }
    const ctx = async (email: string) => {
      const u = (await findUserByEmail(email))!;
      return { user: { id: u._id, name: u.name, email: u.email, role: u.role } as any, session: null, token: '', userAgent: 'seed', ip: '', action: 'seed' } as any;
    };
    const meera = await ctx('meera@demo.test');
    const asha = await ctx('asha@demo.test');
    const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
    const ahead = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();

    const L = (await import('../server/core/config')).CFG.LEAD;
    const mk = async (name: string, phone: string, rm: string, src: string, forWhom = 'Parents', unit = '2 BHK', hoursAgo = 2) =>
      (await addLead({ [L.NAME]: name, [L.PHONE]: phone, [L.RM]: rm, [L.SOURCE]: src, [L.ENQUIRED_FOR]: forWhom, [L.UNIT_TYPE]: unit, [L.ENQUIRY_DATE]: ago(hoursAgo) } as any, meera)).lead[L.ID];

    const priya = await mk('Priya Nair', '+971 50 123 4567', 'Asha Menon', 'Website', 'Parents', '2 BHK', 3);
    const kiran = await mk('Kiran Rao', '+1 206 555 0134', 'Asha Menon', 'Meta Ads', 'Parents', '3 BHK', 30);
    const lata = await mk('Lata Subramanian', '+91 98450 11223', 'Asha Menon', 'Reference', 'Self', '2 BHK', 50);
    const dev = await mk('Dev Malhotra', '+44 7700 900123', 'Ravi Kumar', 'Google Ads', 'Father', '2.5 BHK', 5);
    await mk('Sunita Joshi', '+91 99001 22334', '', 'Walk-In', 'Self', '1 BHK', 1);
    await mk('Anand Pillai', '+91 97411 55667', 'Asha Menon', 'Chat360', 'Parents', '3 BHK', 80);

    await appendRemark(kiran, 'Spoke to Kiran; parents keen on ground-floor unit', asha, ahead(-2));
    await updateLead(kiran, { [L.STAGE]: 'Warm' }, asha);
    await appendRemark(lata, 'Visited the experience centre with her daughter', asha, ahead(20));
    await updateLead(lata, { [L.STAGE]: 'Hot', [L.SITE_VISIT_STATUS]: 'Site Visit - Scheduled', [L.SITE_VISIT_DATE]: ahead(26) }, asha);
    await addTask({ name: 'Call back Kiran after 7 pm US time', leadId: kiran, datetime: ago(1), assignedTo: 'Asha Menon' }, asha);
    await logCall({ phone: '+91 97411 55667', direction: 'Inbound', status: 'Missed', provider: 'Exotel', startTime: ago(0.5) }, meera);

    const units = [['T1-101', 'Tower 1', '1', '2 BHK', 9_200_000], ['T1-204', 'Tower 1', '2', '2 BHK', 9_600_000], ['T2-305', 'Tower 2', '3', '3 BHK', 13_400_000], ['T2-402', 'Tower 2', '4', '2.5 BHK', 11_100_000], ['T2-501', 'Tower 2', '5', '3 BHK', 14_200_000]] as const;
    const made: Record<string, any> = {};
    for (const [no, tower, floor, type, price] of units) made[no] = (await addUnit({ unitId: no, tower, floor, unitType: type, price, carpetArea: 1100, facing: 'East' }, meera)).unit;

    // Priya's family: people, quote, payer, reservation and a booking request waiting for Meera
    await J.saveLeadPerson(priya, { id: 'PER-ENQUIRER', name: 'Priya Nair', roles: ['enquirer', 'decisionMaker'], relationship: 'Daughter', phone: '+971 50 123 4567', timeZone: 'Asia/Dubai', preferredChannel: 'whatsapp', language: 'English', consent: { whatsappMarketing: 'granted', source: 'website', evidence: 'Ticked WhatsApp updates on the website form' } }, asha);
    await J.saveLeadPerson(priya, { name: 'Mr & Mrs Nair', roles: ['resident'], relationship: 'Parents', phone: '+91 98470 33445', language: 'Malayalam', bestTime: 'Mornings' }, asha);
    await J.saveLeadPerson(priya, { name: 'Arjun Nair', roles: ['payer'], relationship: 'Son', phone: '+1 415 555 0178', timeZone: 'America/Los_Angeles' }, asha);
    await J.logDisposition({ leadId: priya, outcome: 'visitAgreed', note: 'Virtual tour with parents on video', next: { type: 'visit', at: ahead(30), note: 'Video tour' } }, asha);
    await J.saveQuote({ leadId: priya, unitId: made['T1-204'].inventoryId, charges: [{ label: 'Lifestyle plan (1 year)', amount: 480000 }], discount: 100000 }, asha);
    await updateUnit(made['T1-204'].inventoryId, { status: 'Reserved', leadId: priya, customerName: 'Priya Nair' }, meera, undefined, { expectedRev: 0 });
    await J.requestBooking({ leadId: priya, unitId: made['T1-204'].inventoryId, note: 'Token transfer from US on Friday' }, asha);
    // a large discount waiting for approval on Dev's quote
    await J.saveQuote({ leadId: dev, unitId: made['T2-402'].inventoryId, discount: 600000 }, await ctx('ravi@demo.test'));
    // a booked and partly paid unit for the founder report
    await updateUnit(made['T2-305'].inventoryId, { status: 'Booked', leadId: lata, customerName: 'Lata Subramanian', quotedAmount: 13_100_000, paidAmount: 1_310_000 }, meera, undefined, { expectedRev: 0 });
    await (await col<any>('leadBackups')).countDocuments();
    console.log('Seeded synthetic demo data in', tenant.dbName);
  });
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
