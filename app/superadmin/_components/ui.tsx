'use client';
import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import Link from 'next/link';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B6BB0] focus-visible:ring-offset-2 focus-visible:ring-offset-white';

/* ── Buttons ─────────────────────────────────────────────────────────────── */

type Variant = 'primary' | 'accent' | 'sky' | 'secondary' | 'ghost' | 'danger' | 'danger-outline';
const variants: Record<Variant, string> = {
  primary: 'bg-[#0A1F33] text-white hover:bg-[#16466E] shadow-[0_4px_12px_rgba(10,31,51,0.18)]',
  sky: 'bg-[#36B3F2] text-[#04263D] font-semibold hover:brightness-105 shadow-[0_6px_16px_rgba(54,179,242,0.35)]',
  accent: 'bg-[#0B6BB0] text-white hover:bg-[#0B5E9C] shadow-sm',
  secondary: 'bg-white text-[#0B2A44] border border-[#C4D6E6] hover:bg-[#F7FAFD] hover:border-[#B4C6D6]',
  ghost: 'text-[#0B2A44] hover:bg-[#E3EDF5]',
  danger: 'bg-[#B42318] text-white hover:bg-[#912018] shadow-sm',
  'danger-outline': 'bg-white text-[#B42318] border border-[#F1C4BF] hover:bg-[#FEF3F2]',
};

export function buttonClasses(variant: Variant = 'primary', size: 'sm' | 'md' = 'md', className?: string) {
  return cx(
    'inline-flex items-center justify-center gap-2 rounded-xl font-medium whitespace-nowrap transition-all disabled:cursor-not-allowed disabled:opacity-60',
    size === 'sm' ? 'h-9 px-3.5 text-[13px]' : 'h-11 px-4 text-[14px]',
    variants[variant],
    focusRing,
    className,
  );
}

/** A next/link styled as a button (never nest a <button> inside a link). */
export function LinkButton({
  href,
  variant = 'primary',
  size = 'md',
  icon,
  className,
  children,
}: {
  href: string;
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonClasses(variant, size, className)}>
      {icon}
      {children}
    </Link>
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, className)}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

/* ── Form fields ─────────────────────────────────────────────────────────── */

const controlBase =
  'w-full rounded-xl border bg-white px-3 text-[14px] text-[#0F2233] placeholder:text-[#7E93A6] transition-colors focus:outline-none focus:ring-2 disabled:bg-[#F2F7FB] disabled:text-[#5E778C]';
const controlOk = 'border-[#C4D6E6] focus:border-[#0B6BB0] focus:ring-[#0B6BB0]/30';
const controlErr = 'border-[#E5847A] focus:border-[#B42318] focus:ring-[#B42318]/20';

interface FieldMeta {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
}

function FieldShell({ id, label, hint, error, required, className, children }: FieldMeta & { id: string; children: ReactNode }) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-[#233B50]">
        {label}
        {required && (
          <span className="ml-0.5 text-[#B42318]" aria-hidden>
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p id={`${id}-err`} className="flex items-start gap-1 text-[13px] text-[#B42318]">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[13px] text-[#5E778C]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, error?: string, hint?: ReactNode) {
  return error ? `${id}-err` : hint ? `${id}-hint` : undefined;
}

export function TextField({
  label,
  hint,
  error,
  required,
  className,
  id: idProp,
  ...input
}: FieldMeta & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  const auto = useId();
  const id = idProp || auto;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} className={className}>
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={cx(controlBase, 'h-11', error ? controlErr : controlOk)}
        {...input}
      />
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  required,
  className,
  id: idProp,
  ...input
}: FieldMeta & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>) {
  const auto = useId();
  const id = idProp || auto;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} className={className}>
      <textarea
        id={id}
        required={required}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={cx(controlBase, 'py-2 leading-relaxed', error ? controlErr : controlOk)}
        {...input}
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  required,
  className,
  id: idProp,
  children,
  ...input
}: FieldMeta & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'>) {
  const auto = useId();
  const id = idProp || auto;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} className={className}>
      <select
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={cx(controlBase, 'h-11 pr-8', error ? controlErr : controlOk)}
        {...input}
      >
        {children}
      </select>
    </FieldShell>
  );
}

/** A bare select / input for toolbars (label is visually hidden or provided by the caller). */
export const toolbarControl = cx(controlBase, controlOk, 'h-11');

/* ── Switch ──────────────────────────────────────────────────────────────── */

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <span id={`${id}-l`} className="block text-[14px] font-medium text-[#0F2233]">
          {label}
        </span>
        {description && (
          <span id={`${id}-d`} className="block text-[13px] text-[#5E778C]">
            {description}
          </span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-[#0B2A44]' : 'bg-[#C4D6E6]',
          focusRing,
        )}
      >
        <span
          aria-hidden
          className={cx(
            'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-[22px]' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

/* ── Display ─────────────────────────────────────────────────────────────── */

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cx('rounded-2xl border border-[#DCE8F2] bg-white shadow-[0_1px_3px_rgba(10,31,51,0.05),0_8px_24px_-12px_rgba(10,31,51,0.08)]', className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description, actions, id, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; id?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#E6EFF6] px-5 py-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <span aria-hidden className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-[#EAF5FD] text-[#0B6BB0]">{icon}</span>}
        <div className="min-w-0">
          <h2 id={id} className="text-[15.5px] font-semibold text-[#0A1F33]">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-[13px] text-[#5E778C]">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const badgeTones: Record<string, string> = {
  Active: 'bg-[#ECFDF3] text-[#067647] ring-[#ABEFC6]',
  Suspended: 'bg-[#FFFAEB] text-[#B54708] ring-[#FEDF89]',
  Disabled: 'bg-[#EEF4F9] text-[#3F5A70] ring-[#D3E3F0]',
  Error: 'bg-[#FEF3F2] text-[#B42318] ring-[#FECDCA]',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12.5px] font-medium ring-1 ring-inset whitespace-nowrap',
        badgeTones[status] || badgeTones.Disabled,
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-[#EAF5FD] px-2.5 py-0.5 text-[12.5px] font-semibold text-[#0B4F86] ring-1 ring-inset ring-[#CDE7F8] whitespace-nowrap">
      {children}
    </span>
  );
}

export function Spinner({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cx('flex items-center justify-center gap-2 py-10 text-[14px] text-[#5E778C]', className)}>
      <Loader2 className="h-5 w-5 animate-spin text-[#0B6BB0]" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-lg bg-[#E3EDF5]', className)} />;
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-[#E6EFF6]">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-5 py-3.5">
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className={cx('h-4', c === 0 ? 'w-1/4' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ErrorBox({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  if (!message) return null;
  return (
    <div role="alert" className={cx('flex items-start gap-3 rounded-lg border border-[#F7C5BF] bg-[#FEF3F2] px-4 py-3 text-[14px] text-[#912018]', className)}>
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 safe-text-wrap">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className={cx('inline-flex items-center gap-1 rounded font-medium underline-offset-2 hover:underline', focusRing)}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#EAF5FD] text-[#0B6BB0]">{icon}</div>}
      <p className="text-[15px] font-semibold text-[#0B2A44]">{title}</p>
      {description && <p className="max-w-sm text-[13.5px] text-[#5E778C]">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, back, eyebrow, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode; eyebrow?: ReactNode; icon?: ReactNode }) {
  return (
    <header className="mb-7">
      {back && <div className="mb-3">{back}</div>}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          {icon && <span aria-hidden className="hidden h-12 w-12 flex-none items-center justify-center rounded-2xl bg-[#0A1F33] text-[#36B3F2] shadow-[0_6px_16px_rgba(10,31,51,0.2)] sm:flex">{icon}</span>}
          <div className="min-w-0">
            {eyebrow && <div className="mb-0.5 text-[11.5px] font-bold uppercase tracking-[0.12em] text-[#0B6BB0]">{eyebrow}</div>}
            <h1 className="text-[1.6rem] font-bold leading-tight tracking-tight sm:text-[1.75rem]">{title}</h1>
            {description && <p className="mt-1 max-w-2xl text-[14px] text-[#4E6779]">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/* ── Tables ──────────────────────────────────────────────────────────────── */

export const th = 'bg-[#F7FAFD] px-4 py-3 text-left text-[11.5px] font-bold uppercase tracking-[0.06em] text-[#5E778C] whitespace-nowrap first:pl-5 last:pr-5';
export const td = 'px-4 py-3.5 align-middle text-[14px] text-[#0F2233] first:pl-5 last:pr-5';

export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse" aria-label={label}>
        {children}
      </table>
    </div>
  );
}

/* ── Stats ───────────────────────────────────────────────────────────────── */

const statTones = {
  blue: 'bg-[#EAF5FD] text-[#0B6BB0]',
  green: 'bg-[#E7F7EF] text-[#067647]',
  amber: 'bg-[#FFF4E0] text-[#B54708]',
  red: 'bg-[#FEF0EE] text-[#B42318]',
  navy: 'bg-[#E4EDF4] text-[#0A1F33]',
} as const;

/** A number with its label and icon; optional note underneath and link. */
export function StatCard({ label, value, note, icon, tone = 'blue', href, loading }: { label: string; value: ReactNode; note?: ReactNode; icon: ReactNode; tone?: keyof typeof statTones; href?: string; loading?: boolean }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="text-[13px] font-medium text-[#4E6779]">{label}</span>
        <span aria-hidden className={cx('flex h-9 w-9 flex-none items-center justify-center rounded-xl', statTones[tone])}>{icon}</span>
      </div>
      <div className="mt-2 text-[1.75rem] font-bold leading-none tabular-nums tracking-tight text-[#0A1F33]">{loading ? <Skeleton className="h-7 w-20" /> : value}</div>
      {note && <div className="mt-2 text-[12.5px] text-[#5E778C]">{loading ? <Skeleton className="h-3.5 w-28" /> : note}</div>}
    </>
  );
  const cls = 'block rounded-2xl border border-[#DCE8F2] bg-white p-4 shadow-[0_1px_3px_rgba(10,31,51,0.05)] sm:p-5';
  return href ? (
    <Link href={href} className={cx(cls, 'transition-shadow hover:shadow-[0_10px_24px_-10px_rgba(10,31,51,0.18)]', focusRing)}>{body}</Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
