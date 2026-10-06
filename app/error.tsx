'use client';

/**
 * Errors while rendering a page on the server — typically the database being unreachable while the
 * CRM layout checks the session. The browser app has its own boundaries for errors inside a screen.
 */
import { useEffect } from 'react';

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#F4F0EB] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl border border-[#D2C9BF] shadow-lg p-6 text-center">
        <h1 className="text-base font-bold text-[#1D2F3F]">The CRM could not be loaded</h1>
        <p className="mt-2 text-xs text-[#6B5F57]">The server could not be reached or ran into a problem. Please try again in a moment.</p>
        {error.digest && <p className="mt-2 text-[10px] text-[#6B5F57]">Reference: {error.digest}</p>}
        <button onClick={() => retry()} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#1D2F3F] text-white text-xs font-semibold">
          Try again
        </button>
      </div>
    </div>
  );
}
