import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#F4F0EB] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl border border-[#D2C9BF] shadow-lg p-6 text-center">
        <h1 className="text-base font-bold text-[#1D2F3F]">Page not found</h1>
        <p className="mt-2 text-xs text-[#6B5F57]">This address does not match any page of the CRM.</p>
        <Link href="/dashboard" className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#1D2F3F] text-white text-xs font-semibold">
          Go to the dashboard
        </Link>
      </div>
    </div>
  );
}
