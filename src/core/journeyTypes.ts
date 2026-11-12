/** Browser shapes of the Release B / D server actions (server/modules/journey.ts, workspace.ts, salesReport.ts). */
export type PersonRole = 'enquirer' | 'resident' | 'decisionMaker' | 'payer' | 'referrer' | 'other';
export const PERSON_ROLE_LABEL: Record<PersonRole, string> = { enquirer: 'Enquirer', resident: 'Future resident', decisionMaker: 'Decision-maker', payer: 'Payer', referrer: 'Referrer', other: 'Other' };
export type ConsentState = 'granted' | 'denied' | 'unknown';
export interface Person {
  id: string; name: string; roles: PersonRole[]; relationship: string; phone: string; email: string;
  preferredChannel: '' | 'whatsapp' | 'call' | 'email' | 'sms'; language: string; timeZone: string; bestTime: string;
  consent: { whatsappMarketing: ConsentState; at: string; source: string; evidence: string };
  notes: string; updatedAt: string; updatedBy: string;
}
export const OUTCOMES: Array<{ id: string; label: string; closes: boolean }> = [
  { id: 'connected', label: 'Spoke to them', closes: false },
  { id: 'noAnswer', label: 'No answer', closes: false },
  { id: 'callbackRequested', label: 'Asked to call back', closes: false },
  { id: 'visitAgreed', label: 'Agreed to a visit', closes: false },
  { id: 'familyConsult', label: 'Will discuss with family', closes: false },
  { id: 'wrongNumber', label: 'Wrong number', closes: true },
  { id: 'notInterested', label: 'Not interested', closes: true },
];
export const NEXT_TYPES: Array<{ id: string; label: string }> = [
  { id: 'call', label: 'Call' }, { id: 'whatsapp', label: 'WhatsApp' }, { id: 'visit', label: 'Visit' },
  { id: 'familyMeeting', label: 'Family meeting' }, { id: 'sendQuote', label: 'Send quotation' }, { id: 'other', label: 'Other' },
];
export interface Quote {
  _id: string; leadId: string; unitId: string; version: number; status: 'draft' | 'pendingApproval' | 'approved' | 'rejected' | 'sent' | 'superseded';
  basePrice: number; charges: Array<{ label: string; amount: number }>; discount: number; total: number; validUntil: string | null; createdAt: string; createdBy: string; decidedBy?: string; decisionNote?: string;
}
export interface QueueRow { leadId: string; name: string; phone: string; stage: string; rm: string; at: string; note: string; late: boolean }
export interface TodayData {
  generatedAt: string; slaHours: number;
  newEnquiries: QueueRow[]; overdueFollowups: QueueRow[]; dueToday: QueueRow[]; upcomingVisits: QueueRow[]; noNextAction: QueueRow[];
  missedCalls: Array<{ callId: string; leadId: string; name: string; phone: string; at: string; minutesAgo: number }>;
  tasks: Array<{ taskId: string; name: string; leadId: string; lead: string; at: string; late: boolean }>;
  cooling: QueueRow[];
  customers: Array<{ leadId: string; name: string; owner: string; rm?: string; health: string; due: Array<{ key: string; label: string; late: boolean }> }>;
  counts: Record<string, number>;
}
export interface TeamData {
  generatedAt: string; slaHours: number;
  unassigned: QueueRow[]; untouchedPastSla: QueueRow[]; visitsNext48h: QueueRow[]; stalled: QueueRow[];
  missedCalls: TodayData['missedCalls'];
  approvals: Array<{ id: string; kind: string; leadId: string; leadName: string; unitId: string; unitNumber: string; requestedBy: string; note: string; at: string; quoteTotal: number; quoteDiscount: number; quoteBase: number; listPrice: number }>;
  discountApprovals: Array<{ id: string; leadId: string; leadName: string; unitId: string; unitNumber: string; version: number; discount: number; total: number; by: string; at: string }>;
  workload: Array<{ userId: string; name: string; role: string; open: number; overdue: number; untouched: number }>;
}
export interface SalesReport {
  range: { from: string; to: string }; enquiries: number;
  funnel: Array<{ step: string; reached: number; reconstructed: number; stageOnly: number; percentOfEnquiries: number }>;
  sla: { hours: number; eligible: number; withinSla: number; respondedLate: number; overdueUnanswered: number; notYetDue: number; responded: number; overallPercent: number | null; ofRespondedPercent: number | null };
  value: Record<'estimated' | 'quoted' | 'booked' | 'collected', { amount: number; basis: string; units?: number; leads?: number; openLeadsWithoutBudget?: number }> & { hiddenUnits: number };
  cancellations: number;
  previous?: { range: { from: string; to: string }; enquiries: number; funnel: SalesReport['funnel']; sla: SalesReport['sla']; cancellations: number };
  freshness: { generatedAt: string; newestLeadChange: string; newestProviderEvent: string; lastLeadSnapshot: string; lastSnapshotVerified: boolean | null };
}

/* ----------------------- engagement and RERA payments ----------------------- */
export interface Touch { at: string; channel: string; kind: string; direction: 'in' | 'out'; responded: boolean; source: string; note: string; personId: string }
export interface Health { state: 'engaged' | 'cooling' | 'cold' | 'new'; lastResponseAt: string; lastTouchAt: string; touches30: number; responses30: number; daysSinceResponse: number | null }
export interface EngagementData {
  health: Health;
  people: Array<Health & { personId: string; name: string }>;
  touches: Touch[];
  customer: null | { owner: string; ownerId: string; bookedAt: string; steps: Array<{ step: string; label: string; at: string; by: string }>; due: Array<{ key: string; label: string; late: boolean }> };
}
export const ENGAGEMENT_KINDS: Array<{ id: string; label: string }> = [
  { id: 'progressUpdate', label: 'Progress update' }, { id: 'content', label: 'Content shared' }, { id: 'eventInvite', label: 'Event invite' }, { id: 'eventAttended', label: 'Event attended' },
  { id: 'familyMeeting', label: 'Family meeting' }, { id: 'communityPreview', label: 'Community preview' }, { id: 'welcome', label: 'Welcome' }, { id: 'referralAsk', label: 'Referral ask' },
  { id: 'feedback', label: 'Feedback' }, { id: 'paymentReminder', label: 'Payment reminder' }, { id: 'other', label: 'Other' },
];
export const ENGAGEMENT_CHANNELS = ['call', 'whatsapp', 'email', 'visit', 'event', 'meeting', 'video', 'letter', 'other'];
export interface PaymentPlan { _id: string; name: string; agreementRef: string; gstPct: number; noticeDays: number; stages: Array<{ key: string; label: string; percent: number; trigger: string; stageKey?: string }> }
export interface ConstructionStage { _id: string; label: string; order: number; certifiedOn: string | null; certificateRef: string; certifiedBy: string }
export interface StatementLine { id: string; label: string; amount: number; gst: number; status: 'not due' | 'demanded' | 'part paid' | 'paid' | 'overdue'; paid: number; outstanding: number; dueDate: string; demandNo: string; daysLate: number; interestAccrued: number; trigger: string }
export interface PaymentStatement {
  unitId: string; unitNumber: string; planName: string; agreementRef: string; deviation: boolean; agreementRegisteredAt: string; agreementDocumentNo: string;
  interestRateSource: string; projectRegistration: string; interestRatePct: number | null; unallocated: number;
  lines: StatementLine[];
  totals: { agreed: number; gst: number; paid: number; demanded: number; outstandingDemanded: number; overdue: number; interestAccrued: number; advanceCap: number | null };
}
export interface DemandLetter { demandNo: string; date: string; to: string; unit: string; project: string; agreementRef: string; instalment: string; amount: number; gst: number; total: number; dueDate: string; note: string }

/* ------------------------------ organisation ------------------------------ */
export interface OrgPerson { id: string; name: string; role: string; status: string; level: number | null; reportsTo: string; leadScope: 'team' | 'all' }
export type Measure = 'enquiries' | 'respondedInTime' | 'contacted' | 'calls' | 'visits' | 'quotations' | 'bookings' | 'bookedValue' | 'collections' | 'touches';
export const MEASURE_LABEL: Record<Measure, string> = {
  enquiries: 'New enquiries', respondedInTime: 'Answered in time', contacted: 'Contacted', calls: 'Connected calls', visits: 'Visits done',
  quotations: 'Quotations', bookings: 'Bookings', bookedValue: 'Booked value', collections: 'Collected', touches: 'Customer touches',
};
export const TARGETABLE: Measure[] = ['contacted', 'calls', 'visits', 'quotations', 'bookings', 'bookedValue', 'collections', 'touches', 'respondedInTime'];
export type Counts = Record<Measure, number> & { slaEligible: number; slaWithin: number };
export interface ScoreRow { id: string; name: string; role: string; level: number | null; levelName: string; reportsTo: string; depth: number; own: Counts; team: Counts; prevOwn: Counts; prevTeam: Counts; hasTeam: boolean; targets: Partial<Record<Measure, number>> }
export interface Scorecard { month: string; prevMonth: string; levels: string[]; rows: ScoreRow[]; total: Counts; prevTotal: Counts; mine: ScoreRow | null; canSetTargetsFor: string[] }

/* -------------------------------- insights -------------------------------- */
export type Urgency = 'now' | 'today' | 'this week';
export interface Suggestion { key: string; title: string; why: string; urgency: Urgency; nextType: string; at: string; personId: string; personName: string; timeNote: string }
export interface Insight {
  leadId: string; name: string; stageLabel: string; score: number; scoreLabel: string;
  signals: Array<{ label: string; points: number }>; next: Suggestion | null;
  also: Array<{ key: string; title: string; why: string; urgency: Urgency }>; risks: string[];
}
