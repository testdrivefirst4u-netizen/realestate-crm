/** The emoji panel of the WhatsApp screen: tabs by kind, with the ones used most kept first on this device. Plain emoji text, no library. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../../components/ui';

const GROUPS: Array<{ id: string; icon: string; label: string; emoji: string }> = [
  { id: 'people', icon: '😀', label: 'Smileys and people', emoji: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 💪 🧑 👨 👩 🧓 👴 👵 👶 🧑‍💼 👨‍💼 👩‍💼 👪 🧑‍🤝‍🧑' },
  { id: 'hearts', icon: '❤️', label: 'Hearts and symbols', emoji: '❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ✅ ☑️ ✔️ ❌ ❎ ❗ ❓ ⚠️ 🚫 💯 🔥 ✨ ⭐ 🌟 💫 🎉 🎊 🎈 🎁 🏆 🥇 🔔 📢 📣 💬 💭 ➡️ ⬅️ ⬆️ ⬇️ 🔝 🆕 🆗 🔴 🟢 🔵 🟡' },
  { id: 'home', icon: '🏠', label: 'Homes and places', emoji: '🏠 🏡 🏢 🏬 🏗️ 🏘️ 🏙️ 🌆 🌇 🏞️ 🏖️ 🌴 🌳 🌿 🌱 🌻 🌸 🌺 🌹 🛋️ 🛏️ 🚪 🪟 🪑 🛁 🚿 🍽️ ⛲ 🏊 🏋️ 🧘 🚗 🚙 🚕 🛵 ✈️ 🚉 📍 🗺️ 🧭 ☀️ 🌤️ ⛅ 🌧️ 🌈 🌙' },
  { id: 'work', icon: '📄', label: 'Work and documents', emoji: '📄 📃 📑 📊 📈 📉 🗂️ 📁 📂 📅 📆 🗓️ 📝 ✏️ 🖊️ 📌 📎 🔍 🔑 🗝️ 🔒 🔓 💰 💵 💳 🧾 🏦 📱 ☎️ 📞 💻 🖥️ 🖨️ ⏰ ⌛ ⏳ 🕐 📧 ✉️ 📨 📷 🎥 🎤 🎧 💡 🛠️ 🤖' },
  { id: 'food', icon: '☕', label: 'Food and drink', emoji: '☕ 🍵 🥤 🧃 🍺 🥂 🍎 🍌 🍇 🍓 🥭 🍕 🍔 🍟 🌮 🍱 🍛 🍚 🍪 🍰 🎂 🍫 🍬 🥗 🥘' },
];
const RECENT_KEY = 'crm_recent_emoji';
const readRecent = (): string[] => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 24); } catch { return []; }
};

export const EmojiPicker: React.FC<{ onPick: (emoji: string) => void; onClose: () => void }> = ({ onPick, onClose }) => {
  const [tab, setTab] = useState('people');
  const [recent, setRecent] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setRecent(readRecent()); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [onClose]);
  const list = useMemo(() => (tab === 'recent' ? recent : (GROUPS.find((g) => g.id === tab)?.emoji || '').split(' ')), [tab, recent]);
  const pick = (e: string) => {
    onPick(e);
    const next = [e, ...recent.filter((x) => x !== e)].slice(0, 24);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
  };
  const tabs = [...(recent.length ? [{ id: 'recent', icon: '🕘', label: 'Recently used' }] : []), ...GROUPS];
  return (
    <div ref={box} role="dialog" aria-label="Emoji" className="absolute bottom-full left-0 z-20 mb-2 w-[min(340px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-[#D1D7DB] bg-white shadow-lg">
      <div role="tablist" aria-label="Kinds of emoji" className="flex border-b border-[#E9EDEF]">
        {tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-label={t.label} title={t.label} onClick={() => setTab(t.id)} className={cx('-mb-px flex-1 border-b-[3px] py-2 text-lg', tab === t.id ? 'border-[#00A884]' : 'border-transparent hover:bg-[#F5F6F6]')}>{t.icon}</button>)}
      </div>
      <div className="grid h-52 grid-cols-8 content-start gap-0.5 overflow-y-auto p-2">
        {list.map((e) => <button key={e} type="button" aria-label={`Add ${e}`} onClick={() => pick(e)} className="flex h-9 items-center justify-center rounded text-[22px] leading-none hover:bg-[#F0F2F5]">{e}</button>)}
      </div>
    </div>
  );
};
