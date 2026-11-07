/** The balance at the top of every screen, for those allowed to see it. Quiet if it cannot be read: it must never get in the way. */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wallet } from 'lucide-react';
import { api } from '../../core/api';
import { cx } from '../../components/ui';

const CHECK_EVERY_MS = 120000;

export const CreditsBadge: React.FC = () => {
  const [b, setB] = useState<{ available: number; low: boolean; finished: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      api.whatsappCredits.balance().then((r) => { if (live) setB(r); }, () => { /* no badge */ });
    };
    check();
    const t = setInterval(check, CHECK_EVERY_MS);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!b) return null;
  const words = b.finished ? 'Credits finished' : `₹${Math.floor(b.available).toLocaleString('en-IN')}`;
  return (
    <Link href="/whatsappcredits" title={b.finished ? 'WhatsApp credits are finished' : b.low ? 'WhatsApp credits are low' : 'WhatsApp credits'} aria-label={`WhatsApp credits: ${words}${b.low && !b.finished ? ', low' : ''}`}
      className={cx('inline-flex h-10 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-bold tabular-nums whitespace-nowrap', b.finished ? 'border-[#FECDCA] bg-[#FEF3F2] text-[#B42318]' : b.low ? 'border-[#FEDF89] bg-[#FFFAEB] text-[#93370D]' : 'border-[#D3E3F0] bg-white text-[#0B2A44]')}>
      <Wallet size={14} aria-hidden="true" />{words}
    </Link>
  );
};
