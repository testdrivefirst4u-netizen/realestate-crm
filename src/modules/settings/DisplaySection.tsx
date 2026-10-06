import React, { useState } from 'react';
import { Check, Image as ImageIcon, Monitor, RotateCcw, Sliders, Type, Upload } from 'lucide-react';
import { STORAGE_KEYS } from '../../core/config';
import { toast } from '../../core/notifications';
import { AppLogo } from '../../components/AppLogo';
import { Badge, Button, Card, InlineNotice } from '../../components/ui';
import { DisplayScaleMode, applyDisplayScale } from '../../utils/fontSizeAdjuster';

const SCALE_OPTIONS: Array<{ id: DisplayScaleMode; label: string; hint: string }> = [
  { id: 'auto', label: 'Auto', hint: 'Fits the screen width' },
  { id: 'compact', label: 'Compact', hint: '−10%' },
  { id: 'standard', label: 'Standard', hint: '100%' },
  { id: 'large', label: 'Large', hint: '+10%' },
];

const MAX_LOGO_BYTES = 400 * 1024;

function readScaleMode(): DisplayScaleMode {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.DISPLAY_SCALE) as DisplayScaleMode | null;
    return v && SCALE_OPTIONS.some((o) => o.id === v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function hasCustomLogo(): boolean {
  try {
    return !!localStorage.getItem(STORAGE_KEYS.CUSTOM_LOGO);
  } catch {
    return false;
  }
}

export const DisplaySection: React.FC = () => {
  const [scaleMode, setScaleMode] = useState<DisplayScaleMode>(readScaleMode);
  const [customLogo, setCustomLogo] = useState<boolean>(hasCustomLogo);
  const [logoError, setLogoError] = useState<string | null>(null);

  const setMode = (mode: DisplayScaleMode) => {
    setScaleMode(mode);
    try {
      localStorage.setItem(STORAGE_KEYS.DISPLAY_SCALE, mode);
    } catch {
      /* private mode */
    }
    applyDisplayScale(mode);
    toast('Display scale updated', mode === 'auto' ? 'Text size now follows the screen width.' : `Fixed scale: ${SCALE_OPTIONS.find((o) => o.id === mode)?.label}.`, 'info');
  };

  const uploadLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setLogoError(null);
    if (!file.type.startsWith('image/')) return setLogoError('Please choose an image file (PNG, SVG or JPG).');
    if (file.size > MAX_LOGO_BYTES) return setLogoError('The logo must be smaller than 400 KB so it fits in browser storage.');
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = typeof ev.target?.result === 'string' ? ev.target.result : '';
      if (!result) return setLogoError('Could not read the file.');
      try {
        localStorage.setItem(STORAGE_KEYS.CUSTOM_LOGO, result);
      } catch {
        return setLogoError('Browser storage is full or blocked — the logo could not be saved.');
      }
      setCustomLogo(true);
      window.dispatchEvent(new Event('crm-logo-updated'));
      toast('Logo updated', 'Your logo now appears in the sidebar and top bar on this device.', 'success');
    };
    reader.onerror = () => setLogoError('Could not read the file.');
    reader.readAsDataURL(file);
  };

  const resetLogo = () => {
    try {
      localStorage.removeItem(STORAGE_KEYS.CUSTOM_LOGO);
    } catch {
      /* ignore */
    }
    setCustomLogo(false);
    window.dispatchEvent(new Event('crm-logo-updated'));
    toast('Logo reset', 'Restored the company logo.', 'info');
  };

  return (
    <div className="space-y-5">
      <Card title="Display & text size" subtitle="Keeps headings inside their margins on every screen. Stored per device." actions={<Badge tone="sage"><Monitor size={10} className="mr-1" />Device setting</Badge>}>
        <div className="space-y-3">
          <div className="p-3 sm:p-4 rounded-xl bg-[#F4F0EB] border border-[#D2C9BF] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <Type size={18} className="text-[#A9825A] mt-0.5" />
              <div>
                <div className="text-xs font-bold text-[#1D2F3F]">Typeface</div>
                <div className="text-[11px] text-[#6B5F57]">Jost — applied to every view, table and dialog.</div>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-[#D2C9BF] text-xs font-bold text-[#1D2F3F]"><Check size={13} className="text-[#3C573A]" />Active</span>
          </div>

          <div className="p-3 sm:p-4 rounded-xl bg-[#F4F0EB] border border-[#D2C9BF] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <Sliders size={18} className="text-[#A9825A] mt-0.5" />
              <div>
                <div className="text-xs font-bold text-[#1D2F3F]">Scale mode</div>
                <div className="text-[11px] text-[#6B5F57]">{scaleMode === 'auto' ? 'Automatic — adapts to the viewport width.' : `Fixed — ${SCALE_OPTIONS.find((o) => o.id === scaleMode)?.hint}.`}</div>
              </div>
            </div>
            <div className="inline-flex p-1 rounded-xl bg-[#EBE5DC] border border-[#D2C9BF] flex-wrap">
              {SCALE_OPTIONS.map((opt) => (
                <button key={opt.id} onClick={() => setMode(opt.id)} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${scaleMode === opt.id ? 'bg-white text-[#1D2F3F] shadow-sm' : 'text-[#6B5F57] hover:text-[#1D2F3F]'}`} title={opt.hint}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card title="Branding & logo" subtitle="Shown in the sidebar, top bar and sign-in screen on this device" actions={<Badge tone={customLogo ? 'gold' : 'muted'}><ImageIcon size={10} className="mr-1" />{customLogo ? 'Custom logo' : 'Default logo'}</Badge>}>
        <div className="p-4 sm:p-5 bg-[#1D2F3F] rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="p-2 bg-[#192836]/60 rounded-lg border border-[#E7D8C6]/20"><AppLogo size="lg" /></div>
            <div className="text-white">
              <div className="text-sm font-semibold">Current logo</div>
              <div className="text-[11px] text-[#E7D8C6]/70 mt-0.5">{customLogo ? 'Uploaded on this device (overrides the company logo)' : 'Company logo'}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#A9825A] text-white text-xs font-semibold hover:brightness-110 cursor-pointer shadow-sm transition">
              <Upload size={14} /><span>Upload logo</span>
              <input type="file" accept="image/*" className="hidden" onChange={uploadLogo} />
            </label>
            {customLogo && <Button variant="ghost" onClick={resetLogo} icon={<RotateCcw size={13} />} className="!text-[#E7D8C6] hover:!bg-white/10 hover:!text-white">Reset</Button>}
          </div>
        </div>
        {logoError && <InlineNotice tone="warning" className="mt-3">{logoError}</InlineNotice>}
        <p className="text-[11px] text-[#9E948D] mt-3">PNG or SVG with a transparent background works best. The logo is stored in this browser only.</p>
      </Card>
    </div>
  );
};
