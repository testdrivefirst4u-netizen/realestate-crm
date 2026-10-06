'use client';
import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import Link from 'next/link';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A9825A] focus-visible:ring-offset-2 focus-visible:ring-offset-white';

/* ── Buttons ─────────────────────────────────────────────────────────────── */

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger' | 'danger-outline';
const variants: Record<Variant, string> = {
  primary: 'bg-[#1D2F3F] text-white hover:bg-[#14202B] shadow-sm',
  accent: 'bg-[#A9825A] text-white hover:bg-[#8F6C49] shadow-sm',
  secondary: 'bg-white text-[#1D2F3F] border border-[#D9D0C5] hover:bg-[#F8F5F1] hover:border-[#C7BBAD]',
  ghost: 'text-[#1D2F3F] hover:bg-[#EFE9E2]',
  danger: 'bg-[#B42318] text-white hover:bg-[#912018] shadow-sm',
  'danger-outline': 'bg-white text-[#B42318] border border-[#F1C4BF] hover:bg-[#FEF3F2]',
};

export function buttonClasses(variant: Variant = 'primary', size: 'sm' | 'md' = 'md', className?: string) {
  return cx(
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60',
    size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-10 px-4 text-[14px]',
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
  'w-full rounded-lg border bg-white px-3 text-[14px] text-[#26211E] placeholder:text-[#9A8F84] transition-colors focus:outline-none focus:ring-2 disabled:bg-[#F4F0EB] disabled:text-[#7A6F64]';
const controlOk = 'border-[#D9D0C5] focus:border-[#A9825A] focus:ring-[#A9825A]/30';
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
      <label htmlFor={id} className="text-[13px] font-medium text-[#3B342E]">
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
        <p id={`${id}-hint`} className="text-[13px] text-[#7A6F64]">
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
        className={cx(controlBase, 'h-10', error ? controlErr : controlOk)}
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
        className={cx(controlBase, 'h-10 pr-8', error ? controlErr : controlOk)}
        {...input}
      >
        {children}
      </select>
    </FieldShell>
  );
}

/** A bare select / input for toolbars (label is visually hidden or provided by the caller). */
export const toolbarControl = cx(controlBase, controlOk, 'h-10');

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
        <span id={`${id}-l`} className="block text-[14px] font-medium text-[#26211E]">
          {label}
        </span>
        {description && (
          <span id={`${id}-d`} className="block text-[13px] text-[#7A6F64]">
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
          checked ? 'bg-[#1D2F3F]' : 'bg-[#CFC6BB]',
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
    <section className={cx('rounded-xl border border-[#E4DCD2] bg-white shadow-[0_1px_2px_rgba(29,47,63,0.04)]', className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description, actions, id }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#EFE9E2] px-5 py-4">
      <div className="min-w-0">
        <h2 id={id} className="text-[15px] font-semibold text-[#14202B]">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-[13px] text-[#7A6F64]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const badgeTones: Record<string, string> = {
  Active: 'bg-[#ECFDF3] text-[#067647] ring-[#ABEFC6]',
  Suspended: 'bg-[#FFFAEB] text-[#B54708] ring-[#FEDF89]',
  Disabled: 'bg-[#F2F0EE] text-[#5E554D] ring-[#DDD6CE]',
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
    <span className="inline-flex items-center rounded-md bg-[#F4EEE7] px-2 py-0.5 text-[12.5px] font-medium text-[#6B4F33] ring-1 ring-inset ring-[#E7DCCF] whitespace-nowrap">
      {children}
    </span>
  );
}

export function Spinner({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cx('flex items-center justify-center gap-2 py-10 text-[14px] text-[#7A6F64]', className)}>
      <Loader2 className="h-5 w-5 animate-spin text-[#A9825A]" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-md bg-[#ECE5DC]', className)} />;
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-[#F1ECE6]">
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
      {icon && <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-[#F4EEE7] text-[#A9825A]">{icon}</div>}
      <p className="text-[15px] font-semibold text-[#1D2F3F]">{title}</p>
      {description && <p className="max-w-sm text-[13.5px] text-[#7A6F64]">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="mb-6">
      {back && <div className="mb-3">{back}</div>}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[1.5rem]">{title}</h1>
          {description && <p className="mt-1 text-[14px] text-[#6B6158]">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/* ── Tables ──────────────────────────────────────────────────────────────── */

export const th = 'px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-[#7A6F64] whitespace-nowrap';
export const td = 'px-4 py-3 align-middle text-[14px] text-[#26211E]';

export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse" aria-label={label}>
        {children}
      </table>
    </div>
  );
}
