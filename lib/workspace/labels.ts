// Browser Workspace Framework — reading the chat app's own labels.
//
// Zalo has "Phân loại": the user already tags contacts and groups there. That
// beats every identifier we tried to invent, for two reasons:
//
//   - chat.zalo.me exposes NO per-conversation id (measured: every row carries
//     the same component marker, and only a group's collage avatar has `id`s,
//     one per member). A directory therefore has to key on the display NAME,
//     and a name is only safe inside a small, human-curated set.
//   - filtering to one label turns a 116-row virtual list into a handful of
//     rows the user can eyeball before switching sending on.
//
// We do not know that dropdown's markup, and guessing is what cost us three
// rounds on the conversation list. So this probe is SELF-DESCRIBING: it clicks
// the control, then reports exactly which elements appeared — text, path,
// position — plus the popup's HTML. One run and the selectors write themselves.
//
// It only ever opens a menu and closes it again: no message is sent, no filter
// is left applied.

/** Where the label control lives. Text matching is the fallback. */
export interface LabelSpec {
  /** CSS for the "Phân loại" control, best first. */
  filterSelectors?: string[];
  /** Exact text of the control when NO filter is active. */
  filterText?: string;
  /**
   * Other texts the same control can show. Zalo renames it to the ACTIVE
   * label's name while a filter is on — which broke every restore and every
   * label after the first, and left the app filtered. Pass the label names
   * here and the control stays findable; its text then also tells us which
   * filter is currently on.
   */
  filterTexts?: string[];
  /** The popup the control opens. */
  popupSelectors?: string[];
  /** One clickable label row inside the popup. */
  itemSelectors?: string[];
  /** The label's NAME inside such a row. */
  nameSelectors?: string[];
}

export interface LabelCandidate {
  text: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** True when the element is a leaf (the clickable label row itself). */
  leaf: boolean;
}

export interface LabelProbe {
  ok: boolean;
  error: string;
  /** The label names themselves, read through itemSelectors + nameSelectors. */
  names: string[];
  /** How the control was found: 'selector' | 'text' | ''. */
  foundBy: string;
  /** Path of the control that was clicked. */
  controlPath: string;
  /** Elements that appeared after the click. */
  items: LabelCandidate[];
  /** Path + HTML of what looks like the popup container. */
  popupPath: string;
  popupHtml: string;
}

/** One conversation seen while a label filter was applied. */
export interface LabelledConversation {
  name: string;
  kind: 'group' | 'user';
}

export interface LabelScan {
  ok: boolean;
  error: string;
  label: string;
  /** The label row was found and clicked. */
  clicked: boolean;
  /**
   * The conversation list actually CHANGED after the click. False means we very
   * likely read the unfiltered list — the difference between "this label has 115
   * conversations" and "the filter never applied".
   */
  changed: boolean;
  /** How many rows the list held before filtering, for the same reason. */
  before: number;
  /** The filter was clicked off again afterwards — the app is back to normal. */
  restored: boolean;
  items: LabelledConversation[];
}

const json = (v: unknown) => JSON.stringify(v ?? null);

export function buildLabelProbeScript(spec: LabelSpec = {}): string {
  const sel = json(spec.filterSelectors ?? []);
  const text = json(spec.filterText ?? 'Phân loại');
  const itemSel = json(spec.itemSelectors ?? []);
  const nameSel = json(spec.nameSelectors ?? []);

  return `(async function(){
  var R = { ok:false, error:'', names:[], foundBy:'', controlPath:'', items:[], popupPath:'', popupHtml:'' };
  try {
    var SEL = ${sel}, TEXT = ${text}, ITEM_SEL = ${itemSel}, NAME_SEL = ${nameSel};
    var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    var clip = function(s, n){ s = String(s||'').replace(/\\s+/g,' ').trim(); return s.length>n ? s.slice(0,n)+'…' : s; };
    var visible = function(el){
      try {
        var r = el.getBoundingClientRect();
        if(r.width <= 0 || r.height <= 0) return false;
        var st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.05;
      } catch(_){ return false; }
    };
    function pathOf(el){
      var out = [], cur = el, i = 0;
      while(cur && cur.nodeType===1 && i<4){
        var cls = String(cur.className||'').split(/\\s+/).filter(Boolean).slice(0,2).join('.');
        out.unshift(cur.tagName.toLowerCase() + (cls ? '.'+cls : ''));
        cur = cur.parentElement; i++;
      }
      return out.join(' > ');
    }

    // ── find the control ──────────────────────────────────────────────────
    var ctrl = null;
    for(var s=0; s<SEL.length && !ctrl; s++){
      var hits;
      try { hits = document.querySelectorAll(SEL[s]); } catch(_){ continue; }
      for(var h=0; h<hits.length; h++){ if(visible(hits[h])){ ctrl = hits[h]; R.foundBy = 'selector'; break; } }
    }
    if(!ctrl){
      var leafs = document.querySelectorAll('div,span,button,a,li,p');
      for(var i=0;i<leafs.length;i++){
        var el = leafs[i];
        if(el.children && el.children.length) continue;
        if((el.textContent||'').trim() !== TEXT) continue;
        if(!visible(el)) continue;
        ctrl = el; R.foundBy = 'text'; break;
      }
    }
    if(!ctrl){ R.error = 'không thấy nút “' + TEXT + '” trên trang'; return R; }
    R.controlPath = pathOf(ctrl);

    // ── what exists BEFORE the click ──────────────────────────────────────
    var before = new WeakSet();
    var all0 = document.querySelectorAll('*');
    for(var b=0;b<all0.length;b++) before.add(all0[b]);

    // A dropdown may listen for pointer events rather than click, so send the
    // whole sequence a real user produces.
    try {
      var r0 = ctrl.getBoundingClientRect();
      var opts = { bubbles:true, cancelable:true, clientX: r0.left + r0.width/2, clientY: r0.top + r0.height/2 };
      ctrl.dispatchEvent(new PointerEvent('pointerdown', opts));
      ctrl.dispatchEvent(new MouseEvent('mousedown', opts));
      ctrl.dispatchEvent(new PointerEvent('pointerup', opts));
      ctrl.dispatchEvent(new MouseEvent('mouseup', opts));
      ctrl.click();
    } catch(_){ try { ctrl.click(); } catch(__){} }

    await sleep(500);

    // ── what appeared AFTER ───────────────────────────────────────────────
    var fresh = [], all1 = document.querySelectorAll('*');
    for(var a=0;a<all1.length;a++){
      var e = all1[a];
      if(before.has(e)) continue;
      if(!visible(e)) continue;
      var t = clip(e.textContent, 40);
      if(!t) continue;
      fresh.push(e);
      if(R.items.length < 40){
        var rc = e.getBoundingClientRect();
        R.items.push({
          text: t, path: pathOf(e), leaf: !(e.children && e.children.length),
          x: Math.round(rc.left), y: Math.round(rc.top),
          w: Math.round(rc.width), h: Math.round(rc.height)
        });
      }
    }

    if(fresh.length){
      // The popup is the shallowest new element — its HTML shows how the rows
      // are marked up, which is what a click-by-label needs next.
      var top = fresh[0], depth = 99;
      for(var f=0; f<fresh.length; f++){
        var d = 0, cur = fresh[f];
        while(cur && cur.parentElement){ d++; cur = cur.parentElement; }
        if(d < depth){ depth = d; top = fresh[f]; }
      }
      R.popupPath = pathOf(top);
      R.popupHtml = clip(top.outerHTML, 1800);
      R.ok = true;

      // The label names, read the same way the filter step will read them —
      // if this list is right, clicking by name is right too.
      for(var si=0; si<ITEM_SEL.length && !R.names.length; si++){
        var rows;
        try { rows = top.querySelectorAll(ITEM_SEL[si]); } catch(_){ continue; }
        for(var ri=0; ri<rows.length; ri++){
          var nm = '';
          for(var ni=0; ni<NAME_SEL.length && !nm; ni++){
            var n = rows[ri].querySelector(NAME_SEL[ni]);
            if(n) nm = clip(n.textContent, 40);
          }
          if(!nm) nm = clip(rows[ri].textContent, 40);
          if(nm && R.names.indexOf(nm) === -1) R.names.push(nm);
        }
      }
    } else {
      R.error = 'bấm rồi nhưng không có gì mới hiện ra (menu có thể dựng sẵn và chỉ đổi hiển thị)';
    }

    // ── put the page back ─────────────────────────────────────────────────
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', keyCode:27, bubbles:true }));
      await sleep(150);
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, clientX:5, clientY:5 }));
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, clientX:5, clientY:5 }));
    } catch(_){}

    return R;
  } catch(e){
    R.error = String(e && e.message ? e.message : e);
    return R;
  }
})()`;
}

/**
 * Apply ONE label filter, read the (now short) conversation list, then click the
 * filter off again.
 *
 * This is the payoff of the whole directory detour: chat.zalo.me exposes no
 * per-conversation id, so a target list can only be keyed by NAME — and a name
 * is safe exactly when the set is small and the user curated it themselves.
 * Zalo's own "Phân loại" is that set.
 *
 * It leaves the app as it found it: the label is a checkbox, so the same click
 * that switched it on switches it off. `restored` says whether that worked — if
 * it did not, the user's Zalo is still filtered and the UI must say so.
 */
export function buildLabelScanScript(
  spec: LabelSpec,
  dir: {
    listSelectors?: string[];
    itemSelectors?: string[];
    nameSelectors?: string[];
    groupSelectors?: string[];
  },
  label: string,
): string {
  const filterSel = json(spec.filterSelectors ?? []);
  const filterText = json(spec.filterText ?? 'Phân loại');
  const altTexts = json(spec.filterTexts ?? []);
  const popupSel = json(spec.popupSelectors ?? []);
  const menuItemSel = json(spec.itemSelectors ?? []);
  const menuNameSel = json(spec.nameSelectors ?? []);
  const listSel = json(dir.listSelectors ?? []);
  const rowSel = json(dir.itemSelectors ?? []);
  const rowNameSel = json(dir.nameSelectors ?? []);
  const groupSel = json(dir.groupSelectors ?? []);
  const want = json(label);

  return `(async function(){
  var R = { ok:false, error:'', label:${want}, clicked:false, changed:false, before:0, restored:false, items:[] };
  try {
    var FILTER_SEL=${filterSel}, FILTER_TEXT=${filterText}, ALT_TEXTS=${altTexts}, POPUP_SEL=${popupSel};
    var MENU_ITEM=${menuItemSel}, MENU_NAME=${menuNameSel};
    var LIST_SEL=${listSel}, ROW_SEL=${rowSel}, ROW_NAME=${rowNameSel}, GROUP_SEL=${groupSel};
    var WANT = ${want};
    var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    var clip = function(s,n){ s=String(s||'').replace(/\\s+/g,' ').trim(); return s.length>n?s.slice(0,n)+'…':s; };
    var visible = function(el){
      try { var r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) return false;
            var st=getComputedStyle(el);
            return st.display!=='none' && st.visibility!=='hidden' && parseFloat(st.opacity||'1')>0.05;
      } catch(_){ return false; }
    };
    function realClick(el){
      try {
        var r = el.getBoundingClientRect();
        var o = { bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2 };
        el.dispatchEvent(new PointerEvent('pointerdown', o));
        el.dispatchEvent(new MouseEvent('mousedown', o));
        el.dispatchEvent(new PointerEvent('pointerup', o));
        el.dispatchEvent(new MouseEvent('mouseup', o));
        el.click();
      } catch(_){ try { el.click(); } catch(__){} }
    }

    // The control is matched by ANY text it is known to show — the default
    // ("Phân loại") or an active label's name. Its current text is therefore
    // also the answer to "which filter is on right now".
    function controlInfo(){
      for(var i=0;i<FILTER_SEL.length;i++){
        var hits; try { hits = document.querySelectorAll(FILTER_SEL[i]); } catch(_){ continue; }
        for(var h=0;h<hits.length;h++) if(visible(hits[h])) return { el: hits[h], text: clip(hits[h].textContent, 40) };
      }
      var wanted = [FILTER_TEXT].concat(ALT_TEXTS);
      var leafs = document.querySelectorAll('div,span,button,a,li,p');
      for(var l=0;l<leafs.length;l++){
        var e = leafs[l];
        if(e.children && e.children.length) continue;
        var t = (e.textContent||'').trim();
        if(wanted.indexOf(t) < 0) continue;
        if(!visible(e)) continue;
        var r = e.getBoundingClientRect();
        // The list rows also contain a conversation named after a label; the
        // control sits ABOVE the list, in the sidebar header band.
        if(r.top > 220) continue;
        return { el: e, text: t };
      }
      return null;
    }
    function control(){ var c = controlInfo(); return c ? c.el : null; }

    /**
     * Put the app back to "no filter", whatever is currently on.
     *
     * Reads which label is active off the control's own text and clicks that
     * label off. Loops because several labels can be ticked at once — Zalo's
     * filter is a multi-select, which is exactly how one earlier run ended up
     * showing the union of two labels.
     */
    async function clearFilters(){
      for(var round=0; round<8; round++){
        var info = controlInfo();
        if(!info) return false;                       // control gone — cannot fix
        if(info.text === FILTER_TEXT) return true;    // nothing is filtered
        realClick(info.el);
        await sleep(450);
        var p = popup();
        var row = null;
        if(p){
          for(var i=0;i<MENU_ITEM.length && !row;i++){
            var rows; try { rows = p.querySelectorAll(MENU_ITEM[i]); } catch(_){ continue; }
            for(var r2=0;r2<rows.length;r2++){
              var nm = '';
              for(var n=0;n<MENU_NAME.length && !nm;n++){
                var el2 = rows[r2].querySelector(MENU_NAME[n]);
                if(el2) nm = clip(el2.textContent, 40);
              }
              if(!nm) nm = clip(rows[r2].textContent, 40);
              if(nm === info.text){ row = rows[r2]; break; }
            }
          }
        }
        if(!row){ closeMenu(); return false; }
        realClick(row);
        await sleep(600);
        closeMenu();
        await sleep(350);
      }
      return controlInfo() ? controlInfo().text === FILTER_TEXT : false;
    }
    function popup(){
      for(var i=0;i<POPUP_SEL.length;i++){
        var hits; try { hits = document.querySelectorAll(POPUP_SEL[i]); } catch(_){ continue; }
        for(var h=0;h<hits.length;h++) if(visible(hits[h])) return hits[h];
      }
      return null;
    }
    function closeMenu(){
      try {
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:27,bubbles:true}));
        document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:5,clientY:5}));
        document.body.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:5,clientY:5}));
      } catch(_){}
    }
    function labelRow(){
      var p = popup(); if(!p) return null;
      for(var i=0;i<MENU_ITEM.length;i++){
        var rows; try { rows = p.querySelectorAll(MENU_ITEM[i]); } catch(_){ continue; }
        for(var r=0;r<rows.length;r++){
          var nm = '';
          for(var n=0;n<MENU_NAME.length && !nm;n++){
            var el = rows[r].querySelector(MENU_NAME[n]);
            if(el) nm = clip(el.textContent, 40);
          }
          if(!nm) nm = clip(rows[r].textContent, 40);
          if(nm === WANT) return rows[r];
        }
      }
      return null;
    }
    // Open the menu and click the wanted label. Used twice: on, then off.
    async function toggleLabel(){
      var c = control();
      if(!c){ R.error = 'không thấy nút “'+FILTER_TEXT+'”'; return false; }
      realClick(c);
      await sleep(500);
      var row = labelRow();
      if(!row){ closeMenu(); R.error = 'không thấy nhãn “'+WANT+'” trong menu'; return false; }
      realClick(row);
      await sleep(700);
      closeMenu();
      await sleep(400);
      return true;
    }

    // ── read the filtered list ────────────────────────────────────────────
    function listContainer(){
      for(var i=0;i<LIST_SEL.length;i++){
        var hits; try { hits = document.querySelectorAll(LIST_SEL[i]); } catch(_){ continue; }
        for(var h=0;h<hits.length;h++){
          for(var s=0;s<ROW_SEL.length;s++){
            try { if(hits[h].querySelectorAll(ROW_SEL[s]).length) return hits[h]; } catch(_){}
          }
        }
      }
      return null;
    }
    function rowsOf(box){
      for(var s=0;s<ROW_SEL.length;s++){
        var r; try { r = box.querySelectorAll(ROW_SEL[s]); } catch(_){ continue; }
        if(r && r.length) return Array.prototype.slice.call(r);
      }
      return [];
    }
    function nameOf(row){
      for(var n=0;n<ROW_NAME.length;n++){
        var el = row.querySelector(ROW_NAME[n]);
        if(el){ var t = clip(el.textContent, 80); if(t) return t; }
      }
      return clip(row.textContent, 40);
    }
    function isGroup(row){
      for(var g=0;g<GROUP_SEL.length;g++){
        try { if(row.querySelector(GROUP_SEL[g])) return true; } catch(_){}
      }
      return row.querySelectorAll('img').length >= 2;
    }

    // What the list looks like BEFORE filtering, so "the filter did nothing"
    // is a fact we report rather than a silent full-list result.
    function signature(){
      var b = listContainer();
      if(!b) return '';
      var rows = rowsOf(b);
      return rows.length + '|' + (rows[0] ? nameOf(rows[0]) : '') + '|' + (rows[rows.length-1] ? nameOf(rows[rows.length-1]) : '');
    }
    // Start from a clean slate. A label left ticked from an earlier run unions
    // into this one — that is how "1 conversation" once came back as 6.
    await clearFilters();
    await sleep(300);

    var sigBefore = signature();
    R.before = parseInt(sigBefore.split('|')[0], 10) || 0;

    if(!(await toggleLabel())) return R;
    R.clicked = true;

    // Wait for the list to actually change instead of trusting a fixed delay —
    // a virtualised list can still be showing the OLD rows after 750ms, and
    // reading then returns the unfiltered list dressed up as a label's contents.
    for(var w=0; w<12; w++){
      if(signature() !== sigBefore){ R.changed = true; break; }
      await sleep(250);
    }

    var box = listContainer();
    if(!box){ R.error = 'lọc rồi nhưng không thấy danh sách hội thoại'; }
    else {
      var scroller = box, s = box, guard = 0;
      while(s && guard++ < 8){ if(s.scrollHeight > s.clientHeight + 20){ scroller = s; break; } s = s.parentElement; }
      try { scroller.scrollTop = 0; } catch(_){}
      await sleep(350);

      var seen = {};
      // A filtered list is short, but scroll anyway in case the label is broad.
      for(var p=0; p<10; p++){
        var live = listContainer() || box;
        var rows = rowsOf(live);
        for(var i=0;i<rows.length;i++){
          var nm = nameOf(rows[i]);
          if(!nm || seen[nm]) continue;
          seen[nm] = 1;
          R.items.push({ name: nm, kind: isGroup(rows[i]) ? 'group' : 'user' });
        }
        if(scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
        scroller.scrollTop = scroller.scrollTop + Math.max(120, Math.floor(scroller.clientHeight * 0.8));
        await sleep(300);
      }
      R.ok = true;
    }

    // Put the app back. Not "click the same label again": the control is
    // renamed while a filter is on, so the reliable move is to read what IS
    // active and switch that off.
    R.restored = await clearFilters();
    if(!R.restored && !R.error) R.error = 'không tắt được bộ lọc — vào Zalo bỏ tick thủ công';
    return R;
  } catch(e){
    R.error = String(e && e.message ? e.message : e);
    return R;
  }
})()`;
}
