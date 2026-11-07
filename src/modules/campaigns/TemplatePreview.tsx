/** How a template should look on a customer's phone: file at the top, words, footer and buttons. WhatsApp's own look varies a little by phone. */
import React from 'react';
import { CornerDownLeft, ExternalLink, FileText, Image as ImageIcon, Phone, Reply, Video } from 'lucide-react';
import type { WaDirectTemplate } from '../../core/api';
import { cx } from '../../components/ui';
import { previewBody, type PreviewPart } from './campaignAudience';

const WALLPAPER = '#EFEAE2';
const BUTTON_ICON: Record<string, React.ReactNode> = {
  URL: <ExternalLink size={13} aria-hidden="true" />, PHONE_NUMBER: <Phone size={13} aria-hidden="true" />, QUICK_REPLY: <Reply size={13} aria-hidden="true" />,
};

const MediaBox: React.FC<{ kind: string; url: string; name: string }> = ({ kind, url, name }) => {
  if (url && kind === 'image') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="max-h-44 w-full rounded-md object-cover" />;
  }
  if (url && kind === 'video') return <video src={url} className="max-h-44 w-full rounded-md bg-black" muted controls preload="metadata" aria-label="The video at the top of the message" />;
  if (kind === 'document') return <div className="flex items-center gap-2 rounded-md bg-[#F5F6F6] p-2.5 text-[12px] text-[#111B21]"><FileText size={22} className="flex-none text-[#D93025]" aria-hidden="true" /><span className="min-w-0 truncate font-medium">{name || 'Your PDF goes here'}</span></div>;
  const Icon = kind === 'video' ? Video : ImageIcon;
  return <div className="flex h-28 flex-col items-center justify-center gap-1 rounded-md bg-[#DFE5E7] text-[#54656F]"><Icon size={22} aria-hidden="true" /><span className="text-[11px]">Your {kind} goes here</span></div>;
};

const Words: React.FC<{ parts: PreviewPart[] }> = ({ parts }) => (
  <p className="whitespace-pre-wrap break-words text-[13.5px] leading-[19px] text-[#111B21]">
    {parts.map((p, i) => (p.empty
      ? <mark key={i} className="rounded bg-[#FEF0C7] px-0.5 font-medium text-[#93370D]">{p.text}</mark>
      : <span key={i}>{p.text}</span>))}
  </p>
);

export const TemplatePreview: React.FC<{
  template?: Pick<WaDirectTemplate, 'body' | 'paramNames' | 'headerMedia' | 'headerText' | 'footer' | 'buttons'>;
  values?: string[];
  business?: string;
  mediaUrl?: string;
  mediaName?: string;
  className?: string;
}> = ({ template, values = [], business = 'Your business', mediaUrl = '', mediaName = '', className }) => (
  <figure className={cx('m-0 overflow-hidden rounded-[22px] border-[5px] border-[#1F2C34] bg-[#1F2C34] shadow-md', className)} aria-label="Preview of the message on a phone">
    <figcaption className="flex items-center gap-2 bg-[#008069] px-3 py-2 text-white">
      <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-white/25 text-xs font-bold" aria-hidden="true">{(business[0] || '?').toUpperCase()}</span>
      <span className="min-w-0"><span className="block truncate text-[12.5px] font-semibold">{business}</span><span className="block text-[10px] opacity-85">Business account</span></span>
    </figcaption>
    <div className="min-h-[300px] p-2.5" style={{ background: WALLPAPER }}>
      {!template ? <p className="pt-20 text-center text-xs text-[#667781]">Choose a template to see it here.</p> : (
        <div className="max-w-[94%]">
          <div className="rounded-lg rounded-tl-none bg-white p-1.5 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
            {template.headerMedia && <div className="mb-1.5"><MediaBox kind={template.headerMedia} url={mediaUrl} name={mediaName} /></div>}
            <div className="px-1">
              {template.headerText && <p className="mb-1 break-words text-[13.5px] font-bold text-[#111B21]">{template.headerText}</p>}
              <Words parts={previewBody(template.body, template.paramNames, values)} />
              {template.footer && <p className="mt-1 break-words text-[11.5px] text-[#667781]">{template.footer}</p>}
              <p className="mt-0.5 text-right text-[10.5px] text-[#667781]">10:30 AM</p>
            </div>
          </div>
          {(template.buttons || []).map((b, i) => (
            <div key={i} className="mt-1 flex items-center justify-center gap-1.5 rounded-lg bg-white px-2 py-1.5 text-center text-[12.5px] font-medium text-[#008069] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
              {BUTTON_ICON[b.type] || <CornerDownLeft size={13} aria-hidden="true" />}<span className="min-w-0 truncate">{b.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  </figure>
);
