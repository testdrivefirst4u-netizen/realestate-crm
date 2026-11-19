/**
 * The embeddable website-chat widget, served as JavaScript. A company adds one line to its site:
 *   <script src="https://<app>/api/public/webchat/<slug>/widget" async></script>
 * optionally with data-color / data-title on the tag. The script injects a branded chat launcher that talks to the
 * sibling POST endpoint (/api/public/webchat/<slug>). No framework, no external requests, safe to drop on any page.
 *
 * The company's name and logo are baked in server-side (by slug) so each client's widget shows their own branding.
 */
import { getTenantBySlug } from '@/server/platform/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// NOTE: the script below is kept free of backticks and of the ${ sequence so it survives this TS template literal
// verbatim, and free of regex backslashes (string methods instead) so no escape is mangled on the way out.
// `__CFG__` is replaced server-side (via a function replacer, so $ in the data is never interpreted).
const WIDGET = `(function(){
  var CFG = __CFG__;
  var S = document.currentScript; if(!S){ return; }
  var src = S.src; var cut = src.indexOf('/widget');
  var base = cut >= 0 ? src.slice(0, cut) : src;
  var after = base.split('/webchat/')[1] || 'site';
  var slug = after.split('/')[0].split('?')[0];
  var origin = src.indexOf('/api/') >= 0 ? src.slice(0, src.indexOf('/api/')) : base;
  var brand = S.getAttribute('data-color') || '#2f6fb0';
  var name = CFG.name || S.getAttribute('data-title') || 'Chat with us';
  var sub = S.getAttribute('data-subtitle') || 'Online';
  var greeting = S.getAttribute('data-greeting') || 'Chat with us';
  var logo = CFG.logo || '';
  var vid = null, sid = null, seq = 0, started = false, busy = false, ended = false, pollTimer = null, ding = null;
  function playDing(){ try { if(!ding){ ding = new Audio(origin + '/mixkit-doorbell-single-press-333.wav'); ding.volume = 0.5; } ding.currentTime = 0; var p = ding.play(); if(p && p.catch){ p.catch(function(){}); } } catch(e){} }
  try { vid = localStorage.getItem('bcchat:' + slug); } catch(e){}
  if(!vid){ vid = 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36); try { localStorage.setItem('bcchat:' + slug, vid); } catch(e){} }
  // remember the open chat so a page refresh continues it instead of starting a new one
  try { sid = localStorage.getItem('bcsid:' + slug) || null; seq = parseInt(localStorage.getItem('bcseq:' + slug) || '0', 10) || 0; ended = localStorage.getItem('bcend:' + slug) === '1'; } catch(e){}
  function saveSid(){ try { if(sid){ localStorage.setItem('bcsid:' + slug, sid); localStorage.setItem('bcseq:' + slug, String(seq)); localStorage.setItem('bcend:' + slug, ended ? '1' : ''); } } catch(e){} }
  function clearSid(){ try { localStorage.removeItem('bcsid:' + slug); localStorage.removeItem('bcseq:' + slug); localStorage.removeItem('bcend:' + slug); } catch(e){} }

  function shade(hex, pct){ try { var n = parseInt(hex.replace('#',''), 16); var r = (n>>16)&255, g = (n>>8)&255, b = n&255; r = Math.round(r*(1-pct)); g = Math.round(g*(1-pct)); b = Math.round(b*(1-pct)); return 'rgb(' + r + ',' + g + ',' + b + ')'; } catch(e){ return hex; } }
  var brandDark = shade(brand, 0.2);
  var chipBg = shade(brand, 0.12);

  var CHAT_ICON = '<svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6A8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/><circle cx="8.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="16.5" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>';
  var DOWN_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  var REFRESH_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
  var MENU_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>';

  var css = '.bcwc-btn{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;background:' + brand + ';color:#fff;border:none;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.28);z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:transform .15s}'
    + '.bcwc-btn:hover{transform:scale(1.06)}'
    + '.bcwc-panel{position:fixed;right:20px;bottom:92px;width:380px;max-width:calc(100vw - 32px);height:600px;max-height:calc(100vh - 120px);background:#eef1f4;border-radius:18px;box-shadow:0 16px 48px rgba(0,0,0,.3);z-index:2147483000;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}'
    + '.bcwc-open{display:flex}'
    + '.bcwc-head{background:linear-gradient(135deg,' + brand + ',' + brandDark + ');color:#fff;padding:14px 14px;display:flex;align-items:center;gap:11px}'
    + '.bcwc-ava-h{width:40px;height:40px;border-radius:10px;background:#fff;flex:none;display:flex;align-items:center;justify-content:center;overflow:hidden;font-weight:700;color:' + brand + '}'
    + '.bcwc-ava-h img{width:100%;height:100%;object-fit:contain}'
    + '.bcwc-htx{min-width:0;flex:1}'
    + '.bcwc-name{font-weight:700;font-size:16px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.bcwc-sub{font-size:12px;opacity:.95;display:flex;align-items:center;gap:5px;margin-top:2px}'
    + '.bcwc-dot{width:8px;height:8px;border-radius:50%;background:#49d36a;display:inline-block;box-shadow:0 0 0 2px rgba(255,255,255,.35)}'
    + '.bcwc-hbtn{background:rgba(255,255,255,.14);border:none;color:#fff;cursor:pointer;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none}'
    + '.bcwc-hbtn:hover{background:rgba(255,255,255,.26)}'
    + '.bcwc-body{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:10px}'
    + '.bcwc-row{display:flex;align-items:flex-end;gap:8px;max-width:100%}'
    + '.bcwc-row-bot{justify-content:flex-start}'
    + '.bcwc-row-me{justify-content:flex-end}'
    + '.bcwc-ava{width:28px;height:28px;border-radius:50%;background:#fff;flex:none;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:' + brand + ';box-shadow:0 1px 3px rgba(0,0,0,.15)}'
    + '.bcwc-ava img{width:100%;height:100%;object-fit:contain}'
    + '.bcwc-msg{max-width:78%;padding:10px 13px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}'
    + '.bcwc-bot{background:#fff;color:#1f2733;border-radius:4px 16px 16px 16px;box-shadow:0 1px 2px rgba(0,0,0,.08)}'
    + '.bcwc-me{background:' + brand + ';color:#fff;border-radius:16px 16px 4px 16px}'
    + '.bcwc-time{align-self:center;color:#8a94a0;font-size:11px;margin:2px 0}'
    + '.bcwc-chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;padding:4px 6px 2px}'
    + '.bcwc-chip{background:' + chipBg + ';color:#fff;border:none;border-radius:22px;padding:9px 16px;font-size:13px;font-weight:500;cursor:pointer;box-shadow:0 2px 5px rgba(0,0,0,.12);transition:transform .1s,filter .1s}'
    + '.bcwc-chip:hover{filter:brightness(1.08);transform:translateY(-1px)}'
    + '.bcwc-chip:disabled{opacity:.5;cursor:default;box-shadow:none;transform:none}'
    + '.bcwc-foot{display:flex;gap:8px;padding:10px;background:#fff;border-top:1px solid #e4e8ec}'
    + '.bcwc-in{flex:1;border:1px solid #d5dbe1;border-radius:22px;padding:10px 15px;font-size:14px;outline:none;min-width:0}'
    + '.bcwc-in:focus{border-color:' + brand + '}'
    + '.bcwc-send{background:' + brand + ';color:#fff;border:none;border-radius:50%;width:40px;height:40px;flex:none;cursor:pointer;display:flex;align-items:center;justify-content:center}'
    + '.bcwc-send:disabled{opacity:.5;cursor:default}'
    + '.bcwc-powered{text-align:center;font-size:10.5px;color:#9aa4af;padding:5px 0 7px;background:#fff}'
    + '.bcwc-powered b{color:' + brand + '}'
    + '.bcwc-note{align-self:center;color:#8a94a0;font-size:12px;padding:3px 8px}'
    + '.bcwc-msg{animation:bcwc-in .26s ease both}'
    + '.bcwc-chips{animation:bcwc-in .3s ease both}'
    + '@keyframes bcwc-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}'
    + '.bcwc-typing{display:flex;gap:4px;align-items:center}'
    + '.bcwc-typing span{width:7px;height:7px;border-radius:50%;background:#9aa4b0;animation:bcwc-bounce 1.2s infinite}'
    + '.bcwc-typing span:nth-child(2){animation-delay:.15s}.bcwc-typing span:nth-child(3){animation-delay:.3s}'
    + '@keyframes bcwc-bounce{0%,60%,100%{transform:translateY(0);opacity:.45}30%{transform:translateY(-5px);opacity:1}}'
    + '.bcwc-btn::after{content:\\'\\';position:absolute;inset:0;border-radius:50%;pointer-events:none;animation:bcwc-pulse 2.2s ease-out infinite}'
    + '.bcwc-btn.bcwc-on::after{animation:none}'
    + '.bcwc-btn.bcwc-unread::before{content:\\'\\';position:absolute;top:-1px;right:-1px;width:14px;height:14px;border-radius:50%;background:#e23744;border:2px solid #fff;z-index:1}'
    + '@keyframes bcwc-pulse{0%{box-shadow:0 0 0 0 ' + brand + '55}70%{box-shadow:0 0 0 15px ' + brand + '00}100%{box-shadow:0 0 0 0 ' + brand + '00}}'
    + '.bcwc-menubar{display:flex;align-items:center;justify-content:center;padding:7px;background:#fff;border-top:1px solid #eef1f4;position:relative}'
    + '.bcwc-menubtn{display:flex;align-items:center;gap:7px;background:none;border:none;color:' + brand + ';font-weight:600;font-size:13px;cursor:pointer}'
    + '.bcwc-menupop{position:absolute;bottom:44px;left:12px;right:12px;background:#fff;border:1px solid #e4e8ec;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);overflow:hidden;display:none}'
    + '.bcwc-menupop.bcwc-show{display:block;animation:bcwc-in .18s ease both}'
    + '.bcwc-mi{display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;background:none;border:none;text-align:left;font-size:14px;color:#1f2733;cursor:pointer}'
    + '.bcwc-mi:hover{background:#f5f7f9}.bcwc-mi+.bcwc-mi{border-top:1px solid #eef1f4}'
    + '.bcwc-greet{position:fixed;right:92px;bottom:34px;z-index:2147483000;display:flex;align-items:center;gap:4px;background:#fff;color:#1f2733;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;padding:10px 8px 10px 13px;border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,.22);animation:bcwc-in .3s ease both}'
    + '.bcwc-greet::after{content:\\'\\';position:absolute;right:-7px;top:50%;transform:translateY(-50%);border-left:8px solid #fff;border-top:7px solid transparent;border-bottom:7px solid transparent}'
    + '.bcwc-greet-t{background:none;border:none;color:inherit;font:inherit;font-weight:500;cursor:pointer;padding:0;white-space:nowrap}'
    + '.bcwc-greet-x{background:none;border:none;color:#aab2bd;cursor:pointer;font-size:16px;line-height:1;padding:0 3px}'
    + '@media (max-width:430px){.bcwc-panel{right:8px;left:8px;width:auto;bottom:86px;height:auto;top:10px}.bcwc-greet{display:none}}';
  var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st);

  function avaHead(){ var d = document.createElement('div'); d.className = 'bcwc-ava-h'; if(logo){ var i = document.createElement('img'); i.src = logo; i.alt = ''; d.appendChild(i); } else { d.textContent = (name[0] || '?').toUpperCase(); } return d; }
  function avaMsg(){ var d = document.createElement('div'); d.className = 'bcwc-ava'; if(logo){ var i = document.createElement('img'); i.src = logo; i.alt = ''; d.appendChild(i); } else { d.textContent = (name[0] || '?').toUpperCase(); } return d; }

  var btn = document.createElement('button'); btn.className = 'bcwc-btn'; btn.setAttribute('aria-label', name); btn.innerHTML = CHAT_ICON;
  var panel = document.createElement('div'); panel.className = 'bcwc-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', name);

  var head = document.createElement('div'); head.className = 'bcwc-head';
  head.appendChild(avaHead());
  var htx = document.createElement('div'); htx.className = 'bcwc-htx';
  var nm = document.createElement('div'); nm.className = 'bcwc-name'; nm.textContent = name;
  var sb = document.createElement('div'); sb.className = 'bcwc-sub'; var dot = document.createElement('span'); dot.className = 'bcwc-dot'; var sbt = document.createElement('span'); sbt.textContent = sub; sb.appendChild(dot); sb.appendChild(sbt);
  htx.appendChild(nm); htx.appendChild(sb);
  var reBtn = document.createElement('button'); reBtn.className = 'bcwc-hbtn'; reBtn.setAttribute('aria-label', 'Start a new chat'); reBtn.innerHTML = REFRESH_ICON;
  var dnBtn = document.createElement('button'); dnBtn.className = 'bcwc-hbtn'; dnBtn.setAttribute('aria-label', 'Minimise'); dnBtn.innerHTML = DOWN_ICON;
  head.appendChild(htx); head.appendChild(reBtn); head.appendChild(dnBtn);

  var body = document.createElement('div'); body.className = 'bcwc-body';
  var foot = document.createElement('div'); foot.className = 'bcwc-foot';
  var input = document.createElement('input'); input.className = 'bcwc-in'; input.type = 'text'; input.placeholder = 'Type a message...'; input.setAttribute('aria-label', 'Message');
  var send = document.createElement('button'); send.className = 'bcwc-send'; send.setAttribute('aria-label', 'Send'); send.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>';
  foot.appendChild(input); foot.appendChild(send);
  var menuBar = document.createElement('div'); menuBar.className = 'bcwc-menubar';
  var menuPop = document.createElement('div'); menuPop.className = 'bcwc-menupop';
  var menuBtn = document.createElement('button'); menuBtn.className = 'bcwc-menubtn'; menuBtn.innerHTML = MENU_ICON; var mlab = document.createElement('span'); mlab.textContent = 'Menu'; menuBtn.appendChild(mlab);
  menuBar.appendChild(menuPop); menuBar.appendChild(menuBtn);
  var powered = document.createElement('div'); powered.className = 'bcwc-powered'; powered.innerHTML = 'Powered by <b>BroaddCast</b>';
  panel.appendChild(head); panel.appendChild(body); panel.appendChild(menuBar); panel.appendChild(foot); panel.appendChild(powered);
  document.body.appendChild(btn); document.body.appendChild(panel);

  // a friendly "Chat with us" greeting bubble beside the launcher, shown shortly after load
  var greet = document.createElement('div'); greet.className = 'bcwc-greet';
  var gt = document.createElement('button'); gt.className = 'bcwc-greet-t'; gt.textContent = greeting;
  var gx = document.createElement('button'); gx.className = 'bcwc-greet-x'; gx.textContent = '\\u00D7'; gx.setAttribute('aria-label', 'Dismiss');
  greet.appendChild(gt); greet.appendChild(gx);
  function hideGreet(){ if(greet.parentNode){ greet.parentNode.removeChild(greet); } }
  gt.onclick = function(){ hideGreet(); open(); };
  gx.onclick = function(ev){ ev.stopPropagation(); hideGreet(); };
  setTimeout(function(){ if(panel.className.indexOf('bcwc-open') < 0){ document.body.appendChild(greet); } }, 900);

  function scroll(){ body.scrollTop = body.scrollHeight; }
  function botBubble(text){ var row = document.createElement('div'); row.className = 'bcwc-row bcwc-row-bot'; row.appendChild(avaMsg()); var b = document.createElement('div'); b.className = 'bcwc-msg bcwc-bot'; b.textContent = text; row.appendChild(b); body.appendChild(row); scroll(); }
  function meBubble(text){ var row = document.createElement('div'); row.className = 'bcwc-row bcwc-row-me'; var b = document.createElement('div'); b.className = 'bcwc-msg bcwc-me'; b.textContent = text; row.appendChild(b); body.appendChild(row); scroll(); }
  function timeLine(){ var t = new Date(); var h = t.getHours(), m = t.getMinutes(); var ap = h < 12 ? 'AM' : 'PM'; var hh = h % 12 || 12; var mm = (m < 10 ? '0' : '') + m; var d = document.createElement('div'); d.className = 'bcwc-time'; d.textContent = hh + ':' + mm + ' ' + ap; body.appendChild(d); scroll(); }
  function note(text){ var d = document.createElement('div'); d.className = 'bcwc-note'; d.textContent = text; body.appendChild(d); scroll(); }
  function showTyping(){ if(document.getElementById('bcwc-typing')){ return; } var row = document.createElement('div'); row.className = 'bcwc-row bcwc-row-bot'; row.id = 'bcwc-typing'; row.appendChild(avaMsg()); var b = document.createElement('div'); b.className = 'bcwc-msg bcwc-bot bcwc-typing'; b.innerHTML = '<span></span><span></span><span></span>'; row.appendChild(b); body.appendChild(row); scroll(); }
  function hideTyping(){ var t = document.getElementById('bcwc-typing'); if(t){ t.remove(); } }
  function clearChips(){ var c = body.querySelectorAll('.bcwc-chips button'); for(var i=0;i<c.length;i++){ c[i].disabled = true; } }
  function chips(options){ var wrap = document.createElement('div'); wrap.className = 'bcwc-chips';
    options.forEach(function(o){ var c = document.createElement('button'); c.className = 'bcwc-chip'; c.textContent = o.label;
      c.onclick = function(){ if(busy||ended){ return; } clearChips(); meBubble(o.label); turn({ text: o.label, replyId: o.id }); };
      wrap.appendChild(c); });
    body.appendChild(wrap); scroll(); }
  function render(m){ if(!m){ return; } if(m.text){ botBubble(m.text); } if((m.kind === 'buttons' || m.kind === 'list') && m.options && m.options.length){ chips(m.options); } }

  function setBusy(v){ busy = v; send.disabled = v; input.disabled = v || ended; }
  function endChat(status){ ended = true; stopPoll(); input.disabled = true; send.disabled = true; note(status === 'handoff' ? 'A team member will get back to you.' : 'Chat ended.'); saveSid(); }

  function turn(payload){ if(busy){ return; } setBusy(true); showTyping();
    var data = { visitorId: vid }; if(sid){ data.sessionId = sid; } if(payload){ for(var k in payload){ data[k] = payload[k]; } }
    fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }).catch(function(){ return { ok: false, j: null }; }); })
      .then(function(res){ setBusy(false); hideTyping();
        if(!res.ok || !res.j || res.j.status !== 'success'){ unavailable(res); return; }
        var d = res.j.data; if(d.sessionId){ sid = d.sessionId; }
        var msgs = d.messages || []; msgs.forEach(render); if(msgs.length){ timeLine(); }
        if(typeof d.seq === 'number'){ seq = d.seq; }
        saveSid();
        if(d.done){ endChat(d.status); } else { startPoll(); } })
      .catch(function(){ setBusy(false); hideTyping(); note('Network problem. Please try again.'); }); }

  function poll(){ if(!sid || ended || busy){ return; }
    fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, poll: true, since: seq }) })
      .then(function(r){ return r.json(); })
      .then(function(j){ if(!j || j.status !== 'success'){ return; } var d = j.data;
        if(typeof d.seq === 'number' && d.seq > seq){ var m = d.messages || []; m.forEach(render); if(m.length){ timeLine(); playDing(); if(panel.className.indexOf('bcwc-open') < 0){ btn.classList.add('bcwc-unread'); } } seq = d.seq; saveSid(); }
        if(d.done){ ended = true; stopPoll(); endChat(d.status); } })
      .catch(function(){}); }
  function startPoll(){ if(pollTimer || ended){ return; } pollTimer = setInterval(poll, 5000); }
  function stopPoll(){ if(pollTimer){ clearInterval(pollTimer); pollTimer = null; } }

  function unavailable(res){ var code = res.j && res.j.error && res.j.error.code;
    if(code === 'NOT_FOUND' || code === 'FORBIDDEN'){ btn.style.display = 'none'; panel.className = 'bcwc-panel'; return; }
    note((res.j && res.j.error && res.j.error.message) || 'Chat is unavailable right now.'); }

  function begin(){ if(started){ return; } started = true; turn(null); }
  // after a page refresh: rebuild the saved conversation and continue it (no new chat is created)
  function resume(){ if(started){ return; } started = true; setBusy(true); showTyping();
    fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, visitorId: vid, history: true }) })
      .then(function(r){ return r.json(); })
      .then(function(j){ setBusy(false); hideTyping();
        if(!j || j.status !== 'success' || !j.data || !j.data.sessionId){ clearSid(); sid = null; seq = 0; ended = false; started = false; begin(); return; }
        var d = j.data; var h = d.history || [];
        h.forEach(function(x){ if(x.from === 'me'){ meBubble(x.text); } else { botBubble(x.text); } });
        if(h.length){ timeLine(); }
        if(typeof d.seq === 'number'){ seq = d.seq; }
        if(d.done){ ended = true; input.disabled = true; send.disabled = true; } else { ended = false; startPoll(); }
        saveSid(); })
      .catch(function(){ setBusy(false); hideTyping(); started = false; note('Could not load your chat — please try again.'); }); }
  function open(){ hideGreet(); panel.className = 'bcwc-panel bcwc-open'; btn.classList.add('bcwc-on'); btn.classList.remove('bcwc-unread'); btn.innerHTML = DOWN_ICON; if(!started){ if(sid){ resume(); } else { begin(); } } else { startPoll(); } input.focus(); }
  function close(){ panel.className = 'bcwc-panel'; btn.classList.remove('bcwc-on'); btn.innerHTML = CHAT_ICON; }
  function restart(){ stopPoll(); clearSid(); body.innerHTML = ''; sid = null; seq = 0; ended = false; started = false; input.disabled = false; send.disabled = false; begin(); }
  function submit(){ var v = input.value.trim(); if(!v || busy || ended){ return; } input.value = ''; meBubble(v); turn({ text: v }); }

  btn.onclick = function(){ if(panel.className.indexOf('bcwc-open') >= 0){ close(); } else { open(); } };
  dnBtn.onclick = close;
  reBtn.onclick = restart;
  send.onclick = submit;
  input.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); submit(); } });

  function menuItem(emoji, label, fn){ var b = document.createElement('button'); b.className = 'bcwc-mi'; var e = document.createElement('span'); e.textContent = emoji; var s = document.createElement('span'); s.textContent = label; b.appendChild(e); b.appendChild(s); b.onclick = function(){ menuPop.className = 'bcwc-menupop'; fn(); }; return b; }
  function talkHuman(){ if(busy || ended){ return; } meBubble('Talk to a human'); turn({ text: 'talk to a human' }); }
  menuPop.appendChild(menuItem('\\u{1F504}', 'Restart chat', restart));
  menuPop.appendChild(menuItem('\\u{1F4AC}', 'Talk to a human', talkHuman));
  menuBtn.onclick = function(){ menuPop.className = menuPop.className.indexOf('bcwc-show') >= 0 ? 'bcwc-menupop' : 'bcwc-menupop bcwc-show'; };
})();`;

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const slug = String((await params).slug || '').toLowerCase();
  let cfg = { name: '', logo: '' };
  try {
    const t = await getTenantBySlug(slug);
    if (t && t.status === 'Active') cfg = { name: t.name || '', logo: t.logo || '' };
  } catch { /* unknown company: the widget still loads and hides if no bot answers */ }
  const js = WIDGET.replace('__CFG__', () => JSON.stringify(cfg));
  return new Response(js, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=120',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
