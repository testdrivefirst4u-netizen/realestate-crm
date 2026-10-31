/** Call history page helpers: where a recording plays from, its download link, and the day headings. */
import { describe, expect, it } from 'vitest';
import { callBackIds, callStats, clockTime, dayHeading, recordingDownloadUrl, recordingSrc, transcriptTurns } from '../src/modules/calls/callsUtils';
import type { CallRecord } from '../src/types/crm';

const call = (o: Partial<CallRecord> = {}): CallRecord => ({ id: 'CALL-00100', leadId: 'ENQ-0001', phone: '+919876501234', direction: 'Inbound', status: 'Completed', startTime: '2026-10-27T10:05:00', ...o } as CallRecord);

describe('recordings', () => {
  it('plays the CRM\'s stored copy first, else the provider\'s link', () => {
    expect(recordingSrc(call({ recordingFileId: 'abc123', recordingUrl: 'https://provider.example/r.mp3' }))).toBe('/api/files/abc123');
    expect(recordingSrc(call({ recordingUrl: 'https://provider.example/r.mp3' }))).toBe('https://provider.example/r.mp3');
    expect(recordingSrc(call())).toBe('');
  });

  it('downloads a stored recording as "<name> <date time>", and leaves a provider link as it is', () => {
    const url = recordingDownloadUrl(call({ recordingFileId: 'abc123' }), 'Payal Kanodia / Agarwal');
    expect(url.startsWith('/api/files/abc123?download=1&name=')).toBe(true);
    expect(decodeURIComponent(url.split('name=')[1])).toBe('Payal Kanodia Agarwal 2026-10-27 10-05');
    expect(decodeURIComponent(recordingDownloadUrl(call({ recordingFileId: 'abc123' }), '').split('name=')[1])).toBe('+919876501234 2026-10-27 10-05');
    expect(recordingDownloadUrl(call({ recordingUrl: 'https://provider.example/r.mp3' }), 'X')).toBe('https://provider.example/r.mp3');
  });
});

describe('to call back', () => {
  const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
  const c = (id: string, phone: string, direction: 'Inbound' | 'Outbound', status: string, minsAgo: number) => call({ id, phone, direction, status: status as any, startTime: at(minsAgo) });

  it('a missed incoming call waits until somebody calls the number, or a later call from it is answered', () => {
    const list = [
      c('a', '+91 98765 00001', 'Inbound', 'Missed', 60), // nobody called back → listed
      c('b', '9876500002', 'Inbound', 'Missed', 60),
      c('b2', '09876500002', 'Outbound', 'No Answer', 30), // an attempt to call back clears it
      c('d', '9876500003', 'Inbound', 'Missed', 60),
      c('d2', '9876500003', 'Inbound', 'Completed', 20), // they rang again and were answered
      c('e', '9876500004', 'Inbound', 'Voicemail', 60),
      c('e0', '9876500004', 'Outbound', 'Completed', 90), // a call BEFORE the missed one does not count
      c('f', '9876500005', 'Outbound', 'No Answer', 60), // our own unanswered call is not a call-back
      c('g', '9876500006', 'Inbound', 'Missed', 20 * 24 * 60), // older than 14 days
    ];
    expect([...callBackIds(list)].sort()).toEqual(['a', 'e']);
  });

  it('figures: calls, answered with the rate, talk time', () => {
    expect(callStats([call({ status: 'Completed', durationSec: 60 }), call({ status: 'Missed' }), call({ status: 'Completed', durationSec: 30 }), call({ status: 'In Progress' })]))
      .toEqual({ calls: 4, answered: 2, talkSec: 90, answerRate: 67 });
    expect(callStats([]).answerRate).toBeNull();
  });
});

describe('transcript as a conversation', () => {
  it("reads JustConnect's Agent / Customer and the AI's Sales Executive / Customer lines; joins a speaker's lines", () => {
    expect(transcriptTurns('Agent: Namaste, Amaya nundi Priya.\nCustomer: We want to visit.\nCustomer: On Saturday.')).toEqual([
      { speaker: 'exec', text: 'Namaste, Amaya nundi Priya.' },
      { speaker: 'customer', text: 'We want to visit. On Saturday.' },
    ]);
    expect(transcriptTurns('Sales Executive: Hello. Good afternoon.\nCustomer: You are not audible actually.\nyour voice is cracking.\nAI agent: Connecting you.')).toEqual([
      { speaker: 'exec', text: 'Hello. Good afternoon.' },
      { speaker: 'customer', text: 'You are not audible actually. your voice is cracking.' },
      { speaker: 'ai', text: 'Connecting you.' },
    ]);
  });

  it('reads when in the call each turn starts ("[01:05] Customer: …")', () => {
    expect(transcriptTurns('[00:03] Agent: Hi Rahul, how can I help you?\n[00:08] Customer: I am looking for a 2 BHK.\n[01:05] Customer: For my parents.\n[1:02:10] Agent: Thank you.')).toEqual([
      { speaker: 'exec', text: 'Hi Rahul, how can I help you?', at: 3 },
      { speaker: 'customer', text: 'I am looking for a 2 BHK. For my parents.', at: 8 },
      { speaker: 'exec', text: 'Thank you.', at: 3730 },
    ]);
    expect(clockTime(65)).toBe('01:05');
    expect(clockTime(3730)).toBe('1:02:10');
  });

  it('an older transcript without speakers stays plain text', () => {
    expect(transcriptTurns('Hello. Good afternoon. You are not audible actually.')).toBeNull();
    expect(transcriptTurns('')).toBeNull();
  });
});

describe('day headings', () => {
  it('Today, Yesterday, then the date', () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    expect(dayHeading(now.toISOString(), now)).toBe('Today');
    expect(dayHeading(yesterday.toISOString(), now)).toBe('Yesterday');
    expect(dayHeading('2020-03-02T10:00:00', now)).toMatch(/2 Mar.*2020/);
    expect(dayHeading('')).toBe('Date unknown');
  });
});
