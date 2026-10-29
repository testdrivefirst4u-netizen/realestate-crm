/**
 * A call transcript as a conversation: a header (duration, date, who wrote it), then each turn with an avatar, who
 * spoke, when in the call, and a bubble — the customer on the left in blue, the sales executive on the right in green.
 * Older transcripts without speaker labels are shown as plain text under the same header.
 */
import React, { useMemo } from 'react';
import { Bot, Headset, Loader2, Phone, User, Users } from 'lucide-react';
import { cx } from '../../components/ui';
import { formatDateTime } from '../../core/dates';
import { clockTime, transcriptTurns, type TranscriptTurn } from './callsUtils';

export const TranscriptView: React.FC<{
  transcript: string;
  /** The sales executive's name (who handled the call). */
  execName?: string;
  /** The customer's name. */
  customerName?: string;
  durationSec?: number;
  /** When the call started (ISO). */
  when?: string;
  /** 'JustConnect' or 'AI': who wrote the transcript. */
  source?: string;
  /** A one-paragraph transcript: split it into Sales Executive / Customer turns (absent = no button). */
  onSplit?: () => void;
  splitting?: boolean;
  /** Height limit of the conversation (it scrolls inside). */
  maxHeightClass?: string;
  className?: string;
}> = ({ transcript, execName, customerName, durationSec, when, source, onSplit, splitting, maxHeightClass = 'max-h-[30rem]', className }) => {
  const turns = useMemo(() => transcriptTurns(transcript), [transcript]);
  const meta = [durationSec ? `Duration: ${clockTime(durationSec)}` : '', when ? formatDateTime(when, '') : ''].filter(Boolean).join('  |  ');

  return (
    <section className={cx('rounded-2xl border border-[#D3E3F0] bg-white overflow-hidden', className)} aria-label="Call transcript">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[#E6EFF6]">
        <span className="flex-none w-10 h-10 rounded-xl bg-[#22A06B] text-white flex items-center justify-center"><Phone size={18} /></span>
        <div className="min-w-0 flex-1">
          <h4 className="text-[15px] font-bold text-[#0B2A44] leading-tight">Call Transcript</h4>
          {meta && <p className="text-[11.5px] text-[#5E778C] mt-0.5 truncate">{meta}</p>}
        </div>
        {source && <span className="flex-none rounded-full bg-[#F2F7FB] px-2.5 py-1 text-[10.5px] font-semibold text-[#5E778C]">{source === 'JustConnect' ? 'By JustConnect' : source === 'AI' ? 'By AI' : source}</span>}
        {!!durationSec && <span className="flex-none rounded-full bg-[#EEF4F9] px-3 py-1 text-[12px] font-semibold text-[#0B2A44] tabular-nums">{clockTime(durationSec)}</span>}
      </header>

      <div className={cx('px-3 sm:px-4 py-4 overflow-y-auto', maxHeightClass)}>
        {turns ? (
          <ol className="space-y-4" aria-label="Conversation">
            {turns.map((t, i) => <Turn key={i} turn={t} execName={execName} customerName={customerName} />)}
          </ol>
        ) : (
          <>
            {onSplit && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#F2F7FB] px-3 py-2">
                <span className="text-[12px] text-[#5E778C]">This transcript does not say who is speaking.</span>
                <button type="button" onClick={onSplit} disabled={splitting} className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B2A44] px-3 h-8 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-60">
                  {splitting ? <Loader2 size={13} className="animate-spin" /> : <Users size={13} />}
                  {splitting ? 'Splitting…' : 'Split into Sales Executive / Customer'}
                </button>
              </div>
            )}
            <p className="text-[12.5px] text-[#0F2233] whitespace-pre-wrap leading-relaxed">{transcript}</p>
          </>
        )}
      </div>
    </section>
  );
};

const Turn: React.FC<{ turn: TranscriptTurn; execName?: string; customerName?: string }> = ({ turn: t, execName, customerName }) => {
  const customer = t.speaker === 'customer';
  const label = t.speaker === 'ai' ? 'AI agent' : customer ? 'Customer' : 'Sales Executive';
  const name = t.speaker === 'ai' ? '' : customer ? customerName : execName;
  const Icon = t.speaker === 'ai' ? Bot : customer ? User : Headset;
  return (
    <li className={cx('flex items-start gap-2.5', customer ? 'flex-row' : 'flex-row-reverse')}>
      <span
        aria-hidden="true"
        className={cx('flex-none w-10 h-10 rounded-full flex items-center justify-center', customer ? 'bg-[#DCEBFB] text-[#1D6FD1]' : 'bg-[#DDF3E4] text-[#1F8A4C]')}
      >
        <Icon size={18} />
      </span>
      <div className={cx('min-w-0 max-w-[80%] flex flex-col', customer ? 'items-start' : 'items-end')}>
        <div className={cx('flex items-baseline gap-2 px-1 mb-1', customer ? 'flex-row' : 'flex-row-reverse')}>
          <span className="text-[12.5px] font-bold text-[#0B2A44]">{label}</span>
          {name && <span className="text-[11px] text-[#5E778C] truncate max-w-40">{name}</span>}
          {t.at !== undefined && <span className="text-[11px] text-[#7E93A6] tabular-nums">{clockTime(t.at)}</span>}
        </div>
        <p
          className={cx(
            'relative rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed text-[#0F2233] whitespace-pre-wrap',
            customer ? 'bg-[#E6F0FC] rounded-tl-sm' : 'bg-[#E4F6EA] rounded-tr-sm',
          )}
        >
          {t.text}
        </p>
      </div>
    </li>
  );
};
