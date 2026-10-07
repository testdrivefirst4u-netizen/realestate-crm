/** Public legal pages (no sign-in): a simple readable document frame in the CRM's colours. */
import Link from 'next/link';
import { legalDetails } from './legal';

/** Details come from the database (Super admin › Settings › Branding & legal). */
export const dynamic = 'force-dynamic';

export default async function LegalLayout({ children }: { children: React.ReactNode }) {
  const LEGAL = await legalDetails();
  return (
    <div className="min-h-screen bg-[#FDFCFA] text-[#3D3530]">
      <header className="bg-[#1D2F3F] text-white">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <Link href="/login" className="flex items-center gap-2.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A9825A]">
            <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#A9825A] text-[14px] font-bold">{LEGAL.product.slice(0, 1).toUpperCase()}</span>
            <span className="text-[15px] font-semibold">{LEGAL.product}</span>
          </Link>
          <nav aria-label="Legal" className="flex gap-4 text-[14px] text-[#C9D3DC]">
            <Link href="/privacy" className="hover:text-white">Privacy</Link>
            <Link href="/terms" className="hover:text-white">Terms</Link>
            <Link href="/data-deletion" className="hover:text-white">Data deletion</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10">
        <article className="legal-doc">{children}</article>
      </main>
      <footer className="border-t border-[#E4DCD2]">
        <div className="mx-auto max-w-3xl px-5 py-6 text-[13px] text-[#6B6158]">
          © {new Date().getFullYear()} {LEGAL.company} · {LEGAL.address} · <a className="underline underline-offset-2" href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>
        </div>
      </footer>
    </div>
  );
}
