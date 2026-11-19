'use client';
/** A slim top bar on the public report with a Save-as-PDF (print) button. Hidden when printing. */
import { Download } from 'lucide-react';

export function PrintBar({ title }: { title: string }) {
  return (
    <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[#D3E3F0] bg-white/90 px-4 py-2.5 backdrop-blur sm:px-6">
      <span className="truncate text-[13px] font-semibold text-[#5E778C]">{title}</span>
      <button
        type="button"
        onClick={() => window.print()}
        className="inline-flex flex-none items-center gap-1.5 rounded-lg bg-[#0B6BB0] px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-[#0A5E9C] focus:outline-none focus:ring-2 focus:ring-[#0B6BB0]/40"
      >
        <Download size={14} aria-hidden /> Save as PDF
      </button>
    </div>
  );
}
