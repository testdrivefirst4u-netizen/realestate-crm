import React, { useEffect, useState } from 'react';
import { STORAGE_KEYS } from '../core/config';
import { companyInitials, useCompany } from '../core/tenant';

interface AppLogoProps {
  className?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}

function readDeviceLogo(): string {
  try {
    return localStorage.getItem(STORAGE_KEYS.CUSTOM_LOGO) || '';
  } catch {
    return '';
  }
}

const SIZES: Record<string, { box: string; img: string; text: string }> = {
  xs: { box: 'h-6 w-6', img: 'h-6 w-auto max-w-6', text: 'text-[9px]' },
  sm: { box: 'h-9 w-9', img: 'h-9 w-auto max-w-9', text: 'text-xs' },
  md: { box: 'h-11 w-11', img: 'h-11 w-auto max-w-11', text: 'text-sm' },
  lg: { box: 'h-14 w-14', img: 'h-14 w-auto max-w-[190px]', text: 'text-lg' },
  xl: { box: 'h-20 w-20', img: 'h-20 w-auto max-w-[240px]', text: 'text-2xl' },
};

/**
 * The company's logo. Order: a logo uploaded on this device (Settings › Display) → the company logo →
 * the company's initials → a neutral CRM mark (before sign-in, when no company is known).
 */
export const AppLogo: React.FC<AppLogoProps> = ({ className = '', size = 'md' }) => {
  const company = useCompany();
  const [deviceLogo, setDeviceLogo] = useState<string>(() => readDeviceLogo());
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const update = () => setDeviceLogo(readDeviceLogo());
    window.addEventListener('crm-logo-updated', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('crm-logo-updated', update);
      window.removeEventListener('storage', update);
    };
  }, []);

  const s = SIZES[size] || SIZES.md;
  const name = company?.name || '';
  const src = [deviceLogo, company?.logo || ''].find((u) => u && u !== failed) || '';
  const initials = companyInitials(name);
  const label = name ? `${name} logo` : 'CRM';

  return (
    <div className={`inline-flex items-center justify-center select-none ${className}`} title={name || 'CRM'}>
      {src ? (
        <img src={src} alt={label} className={`${s.img} object-contain rounded-md filter drop-shadow-sm`} onError={() => setFailed(src)} />
      ) : initials ? (
        <div className={`${s.box} ${s.text} rounded-lg bg-[#A9825A] text-white font-bold flex items-center justify-center tracking-wide`} aria-label={label} role="img">
          {initials}
        </div>
      ) : (
        <svg viewBox="0 0 48 48" className={s.box} role="img" aria-label="CRM" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="2" width="44" height="44" rx="10" fill="#A9825A" />
          <path d="M14 34V20l10-7 10 7v14" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />
          <path d="M21 34v-7h6v7" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
};
