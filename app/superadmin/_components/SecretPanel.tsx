'use client';
import { useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { cx, focusRing } from './ui';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[#D9D0C5] bg-white px-2.5 text-[13px] font-medium text-[#1D2F3F] hover:bg-[#F8F5F1]',
        focusRing,
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-[#067647]" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

/** A labelled value row with a copy button (mono for secrets / URLs). */
export function CopyRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12.5px] font-medium uppercase tracking-wide text-[#7A6F64]">{label}</span>
      <div className="flex items-center gap-2 rounded-lg border border-[#E4DCD2] bg-[#FBF9F6] py-1.5 pl-3 pr-1.5">
        <span className={cx('min-w-0 flex-1 break-all text-[14px] text-[#14202B]', mono && 'font-mono')}>{value}</span>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

/** One-time temporary password panel. */
export function TempPasswordPanel({ email, password, note }: { email?: string; password: string; note?: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-lg border border-[#F3DFC1] bg-[#FFF8EC] px-3.5 py-3 text-[13.5px] text-[#6B4F33]">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-[#A9825A]" aria-hidden />
        <p>{note || 'This temporary password is shown only once. Copy it now and share it securely — it cannot be retrieved later.'}</p>
      </div>
      {email && <CopyRow label="E-mail" value={email} mono={false} />}
      <CopyRow label="Temporary password" value={password} />
    </div>
  );
}

/** One-time secret panel (API keys, tokens …): the warning note plus a copyable value. */
export function OneTimeSecretPanel({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-lg border border-[#F3DFC1] bg-[#FFF8EC] px-3.5 py-3 text-[13.5px] text-[#6B4F33]">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-[#A9825A]" aria-hidden />
        <p>{note || `This ${label.toLowerCase()} is shown only once. Copy it now and share it securely — it cannot be retrieved later.`}</p>
      </div>
      <CopyRow label={label} value={value} />
    </div>
  );
}
