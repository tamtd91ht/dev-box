// Browser Workspace Framework — sending a message as the logged-in account.
//
// The one part of the framework that WRITES into a chat app, built to be
// auditable: every step reports ok/failed with a reason, a dry run walks the
// whole path and then clears the box, and a real send is verified by reading
// the thread back.
//
// WHY IT IS SPLIT INTO TWO PHASES ('type' then 'finish'):
//
// A React composer checks `event.isTrusted` and ignores anything produced by
// `dispatchEvent`. So a synthetic Enter (or click) types the text but never
// submits it — the exact "types but does not send" failure. The trusted press
// has to come from OUTSIDE the page, via the Electron `<webview>.sendInputEvent`
// (see guests.ts `pressKey`). That call lives in the renderer, so the send
// cannot be one self-contained script:
//
//   phase 'type'   → open conversation, focus + clear + type the composer,
//                    probe the send controls, then STOP (composer left focused)
//   renderer       → guest.pressKey('\r')   ← a TRUSTED Enter
//   phase 'finish' → verify the thread, then park on another conversation
//
// A dry run does the whole 'type' phase and clears the box instead of stopping
// to be sent — the way to see the path works before enabling sending.

export interface SendSpec {
  /** The message box. */
  composerSelectors?: string[];
  /** A send button, tried as a fallback before the trusted Enter. */
  sendButtonSelectors?: string[];
  /** Message bubbles, newest last — used to verify the send. */
  messageSelectors?: string[];
  /** Press Enter to send (true) vs rely on a button only (false). Default true. */
  enterToSend?: boolean;
  /** After sending, click away to another conversation. Default TRUE. */
  parkAfterSend?: boolean;
  /** Where to park, best first — self-chats nobody writes to. */
  parkNames?: string[];
}

export interface SendStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface EditableProbe {
  path: string;
  tag: string;
  contentEditable: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A clickable near the composer — a send-button candidate. */
export interface ControlProbe {
  path: string;
  tag: string;
  text: string;
  title: string;
  dataId: string;
  hasSvg: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SendResult {
  ok: boolean;
  error: string;
  target: string;
  dryRun: boolean;
  steps: SendStep[];
  /** 'type' phase typed the text and is waiting for a trusted key press. */
  awaitingKey: boolean;
  /** The message actually went out (verified, or box emptied). */
  sent: boolean;
  /** Last message in the thread after sending — the proof it went out. */
  lastMessage: string;
  /** Filled when the composer could not be located. */
  editables: EditableProbe[];
  /** Clickables next to the composer — the send button is one of these. */
  controls: ControlProbe[];
  /** outerHTML of the composer's container, truncated. */
  composerHtml: string;
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/** Shared helpers, injected into both phases. */
function prelude(
  listSel: string,
  rowSel: string,
  rowName: string,
): string {
  return `
    var LIST_SEL=${listSel}, ROW_SEL=${rowSel}, ROW_NAME=${rowName};
    var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    var clip = function(s,n){ s=String(s||'').replace(/\\s+/g,' ').trim(); return s.length>n?s.slice(0,n)+'…':s; };
    var visible = function(el){
      try { var r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) return false;
            var st=getComputedStyle(el);
            return st.display!=='none' && st.visibility!=='hidden' && parseFloat(st.opacity||'1')>0.05;
      } catch(_){ return false; }
    };
    function pathOf(el){
      var out=[], cur=el, i=0;
      while(cur && cur.nodeType===1 && i<4){
        var cls=String(cur.className||'').split(/\\s+/).filter(Boolean).slice(0,2).join('.');
        out.unshift(cur.tagName.toLowerCase()+(cls?'.'+cls:''));
        cur=cur.parentElement; i++;
      }
      return out.join(' > ');
    }
    function realClick(el){
      try {
        var r=el.getBoundingClientRect();
        var o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2};
        el.dispatchEvent(new PointerEvent('pointerdown',o));
        el.dispatchEvent(new MouseEvent('mousedown',o));
        el.dispatchEvent(new PointerEvent('pointerup',o));
        el.dispatchEvent(new MouseEvent('mouseup',o));
        el.click();
      } catch(_){ try{ el.click(); }catch(__){} }
    }
    function firstOf(sels, scope){
      var root = scope || document;
      for(var i=0;i<sels.length;i++){
        var hits; try { hits = root.querySelectorAll(sels[i]); } catch(_){ continue; }
        for(var h=0;h<hits.length;h++) if(visible(hits[h])) return hits[h];
      }
      return null;
    }
    function listBox(){
      for(var i=0;i<LIST_SEL.length;i++){
        var hits; try { hits=document.querySelectorAll(LIST_SEL[i]); } catch(_){ continue; }
        for(var h=0;h<hits.length;h++){
          for(var s=0;s<ROW_SEL.length;s++){
            try { if(hits[h].querySelectorAll(ROW_SEL[s]).length) return hits[h]; } catch(_){}
          }
        }
      }
      return null;
    }
    function rowsIn(box){
      for(var s=0;s<ROW_SEL.length;s++){
        var r; try { r=box.querySelectorAll(ROW_SEL[s]); } catch(_){ continue; }
        if(r && r.length) return Array.prototype.slice.call(r);
      }
      return [];
    }
    function nameIn(row){
      for(var n=0;n<ROW_NAME.length;n++){
        var el=row.querySelector(ROW_NAME[n]);
        if(el){ var t=clip(el.textContent,80); if(t) return t; }
      }
      return '';
    }
    function readBox(el){
      try { return ('value' in el && typeof el.value === 'string') ? el.value : (el.textContent || ''); }
      catch(_){ return ''; }
    }
    function findComposer(){ return firstOf(COMPOSER); }
`;
}

/**
 * Focus the composer and put the caret at the end — run right before the
 * main-process Enter, so the trusted key lands in the composer as the active
 * element (a physical Enter works because the box IS focused when you press it).
 */
export function buildFocusScript(send: SendSpec): string {
  const composerSel = json(send.composerSelectors ?? []);
  return `(function(){
    try {
      var COMPOSER=${composerSel};
      function vis(el){ try{var r=el.getBoundingClientRect();return r.width>0&&r.height>0;}catch(_){return false;} }
      var box=null;
      for(var i=0;i<COMPOSER.length && !box;i++){
        var hits; try{hits=document.querySelectorAll(COMPOSER[i]);}catch(_){continue;}
        for(var h=0;h<hits.length;h++) if(vis(hits[h])){ box=hits[h]; break; }
      }
      if(!box){
        var cands=document.querySelectorAll('[contenteditable="true"],textarea,input[type="text"]');
        for(var c=0;c<cands.length;c++){ var r=cands[c].getBoundingClientRect(); if(r.height>0 && r.top>window.innerHeight*0.5){ box=cands[c]; break; } }
      }
      if(!box) return false;
      box.focus();
      try {
        if(box.isContentEditable){
          var sel=window.getSelection(), rng=document.createRange();
          rng.selectNodeContents(box); rng.collapse(false);
          sel.removeAllRanges(); sel.addRange(rng);
        } else if('value' in box){ box.selectionStart=box.selectionEnd=(box.value||'').length; }
      } catch(_){}
      return document.activeElement === box;
    } catch(_){ return false; }
  })()`;
}

export function buildSendScript(
  dir: { listSelectors?: string[]; itemSelectors?: string[]; nameSelectors?: string[] },
  send: SendSpec,
  opts: { name: string; text: string; dryRun?: boolean; phase?: 'type' | 'finish' },
): string {
  const listSel = json(dir.listSelectors ?? []);
  const rowSel = json(dir.itemSelectors ?? []);
  const rowName = json(dir.nameSelectors ?? []);
  const composerSel = json(send.composerSelectors ?? []);
  const buttonSel = json(send.sendButtonSelectors ?? []);
  const msgSel = json(send.messageSelectors ?? []);
  const park = send.parkAfterSend === false ? 'false' : 'true';
  const parkNames = json(send.parkNames ?? []);
  const name = json(opts.name);
  const text = json(opts.text);
  const dry = opts.dryRun ? 'true' : 'false';
  const phase = opts.phase === 'finish' ? 'finish' : 'type';

  const head = `(async function(){
  var R = { ok:false, error:'', target:${name}, dryRun:${dry}, steps:[], awaitingKey:false, sent:false, lastMessage:'', editables:[], controls:[], composerHtml:'' };
  var PHASE=${json(phase)};
  // Every step is logged to the guest console AS IT HAPPENS. main.cjs forwards
  // guest console to the terminal, so the whole send is copyable text there —
  // which beats guessing at which step failed. No message text is logged.
  var step = function(s, ok, detail){
    R.steps.push({ step:s, ok:!!ok, detail:String(detail||'') });
    try { console.log('[ws-send:'+PHASE+'] '+(ok?'✓':'✗')+' '+s+(detail?(' — '+String(detail).slice(0,80)):'')); } catch(_){}
    return ok;
  };
  try {
    var COMPOSER=${composerSel}, BUTTON=${buttonSel}, MSG=${msgSel}, PARK=${park};
    var PARK_NAMES=${parkNames};
    var WANT=${name}, TEXT=${text}, DRY=${dry};
${prelude(listSel, rowSel, rowName)}`;

  const typeBody = `
    // ── 1. find + open the conversation ───────────────────────────────────
    // Diagnostics kept on R so a failure says WHY: was the list container even
    // found, how many rows rendered, and a few of their names.
    var R_diag = { box:false, maxRows:0, sample:[] };
    // The raw scroll container, findable even when the virtualized list has
    // rendered ZERO rows (so listBox(), which requires rows, still returns null).
    function anyScroller(){
      var c = null;
      for(var i=0;i<LIST_SEL.length && !c;i++){ try { c = document.querySelector(LIST_SEL[i]); } catch(_){} }
      if(!c){ try { c = document.querySelector('.virtualized-scroll') || document.querySelector('.ReactVirtualized__Grid'); } catch(_){} }
      if(!c) return null;
      var sc = c, g = 0;
      while(sc && g++ < 6){ if(sc.scrollHeight > sc.clientHeight + 20) return sc; sc = sc.parentElement; }
      return c;
    }
    async function findRow(){
      // Warm up BEFORE giving up. A react-virtualized list renders nothing until
      // it is scrolled, so listBox() (which needs rows) is null on a backgrounded
      // webview. The earlier bug bailed at the no-box check before the warm-up,
      // so the nudge that makes rows appear never happened and the send failed
      // with "list=KHONG, 0 dong". Nudge the raw scroller until rows show up,
      // THEN look for the list.
      for(var warm=0; warm<20; warm++){
        if(listBox()) break;
        var wc = anyScroller();
        R_diag.box = !!wc;
        if(wc){
          try { wc.scrollTop = 0; wc.dispatchEvent(new Event('scroll', { bubbles:true })); } catch(_){}
        }
        await sleep(300);
      }

      var box = listBox();
      R_diag.box = R_diag.box || !!box;
      if(!box) return null;
      var scroller = box, s = box, guard = 0;
      while(s && guard++ < 8){ if(s.scrollHeight > s.clientHeight + 20){ scroller = s; break; } s = s.parentElement; }

      try { scroller.scrollTop = 0; } catch(_){}
      await sleep(320);
      for(var p=0;p<40;p++){
        var live = listBox() || box;
        var rows = rowsIn(live);
        if(rows.length > R_diag.maxRows){
          R_diag.maxRows = rows.length;
          R_diag.sample = [];
          for(var q=0;q<rows.length && R_diag.sample.length<5;q++){ var nm=nameIn(rows[q]); if(nm) R_diag.sample.push(nm); }
        }
        for(var i=0;i<rows.length;i++) if(nameIn(rows[i]) === WANT) return rows[i];
        if(scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
        scroller.scrollTop = scroller.scrollTop + Math.max(120, Math.floor(scroller.clientHeight*0.8));
        await sleep(280);
      }
      return null;
    }
    var row = await findRow();
    if(!row){
      R.error = 'không tìm thấy hội thoại “'+WANT+'” (list='+(R_diag.box?'có':'KHÔNG')+', đọc được '+R_diag.maxRows+' dòng: '+R_diag.sample.join(' · ')+')';
      step('tìm hội thoại', false, R.error);
      return R;
    }
    step('tìm hội thoại', true, WANT);
    realClick(row);
    await sleep(900);
    step('mở hội thoại', true, 'đã bấm vào dòng');

    // ── 2. the composer ───────────────────────────────────────────────────
    var box2 = findComposer();
    if(!box2){
      var cands = document.querySelectorAll('[contenteditable="true"],textarea,input[type="text"]');
      var best = null;
      for(var c=0;c<cands.length;c++){
        var e = cands[c];
        if(!visible(e)) continue;
        var r = e.getBoundingClientRect();
        if(R.editables.length < 12){
          R.editables.push({ path: pathOf(e), tag: e.tagName.toLowerCase(),
            contentEditable: e.getAttribute('contenteditable') === 'true',
            x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
        }
        if(r.top < window.innerHeight * 0.5) continue;
        if(!best || r.width > best.getBoundingClientRect().width) best = e;
      }
      box2 = best;
    }
    if(!box2){ R.error = 'không tìm thấy ô soạn tin'; step('tìm ô soạn tin', false, R.error); return R; }
    step('tìm ô soạn tin', true, pathOf(box2));

    // ── 3. clear + type ───────────────────────────────────────────────────
    function clearBox(el){
      var had = ('value' in el && typeof el.value === 'string') ? el.value : (el.textContent || '');
      if(!String(had).trim()) return '';
      try {
        if('value' in el && typeof el.value === 'string'){
          var st0 = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
          if(st0 && st0.set) st0.set.call(el, ''); else el.value = '';
        } else if(el.isContentEditable){
          // A Range bounded to THIS element — never execCommand('selectAll'),
          // which in a background page selects the whole document and the delete
          // wipes the app's DOM.
          var sel = window.getSelection(); var rng = document.createRange();
          rng.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(rng);
          document.execCommand('delete', false, null);
          if((el.textContent || '').trim()) el.textContent = '';
          sel.removeAllRanges();
        } else { el.textContent = ''; }
        el.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'deleteContentBackward' }));
      } catch(_){}
      return had;
    }
    try { box2.focus(); } catch(_){}
    await sleep(150);
    var had = clearBox(box2);
    if(had){ await sleep(120); step('dọn ô soạn tin', true, clip(had, 60)); }

    async function typeInto(el, text){
      var before = readBox(el);
      try { el.focus(); } catch(_){}
      await sleep(120);
      try { document.execCommand('insertText', false, text); await sleep(160); if(readBox(el) !== before) return 'execCommand'; } catch(_){}
      try {
        var dt = new DataTransfer(); dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles:true, cancelable:true, clipboardData: dt }));
        await sleep(160); if(readBox(el) !== before) return 'paste';
      } catch(_){}
      try {
        if('value' in el && typeof el.value === 'string'){
          var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
          if(setter && setter.set) setter.set.call(el, text); else el.value = text;
        } else { el.textContent = text; }
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles:true, cancelable:true, data:text, inputType:'insertText' }));
        el.dispatchEvent(new InputEvent('input', { bubbles:true, data:text, inputType:'insertText' }));
        await sleep(160); if(readBox(el) !== before) return 'dom';
      } catch(_){}
      return '';
    }
    var how = await typeInto(box2, TEXT);
    var current = clip(readBox(box2), 120);
    if(!how || !current){ R.error = 'gõ xong nhưng ô soạn tin vẫn trống'; step('gõ nội dung', false, R.error); return R; }
    step('gõ nội dung', true, 'bằng ' + how + ': ' + current);

    // Probe the send controls next to the composer (the send button is here).
    try {
      var crect = box2.getBoundingClientRect();
      var bar = box2.parentElement;
      for(var up=0; up<4 && bar; up++){
        if(bar.querySelectorAll('button,[role="button"],[class*="btn"],[data-id]').length >= 1 && bar.getBoundingClientRect().width > crect.width) break;
        bar = bar.parentElement;
      }
      bar = bar || box2.parentElement;
      R.composerHtml = clip(bar ? bar.outerHTML : box2.outerHTML, 1400);
      var clickables = (bar || document).querySelectorAll('button,[role="button"],[class*="btn"],[data-id],svg,i');
      for(var ci=0; ci<clickables.length && R.controls.length < 16; ci++){
        var ce = clickables[ci];
        if(!visible(ce)) continue;
        var cr = ce.getBoundingClientRect();
        if(cr.bottom < crect.top - 8 || cr.top > crect.bottom + 8) continue;
        R.controls.push({ path: pathOf(ce), tag: ce.tagName.toLowerCase(),
          text: clip(ce.textContent, 24),
          title: clip((ce.getAttribute && (ce.getAttribute('title')||ce.getAttribute('aria-label'))) || '', 40),
          dataId: (ce.getAttribute && ce.getAttribute('data-id')) || '',
          hasSvg: !!(ce.querySelector && ce.querySelector('svg')) || ce.tagName.toLowerCase()==='svg',
          x: Math.round(cr.left), y: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height) });
      }
    } catch(_){}

    // Dry run: clear and stop, having proven the path up to the point of send.
    if(DRY){
      clearBox(box2);
      step('chạy thử — đã gõ rồi xoá, KHÔNG gửi', true, 'ô soạn tin đã được dọn');
      R.ok = true;
      return R;
    }

    // A declared send button, clicked in-page as a first attempt. If it works,
    // great; if not, the composer is left focused and text in place for the
    // renderer's TRUSTED Enter (the reliable path for a React composer).
    var btn = firstOf(BUTTON);
    if(btn){
      realClick(btn);
      await sleep(400);
      if(!clip(readBox(box2), 10)){ R.sent = true; step('bấm nút gửi', true, pathOf(btn)); R.ok = true; return R; }
    }

    // Leave it focused so the trusted Enter lands in the composer.
    try { box2.focus(); } catch(_){}
    R.awaitingKey = true;
    R.ok = true;
    step('đã gõ, chờ Enter thật', true, 'renderer sẽ nhấn Enter (sendInputEvent)');
    return R;
`;

  const finishBody = `
    var box2 = findComposer();
    var after = box2 ? clip(readBox(box2), 60) : '';

    // ── verify: box emptied, or the last bubble matches ───────────────────
    var last = '';
    for(var m=0;m<MSG.length && !last;m++){
      var bubbles; try { bubbles = document.querySelectorAll(MSG[m]); } catch(_){ continue; }
      if(bubbles && bubbles.length) last = clip(bubbles[bubbles.length-1].textContent, 200);
    }
    R.lastMessage = last;
    var wanted = clip(TEXT, 200);
    if(last && (last.indexOf(wanted.slice(0,40)) >= 0 || wanted.indexOf(last.slice(0,40)) >= 0)){
      R.sent = true; R.ok = true; step('kiểm chứng', true, last);
    } else if(!after){
      // Box emptied after the Enter → it submitted.
      R.sent = true; R.ok = true; step('kiểm chứng', true, 'ô soạn tin đã trống sau khi nhấn Enter');
    } else {
      R.sent = false; R.ok = false;
      R.error = 'nhấn Enter nhưng ô soạn vẫn còn nội dung — nút gửi có thể cần click thật';
      step('kiểm chứng', false, after);
    }

    // Let go so the app does not think a human is sitting here typing.
    try { if(box2) box2.blur(); } catch(_){}
    try { if(document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch(_){}

    // ── park on another conversation ──────────────────────────────────────
    if(PARK){
      try {
        var others = (listBox() ? rowsIn(listBox()) : []);
        var spot = null, why = '';
        for(var p2=0; p2<PARK_NAMES.length && !spot; p2++){
          for(var o2=0;o2<others.length;o2++){
            if(nameIn(others[o2]) !== PARK_NAMES[p2]) continue;
            if(nameIn(others[o2]) === WANT) continue;
            spot = others[o2]; why = 'chat với chính mình'; break;
          }
        }
        if(!spot){ for(var o3=others.length-1;o3>=0;o3--){ if(nameIn(others[o3])===WANT) continue; spot=others[o3]; why='hội thoại cũ nhất'; break; } }
        if(spot){ realClick(spot); step('rời hội thoại', true, nameIn(spot)+' ('+why+')'); }
        await sleep(300);
      } catch(_){}
    }
    return R;
`;

  const tail = `
  } catch(e){
    R.error = String(e && e.message ? e.message : e);
    try { console.log('[ws-send:'+PHASE+'] ✗ LỖI — '+R.error); } catch(_){}
    return R;
  }
})()`;

  return head + (phase === 'finish' ? finishBody : typeBody) + tail;
}
