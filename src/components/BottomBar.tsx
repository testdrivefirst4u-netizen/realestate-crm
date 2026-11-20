'use client';
/**
 * Desktop bottom bar (Zoho-style): a slim strip across the foot of the workspace with quick access to the live-chat
 * screens on the left and utilities on the right (agent availability, Phone, Help). Hidden on mobile, where the
 * MobileTabBar takes over.
 */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { HelpCircle, Inbox, MessagesSquare, PhoneCall } from 'lucide-react';
import { WhatsAppIcon } from './WhatsAppIcon';
import { viewHref, type ViewId } from '../core/views';
import type { Permission } from '../core/rbac';
import { api } from '../core/api';

const HELP_URL = 'https://broaddcast.com';

export const BottomBar: React.FC<{
  currentView: ViewId | null;
  can: (p: Permission) => boolean;
  features: Record<string, boolean>;
  unreadChats?: number;
  callsOn?: boolean;
}> = ({ currentView, can, features, unreadChats = 0, callsOn }) => {
  const chatOn = can('chat.view') && (!!features.whatsappBots || !!features.socialInbox || !!features.chat360);
  const [presence, setPresence] = useState<boolean | null>(null);
  const [presBusy, setPresBusy] = useState(false);
  useEffect(() => {
    if (!chatOn) return;
    let live = true;
    api.botChats.presence().then((r) => { if (live) setPresence(!!r.available); }).catch(() => undefined);
    return () => { live = false; };
  }, [chatOn]);
  const togglePresence = async () => {
    if (presence == null || presBusy) return;
    setPresBusy(true);
    try { await api.botChats.setPresence(!presence); setPresence(!presence); } catch { /* leave as-is */ } finally { setPresBusy(false); }
  };

  const links = ([
    { id: 'webchat' as const, label: 'Live Chat', Icon: MessagesSquare, show: (!!features.whatsappBots || !!features.socialInbox) && can('marketing.bots'), badge: 0 },
    { id: 'chat360' as const, label: 'WhatsApp', Icon: WhatsAppIcon, show: !!features.chat360 && can('chat.view'), badge: unreadChats },
    { id: 'inbox' as const, label: 'Social Inbox', Icon: Inbox, show: !!features.socialInbox && can('chat.view'), badge: 0 },
  ] as Array<{ id: ViewId; label: string; Icon: React.ComponentType<{ size?: number; className?: string }>; show: boolean; badge: number }>).filter((l) => l.show);

  const pill = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] font-medium transition-colors';

  return (
    <div className="hidden h-9 flex-none items-center justify-between gap-3 border-t border-[#E3EDF5] bg-white px-4 text-[#44566B] lg:flex">
      {/* left: live-chat surfaces */}
      <div className="flex min-w-0 items-center gap-1">
        {links.length === 0 && <span className="text-[11.5px] text-[#9AA7B4]">BroaddCast CRM</span>}
        {links.map((l) => {
          const on = currentView === l.id;
          return (
            <Link key={l.id} href={viewHref(l.id)} className={`${pill} ${on ? 'bg-[#E8F2FB] text-[#0B5E9C]' : 'text-[#44566B] hover:bg-[#F2F7FB]'}`}>
              <l.Icon size={15} />{l.label}
              {l.badge > 0 && <span className="ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#E23744] px-1 text-[10px] font-bold text-white">{l.badge > 9 ? '9+' : l.badge}</span>}
            </Link>
          );
        })}
      </div>

      {/* right: utilities */}
      <div className="flex flex-none items-center gap-1.5">
        {chatOn && presence != null && (
          <button type="button" onClick={() => void togglePresence()} disabled={presBusy} className={`${pill} text-[#44566B] hover:bg-[#F2F7FB] disabled:opacity-60`} title={presence ? 'You are available for live chat' : 'You are away from live chat'}>
            <span className={`h-2 w-2 rounded-full ${presence ? 'bg-[#1DAA61]' : 'bg-[#9AA7B4]'}`} />{presence ? 'Available' : 'Away'}
          </button>
        )}
        {callsOn && (
          <Link href={viewHref('calls')} className={`${pill} text-[#44566B] hover:bg-[#F2F7FB]`} title="Call history & dialer">
            <PhoneCall size={15} />Phone
          </Link>
        )}
        <a href={HELP_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-[#6D28D9] px-3 py-1 text-[12.5px] font-semibold text-white transition hover:brightness-110" title="Help & support">
          <HelpCircle size={15} />Help
        </a>
      </div>
    </div>
  );
};
