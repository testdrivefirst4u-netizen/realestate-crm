/**
 * WhatsApp inbox filter chips: All · Unread · Unreplied · New today · Unlinked.
 * Contacts carry only unreadCount / lastMessageAt / leadId; a conversation opened this session adds
 * who wrote last and when it started (ConversationMeta).
 */
import { describe, expect, it } from 'vitest';
import {
  CONTACT_FILTERS,
  contactFlags,
  conversationMeta,
  countContactFilters,
  matchesContactFilter,
  type ConversationMeta,
} from '../src/modules/chat360/Chat360View';
import type { Chat360Contact, Chat360Message } from '../src/types/crm';

const TODAY = '2026-10-03';

const contact = (over: Partial<Chat360Contact>): Chat360Contact => ({
  phone: '919000011111',
  contactName: 'Rahul',
  leadId: 'ENQ-0003',
  lastMessageAt: '2026-10-01T06:00:00.000Z',
  lastMessage: 'Hello',
  unreadCount: 0,
  ...over,
});

const msg = (over: Partial<Chat360Message>): Chat360Message => ({
  id: `MSG-${Math.random().toString(36).slice(2, 8)}`,
  direction: 'Inbound',
  phone: '919000011111',
  text: 'Hi',
  timestamp: '2026-10-01T06:00:00.000Z',
  ...over,
});

describe('CONTACT_FILTERS', () => {
  it('has the five chips in order', () => {
    expect(CONTACT_FILTERS.map((f) => f.label)).toEqual(['All', 'Unread', 'Unreplied', 'New today', 'Unlinked']);
  });
});

describe('conversationMeta', () => {
  it('reads who wrote last and when the conversation started, ignoring pending messages', () => {
    const meta = conversationMeta([
      msg({ timestamp: '2026-10-02T05:00:00.000Z', direction: 'Outbound' }),
      msg({ timestamp: '2026-09-28T09:00:00.000Z', direction: 'Inbound' }),
      msg({ timestamp: '2026-10-02T07:30:00.000Z', direction: 'Inbound' }),
      msg({ id: 'tmp_1', status: 'sending', timestamp: '2026-10-02T08:00:00.000Z', direction: 'Outbound' }),
    ]);
    expect(meta).toEqual({ lastDirection: 'Inbound', lastAt: '2026-10-02T07:30:00.000Z', firstAt: '2026-09-28T09:00:00.000Z' });
  });

  it('is null for an empty conversation', () => {
    expect(conversationMeta([])).toBeNull();
    expect(conversationMeta([msg({ id: 'tmp_2', status: 'sending' })])).toBeNull();
  });
});

describe('contactFlags', () => {
  it('unread contacts are also unreplied', () => {
    const f = contactFlags(contact({ unreadCount: 2 }), null, TODAY);
    expect(f.unread).toBe(true);
    expect(f.unreplied).toBe(true);
  });

  it('a read conversation whose last message is inbound is still unreplied', () => {
    const meta: ConversationMeta = { lastDirection: 'Inbound', lastAt: '2026-10-01T06:00:00.000Z', firstAt: '2026-09-20T06:00:00.000Z' };
    const f = contactFlags(contact({ unreadCount: 0 }), meta, TODAY);
    expect(f.unread).toBe(false);
    expect(f.unreplied).toBe(true);
  });

  it('a conversation we answered last is not unreplied', () => {
    const meta: ConversationMeta = { lastDirection: 'Outbound', lastAt: '2026-10-01T06:00:00.000Z', firstAt: '2026-09-20T06:00:00.000Z' };
    expect(contactFlags(contact({}), meta, TODAY).unreplied).toBe(false);
  });

  it('tolerates the server stamping lastMessageAt a little after the message itself', () => {
    const meta: ConversationMeta = { lastDirection: 'Inbound', lastAt: '2026-10-01T06:00:00.000Z', firstAt: '2026-09-20T06:00:00.000Z' };
    expect(contactFlags(contact({ lastMessageAt: '2026-10-01T06:00:20.000Z' }), meta, TODAY).unreplied).toBe(true);
  });

  it('ignores a loaded conversation once a newer message has arrived (e.g. a colleague replied)', () => {
    const meta: ConversationMeta = { lastDirection: 'Inbound', lastAt: '2026-10-01T06:00:00.000Z', firstAt: '2026-09-20T06:00:00.000Z' };
    expect(contactFlags(contact({ lastMessageAt: '2026-10-01T09:00:00.000Z', unreadCount: 0 }), meta, TODAY).unreplied).toBe(false);
    // …but a new unread inbound message still counts
    expect(contactFlags(contact({ lastMessageAt: '2026-10-01T09:00:00.000Z', unreadCount: 1 }), meta, TODAY).unreplied).toBe(true);
  });

  it('uses a direction field on the contact when the backend sends one', () => {
    const c = { ...contact({}), lastMessageDirection: 'incoming' } as Chat360Contact;
    expect(contactFlags(c, null, TODAY).unreplied).toBe(true);
    const out = { ...contact({}), lastDirection: 'Outbound' } as Chat360Contact;
    expect(contactFlags(out, null, TODAY).unreplied).toBe(false);
    const outgoing = { ...contact({}), lastDirection: 'outgoing' } as Chat360Contact;
    expect(contactFlags(outgoing, null, TODAY).unreplied).toBe(false);
  });

  it('new today: the first message when known, else the last message (CRM time zone)', () => {
    // 2026-10-02T20:00Z is 3 Oct 01:30 in Asia/Kolkata
    expect(contactFlags(contact({ lastMessageAt: '2026-10-02T20:00:00.000Z' }), null, TODAY).newToday).toBe(true);
    expect(contactFlags(contact({ lastMessageAt: '2026-10-02T17:00:00.000Z' }), null, TODAY).newToday).toBe(false);
    const olderConversation: ConversationMeta = { lastDirection: 'Inbound', lastAt: '2026-10-03T04:00:00.000Z', firstAt: '2026-09-20T06:00:00.000Z' };
    expect(contactFlags(contact({ lastMessageAt: '2026-10-03T04:00:00.000Z' }), olderConversation, TODAY).newToday).toBe(false);
    const startedToday: ConversationMeta = { lastDirection: 'Outbound', lastAt: '2026-10-03T05:00:00.000Z', firstAt: '2026-10-03T04:00:00.000Z' };
    expect(contactFlags(contact({ lastMessageAt: '2026-10-03T05:00:00.000Z' }), startedToday, TODAY).newToday).toBe(true);
  });

  it('unlinked = no enquiry ID', () => {
    expect(contactFlags(contact({ leadId: '' }), null, TODAY).unlinked).toBe(true);
    expect(contactFlags(contact({ leadId: undefined }), null, TODAY).unlinked).toBe(true);
    expect(contactFlags(contact({ leadId: 'ENQ-0003' }), null, TODAY).unlinked).toBe(false);
  });
});

describe('matchesContactFilter / countContactFilters', () => {
  const flags = [
    contactFlags(contact({ phone: '1', unreadCount: 3, lastMessageAt: '2026-10-03T04:00:00.000Z', leadId: '' }), null, TODAY), // unread, unreplied, new, unlinked
    contactFlags(contact({ phone: '2', unreadCount: 0 }), { lastDirection: 'Inbound', lastAt: '2026-10-01T06:00:00.000Z', firstAt: '2026-09-01T06:00:00.000Z' }, TODAY), // unreplied
    contactFlags(contact({ phone: '3', unreadCount: 0 }), { lastDirection: 'Outbound', lastAt: '2026-10-01T06:00:00.000Z', firstAt: '2026-09-01T06:00:00.000Z' }, TODAY), // nothing
  ];

  it('counts each chip', () => {
    expect(countContactFilters(flags)).toEqual({ all: 3, unread: 1, unreplied: 2, new: 1, unlinked: 1 });
    expect(countContactFilters([])).toEqual({ all: 0, unread: 0, unreplied: 0, new: 0, unlinked: 0 });
  });

  it('filters by chip', () => {
    expect(flags.filter((f) => matchesContactFilter(f, 'all'))).toHaveLength(3);
    expect(flags.filter((f) => matchesContactFilter(f, 'unread'))).toHaveLength(1);
    expect(flags.filter((f) => matchesContactFilter(f, 'unreplied'))).toHaveLength(2);
    expect(flags.filter((f) => matchesContactFilter(f, 'new'))).toHaveLength(1);
    expect(flags.filter((f) => matchesContactFilter(f, 'unlinked'))).toHaveLength(1);
  });
});
