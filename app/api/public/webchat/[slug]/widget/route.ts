/**
 * The embeddable website-chat widget, served as JavaScript. A company adds one line to its site:
 *   <script src="https://<app>/api/public/webchat/<slug>/widget" async></script>
 * optionally with data-color / data-title on the tag. The script injects a chat bubble that talks to the sibling
 * POST endpoint (/api/public/webchat/<slug>). No framework, no external requests, safe to drop on any page.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// NOTE: kept free of backticks and of the ${ sequence so it survives this TS template literal verbatim,
// and free of regex backslashes (string methods instead) so no escape is mangled on the way out.
const WIDGET = `(function(){
  var S = document.currentScript; if(!S){ return; }
  var src = S.src; var cut = src.indexOf('/widget');
  var base = cut >= 0 ? src.slice(0, cut) : src;              // .../api/public/webchat/<slug>
  var after = base.split('/webchat/')[1] || 'site';
  var slug = after.split('/')[0].split('?')[0];
  var brand = S.getAttribute('data-color') || '#1f7a4d';
  var title = S.getAttribute('data-title') || 'Chat with us';
  var vid = null, sid = null, opened = false, started = false, busy = false, ended = false;
  try { vid = localStorage.getItem('bcchat:' + slug); } catch(e){}
  if(!vid){ vid = 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36); try { localStorage.setItem('bcchat:' + slug, vid); } catch(e){} }

  var css = '.bcwc-btn{position:fixed;right:18px;bottom:18px;width:58px;height:58px;border-radius:50%;background:' + brand + ';color:#fff;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:2147483000;font-size:26px;line-height:1;display:flex;align-items:center;justify-content:center}'
    + '.bcwc-panel{position:fixed;right:18px;bottom:86px;width:350px;max-width:calc(100vw - 24px);height:480px;max-height:calc(100vh - 110px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);z-index:2147483000;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}'
    + '.bcwc-open{display:flex}'
    + '.bcwc-head{background:' + brand + ';color:#fff;padding:14px 16px;font-weight:600;font-size:15px;display:flex;align-items:center;justify-content:space-between}'
    + '.bcwc-x{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;padding:0 2px}'
    + '.bcwc-body{flex:1;overflow-y:auto;padding:14px;background:#f5f7f9;display:flex;flex-direction:column;gap:8px}'
    + '.bcwc-msg{max-width:82%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}'
    + '.bcwc-bot{background:#fff;color:#10151c;border:1px solid #e3e7ec;align-self:flex-start;border-bottom-left-radius:4px}'
    + '.bcwc-me{background:' + brand + ';color:#fff;align-self:flex-end;border-bottom-right-radius:4px}'
    + '.bcwc-note{align-self:center;color:#5c6773;font-size:12px;padding:4px 8px}'
    + '.bcwc-chips{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:90%}'
    + '.bcwc-chip{background:#fff;border:1px solid ' + brand + ';color:' + brand + ';border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer}'
    + '.bcwc-chip:disabled{opacity:.5;cursor:default}'
    + '.bcwc-foot{display:flex;gap:6px;padding:10px;border-top:1px solid #e3e7ec;background:#fff}'
    + '.bcwc-in{flex:1;border:1px solid #cfd6dd;border-radius:20px;padding:9px 14px;font-size:14px;outline:none;min-width:0}'
    + '.bcwc-send{background:' + brand + ';color:#fff;border:none;border-radius:20px;padding:0 16px;cursor:pointer;font-size:14px}'
    + '.bcwc-send:disabled{opacity:.5;cursor:default}'
    + '@media (max-width:420px){.bcwc-panel{right:8px;left:8px;width:auto;bottom:80px}}';
  var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st);

  var btn = document.createElement('button'); btn.className = 'bcwc-btn'; btn.setAttribute('aria-label', title); btn.textContent = '\\u{1F4AC}';
  var panel = document.createElement('div'); panel.className = 'bcwc-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', title);
  var head = document.createElement('div'); head.className = 'bcwc-head';
  var hT = document.createElement('span'); hT.textContent = title;
  var xB = document.createElement('button'); xB.className = 'bcwc-x'; xB.setAttribute('aria-label', 'Close'); xB.textContent = '\\u00D7';
  head.appendChild(hT); head.appendChild(xB);
  var body = document.createElement('div'); body.className = 'bcwc-body';
  var foot = document.createElement('div'); foot.className = 'bcwc-foot';
  var input = document.createElement('input'); input.className = 'bcwc-in'; input.type = 'text'; input.placeholder = 'Type a message...'; input.setAttribute('aria-label', 'Message');
  var send = document.createElement('button'); send.className = 'bcwc-send'; send.textContent = 'Send';
  foot.appendChild(input); foot.appendChild(send);
  panel.appendChild(head); panel.appendChild(body); panel.appendChild(foot);
  document.body.appendChild(btn); document.body.appendChild(panel);

  function scroll(){ body.scrollTop = body.scrollHeight; }
  function bubble(text, mine){ var d = document.createElement('div'); d.className = 'bcwc-msg ' + (mine ? 'bcwc-me' : 'bcwc-bot'); d.textContent = text; body.appendChild(d); scroll(); }
  function note(text){ var d = document.createElement('div'); d.className = 'bcwc-note'; d.textContent = text; body.appendChild(d); scroll(); }
  function clearChips(){ var c = body.querySelectorAll('.bcwc-chips'); for(var i=0;i<c.length;i++){ var b = c[i].querySelectorAll('button'); for(var j=0;j<b.length;j++){ b[j].disabled = true; } } }
  function chips(options){ var wrap = document.createElement('div'); wrap.className = 'bcwc-chips';
    options.forEach(function(o){ var c = document.createElement('button'); c.className = 'bcwc-chip'; c.textContent = o.label;
      c.onclick = function(){ if(busy||ended){ return; } clearChips(); bubble(o.label, true); turn({ text: o.label, replyId: o.id }); };
      wrap.appendChild(c); });
    body.appendChild(wrap); scroll(); }
  function render(m){ if(!m){ return; } bubble(m.text || '', false);
    if((m.kind === 'buttons' || m.kind === 'list') && m.options && m.options.length){ chips(m.options); } }

  function setBusy(v){ busy = v; send.disabled = v; input.disabled = v || ended; }
  function endChat(status){ ended = true; input.disabled = true; send.disabled = true;
    note(status === 'handoff' ? 'A team member will get back to you.' : 'Chat ended.'); restartLink(); }
  function restartLink(){ var r = document.createElement('button'); r.className = 'bcwc-chip'; r.style.alignSelf = 'center'; r.textContent = 'Start a new chat';
    r.onclick = function(){ body.innerHTML = ''; sid = null; ended = false; started = false; input.disabled = false; send.disabled = false; begin(); };
    body.appendChild(r); scroll(); }

  function turn(payload){ if(busy){ return; } setBusy(true);
    var data = { visitorId: vid }; if(sid){ data.sessionId = sid; } if(payload){ for(var k in payload){ data[k] = payload[k]; } }
    fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }).catch(function(){ return { ok: false, j: null }; }); })
      .then(function(res){ setBusy(false);
        if(!res.ok || !res.j || res.j.status !== 'success'){ unavailable(res); return; }
        var d = res.j.data; if(d.sessionId){ sid = d.sessionId; }
        (d.messages || []).forEach(render);
        if(d.done){ endChat(d.status); } })
      .catch(function(){ setBusy(false); note('Network problem. Please try again.'); }); }

  function unavailable(res){ var code = res.j && res.j.error && res.j.error.code;
    if(code === 'NOT_FOUND' || code === 'FORBIDDEN'){ /* no live bot: hide the widget quietly */ btn.style.display = 'none'; panel.className = 'bcwc-panel'; return; }
    note((res.j && res.j.error && res.j.error.message) || 'Chat is unavailable right now.'); }

  function begin(){ if(started){ return; } started = true; turn(null); }
  function submit(){ var v = input.value.trim(); if(!v || busy || ended){ return; } input.value = ''; bubble(v, true); turn({ text: v }); }

  btn.onclick = function(){ opened = true; panel.className = 'bcwc-panel bcwc-open'; if(!started){ begin(); } input.focus(); };
  xB.onclick = function(){ panel.className = 'bcwc-panel'; };
  send.onclick = submit;
  input.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); submit(); } });
})();`;

export async function GET() {
  return new Response(WIDGET, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
