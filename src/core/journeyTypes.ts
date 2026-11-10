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
  counts: Record<string, number>;
}
export interface TeamData {
  generatedAt: string; slaHours: number;
  unassigned: QueueRow[]; untouchedPastSla: QueueRow[]; visitsNext48h: QueueRow[]; stalled: QueueRow[];
  missedCalls: TodayData['missedCalls'];
  approvals: Array<{ id: string; kind: string; leadId: string; unitId: string; requestedBy: string; at: string }>;
  discountApprovals: Array<{ id: string; leadId: string; unitId: string; version: number; discount: number; total: number; by: string; at: string }>;
  workload: Array<{ userId: string; name: string; role: string; open: number; overdue: number; untouched: number }>;
}
export interface SalesReport {
  range: { from: string; to: string }; enquiries: number;
  funnel: Array<{ step: string; reached: number; reconstructed: number; stageOnly: number; percentOfEnquiries: number }>;
  sla: { hours: number; eligible: number; withinSla: number; respondedLate: number; overdueUnanswered: number; notYetDue: number; responded: number; overallPercent: number | null; ofRespondedPercent: number | null };
  value: Record<'estimated' | 'quoted' | 'booked' | 'collected', { amount: number; basis: string; units?: number; leads?: number; openLeadsWithoutBudget?: number }> & { hiddenUnits: number };
  cancellations: number;
  freshness: { generatedAt: string; newestLeadChange: string; newestProviderEvent: string; lastLeadSnapshot: string; lastSnapshotVerified: boolean | null };
}
