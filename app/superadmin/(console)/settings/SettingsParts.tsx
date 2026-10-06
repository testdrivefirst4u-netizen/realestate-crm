'use client';
import type { ReactNode } from 'react';
import { CheckCircle2, ChevronRight, XCircle } from 'lucide-react';
import { cx } from '../../_components/ui';

/** A label/value pair inside a <dl>. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] font-medium uppercase tracking-wide text-[#7A6F64]">{label}</dt>
      <dd className="mt-1 text-[14px] text-[#14202B] break-words">{children}</dd>
    </div>
  );
}

export function StatusPill({ configured }: { configured: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12.5px] font-medium ring-1 ring-inset whitespace-nowrap',
        configured ? 'bg-[#ECFDF3] text-[#067647] ring-[#ABEFC6]' : 'bg-[#FFFAEB] text-[#B54708] ring-[#FEDF89]',
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {configured ? 'Configured' : 'Not configured'}
    </span>
  );
}

/** The result of a "Test connection" call. */
export function TestResult({ test, okLabel = 'Connection works. ', failLabel = 'Connection failed. ' }: { test: { ok: boolean; message: string }; okLabel?: string; failLabel?: string }) {
  return (
    <div
      role={test.ok ? 'status' : 'alert'}
      className={cx(
        'mx-5 mb-4 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-[14px]',
        test.ok ? 'border-[#ABEFC6] bg-[#ECFDF3] text-[#067647]' : 'border-[#F7C5BF] bg-[#FEF3F2] text-[#912018]',
      )}
    >
      {test.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <p className="min-w-0 flex-1 break-words">
        <span className="font-medium">{test.ok ? okLabel : failLabel}</span>
        {test.message}
      </p>
    </div>
  );
}

/** A collapsible step-by-step guide. */
export function Guide({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-[#E4DCD2] bg-[#FBF9F6]">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-4 py-3 text-[14px] font-medium text-[#1D2F3F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A9825A] [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        {title}
      </summary>
      <div className="border-t border-[#EFE9E2] px-4 py-3 text-[13.5px] leading-relaxed text-[#3B342E]">{children}</div>
    </details>
  );
}
