// Browser Workspace Framework — reading a chat app's conversation list.
//
// The goal is a directory of send targets that lives OUTSIDE the chat app, in
// DevBox, where it can be named, tagged, edited and reviewed. To build one we
// have to ask the app itself "which conversations do you have?", once, on
// demand — a human presses the button, the guest answers.
//
// This script is deliberately app-agnostic. It does NOT know Zalo's markup:
//
//   1. If the plugin declares selectors, try them first (cheap and exact).
//   2. Otherwise find the conversation list the way a person does — the tall,
//      narrow column on the left made of many repeated rows that contain text.
//   3. Scroll that column to the bottom in steps, because every modern chat app
//      virtualises the list and only renders what you can see.
//
// For each row it reports every id-ish attribute it can find (on the row and two
// ancestors), the first few texts, and the raw HTML of one sample row. That is
// exactly the material needed to decide whether the app exposes a STABLE id we
// can store — and if it does not, to say so plainly instead of guessing.
//
// Reads names and previews of the user's own conversations. It only ever runs on
// an explicit click, and the result is shown locally; nothing is sent anywhere.

/** Declarative hints for one app. Everything is optional — the heuristic copes. */
export interface DirectorySpec {
  /** Candidate containers for the conversation list, best first. */
  listSelectors?: string[];
  /** Candidate rows inside the container. Must match the ROW, not its parts:
   *  a substring selector like `[class*="conv-item"]` also matches
   *  `conv-item__avatar` and turns one conversation into five junk rows. */
  itemSelectors?: string[];
  /** Where the conversation NAME lives inside a row. Without this the scanner
   *  guesses by typography, and picks up timestamps ("30/07") or preview
   *  prefixes ("Bạn:") whenever the guess is wrong. */
  nameSelectors?: string[];
  /** Attribute names that carry a stable conversation id, best first. */
  idAttrs?: string[];
  /**
   * Images whose `id` is the peer's account id. Zalo puts the real Zalo id on
   * the avatar `<img>`, which is the only stable per-row identifier the page
   * exposes — but ONLY when the row has exactly one (a group collage carries
   * one id per member, none of which identifies the group).
   */
  avatarIdSelectors?: string[];
  /** Marks a row as a group (e.g. a collage avatar container). */
  groupSelectors?: string[];
  /** Stop after this many rows (default 300). */
  limit?: number;
  /** Scroll passes over the list (default 12). */
  passes?: number;
  /**
   * Skip the picker and use `diag.candidates[N]` as the list. This is how a
   * human overrides a wrong guess from the UI — one click beats another round
   * of me tuning selectors blind.
   */
  forceCandidate?: number;
}

/** One row as the guest saw it. */
export interface ScannedConversation {
  /** Best id found — '' when the app exposes none. */
  convId: string;
  /** Which attribute it came from, so trustworthiness is visible. */
  idFrom: string;
  /** The conversation name. */
  name: string;
  /** Guessed from the avatar: a group avatar is a collage of several images. */
  kind: 'group' | 'user';
  /** The rest of the row's text (last message, time…), truncated. */
  texts: string[];
  /** Images in the row: a group avatar is usually a collage of several. */
  imgs: number;
  /** Every id-ish attribute on the row and its two ancestors. */
  attrs: Record<string, string>;
}

/** A repeated-row stack the scanner considered, with the numbers it judged on. */
export interface ScanCandidate {
  /** Which document/shadow root it lives in ('main', 'iframe#2', 'shadow'). */
  root: string;
  path: string;
  /** Children that looked like rows. */
  rows: number;
  /** How many of those contain an image — a conversation list is avatars. */
  withImg: number;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** First text of the first row — enough to recognise the list by eye. */
  sample: string;
}

/** The chosen list and its ancestors, measured — why scrolling did or didn't work. */
export interface ScrollProbe {
  path: string;
  scrollH: number;
  clientH: number;
  overflowY: string;
  /** scrollHeight > clientHeight: this element *can* scroll natively. */
  canScroll: boolean;
}

/** Everything the guest could tell us about the page, reported even on failure. */
export interface ScanDiag {
  url: string;
  title: string;
  /** The row stack's ancestor chain with scroll metrics. */
  scroll: ScrollProbe[];
  /** Elements in the main document — a near-empty body means the app is elsewhere. */
  elements: number;
  /** Frames found, and whether same-origin script could reach into them. */
  frames: { src: string; accessible: boolean; elements: number }[];
  /** Shadow roots found (querySelectorAll does not pierce them). */
  shadowRoots: number;
  /**
   * Controls that look like the app's own filter/label UI ("Phân loại", "Tất
   * cả", "Chưa đọc"). Zalo's built-in labels are a far better source of truth
   * than anything we could infer — the user already maintains them.
   */
  filters: { text: string; path: string; x: number; y: number; w: number; h: number }[];
  /** Short texts sitting ABOVE the list in the same column — the sidebar header,
   *  where a filter/label control lives whatever it happens to be called. */
  header: { text: string; path: string; x: number; y: number; w: number; h: number }[];
  /** Rows the collector examined in the chosen container. */
  rowsProbed: number;
  /** Distinct ids across those rows. Equal to rowsProbed ⇒ ids are per-row. */
  idDistinct: number;
  /** False ⇒ ids repeat (positional or shared) and must NOT key the directory. */
  idsUnique: boolean;
  /** Rows dropped because an identical row was already collected. */
  dupSkipped: number;
  /** Best repeated-row stacks, scored — the list we want is normally in here. */
  candidates: ScanCandidate[];
}

export interface ScanResult {
  ok: boolean;
  error?: string;
  /** 'selector' | 'auto' — how the list was located. */
  how: string;
  /** Where the winning list lives: 'main' | 'iframe#N' | 'shadow'. */
  root: string;
  /** tag.class chain of the container, for tuning the selectors later. */
  containerPath: string;
  /** How many scroll passes actually ran. */
  passes: number;
  /** True when the scroller reached the bottom (i.e. the list is complete). */
  complete: boolean;
  /** Which technique actually moved the list: '' | 'scrollTop' | 'intoView' | 'wheel'. */
  usedStrategy: string;
  /** True when NOTHING moved it — the list is longer than what we read. */
  stuck: boolean;
  items: ScannedConversation[];
  /** outerHTML of the first row, truncated — raw material for tuning. */
  sampleHtml: string;
  diag: ScanDiag;
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Build the scan expression. Returns a Promise-producing IIFE: Electron's
 * executeJavaScript awaits it, so the scroll passes can be sequenced properly
 * instead of racing a virtualised list.
 *
 * It ALWAYS returns diagnostics, including when it finds nothing: "không tìm
 * thấy danh sách" with no evidence is useless, and the first run against a real
 * Zalo proved exactly that. The evidence is `diag.candidates` — every repeated
 * row-stack in the page with the numbers it was judged on.
 *
 * Two lessons are baked in:
 *   - Rows are matched by TAG only, never by class. A chat list marks the
 *     selected/unread row with an extra class, which broke a class signature.
 *   - Nothing is filtered out for looking wrong; being a narrow left column with
 *     avatars only SCORES higher. A wrong guess is then visible in the table
 *     instead of silently emptying the result.
 */
export function buildDirectoryScript(spec: DirectorySpec = {}): string {
  const listSel = json(spec.listSelectors ?? []);
  const itemSel = json(spec.itemSelectors ?? []);
  const nameSel = json(spec.nameSelectors ?? []);
  const avaSel = json(spec.avatarIdSelectors ?? []);
  const groupSel = json(spec.groupSelectors ?? []);
  const idAttrs = json(spec.idAttrs ?? []);
  const limit = Math.max(10, Math.min(1000, spec.limit ?? 300));
  const passes = Math.max(1, Math.min(40, spec.passes ?? 12));
  const force = Number.isInteger(spec.forceCandidate) ? (spec.forceCandidate as number) : -1;

  return `(async function(){
  var R = { ok:false, error:'', how:'', root:'', containerPath:'', passes:0, complete:false,
            usedStrategy:'', stuck:false, items:[], sampleHtml:'',
            diag:{ url:'', title:'', scroll:[], elements:0, frames:[], shadowRoots:0, filters:[], header:[],
                   rowsProbed:0, idDistinct:0, idsUnique:false, dupSkipped:0, candidates:[] } };
  try {
    var LIST_SEL = ${listSel}, ITEM_SEL = ${itemSel}, NAME_SEL = ${nameSel}, ID_ATTRS = ${idAttrs};
    var AVA_SEL = ${avaSel}, GROUP_SEL = ${groupSel};
    var LIMIT = ${limit}, PASSES = ${passes}, FORCE = ${force};
    var VW = window.innerWidth || 1280;
    var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    var clip = function(s, n){ s = String(s||'').replace(/\\s+/g,' ').trim(); return s.length>n ? s.slice(0,n)+'…' : s; };

    function pathOf(el){
      var out = [], cur = el, i = 0;
      while(cur && cur.nodeType===1 && i<4){
        var cls = String(cur.className||'').split(/\\s+/).filter(Boolean).slice(0,2).join('.');
        out.unshift(cur.tagName.toLowerCase() + (cls ? '.'+cls : ''));
        cur = cur.parentElement; i++;
      }
      return out.join(' > ');
    }

    // Every id-ish attribute on the row and two ancestors. Prefixed ^1/^2 when it
    // came from an ancestor — that is the difference between an id we can store
    // per conversation and one that belongs to the whole list.
    function attrsOf(el){
      var out = {}, cur = el, d = 0;
      while(cur && cur.nodeType===1 && d<3){
        var a = cur.attributes || [];
        for(var i=0;i<a.length;i++){
          var n = a[i].name, v = String(a[i].value||'').trim();
          if(!v || v.length>140) continue;
          if(n === 'id' || n.indexOf('data-') === 0){ out[(d? '^'+d+' ':'')+n] = v; }
        }
        cur = cur.parentElement; d++;
      }
      return out;
    }

    // Every leaf text of a row WITH the typography around it. The first text
    // node is NOT the name: a chat row renders time, then an unread badge, then
    // the name, then the preview — which is how a scan came back full of
    // "30/07", "26" and "Bạn:".
    function partsOf(el){
      var out = [];
      try {
        var rowR = el.getBoundingClientRect();
        var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        var n, guard = 0;
        while((n = w.nextNode()) && guard++ < 40 && out.length < 12){
          var t = clip(n.nodeValue, 80);
          if(!t) continue;
          var p = n.parentElement;
          if(!p) continue;
          var st, r;
          try { st = getComputedStyle(p); r = p.getBoundingClientRect(); } catch(_){ continue; }
          if(r.width <= 0 || r.height <= 0) continue;
          out.push({
            text: t,
            fs: Math.round(parseFloat(st.fontSize) || 0),
            fw: parseInt(st.fontWeight, 10) || 400,
            // Where in the row: the name lives in the upper band.
            lower: rowR.height > 0 && r.top > rowR.top + rowR.height * 0.55
          });
        }
      } catch(_){}
      return out;
    }

    // A timestamp, an unread badge or a "Bạn:" prefix is never the name.
    function nameScore(part){
      var t = part.text;
      var score = part.fw + part.fs * 8;
      if(/^\\d{1,2}[\\/:.\\-]\\d{1,2}([\\/.\\-]\\d{2,4})?$/.test(t)) score -= 4000;  // 30/07 · 12:45
      if(/^\\d+\\+?$/.test(t)) score -= 4000;                                     // 26 · 37 · 41
      if(/[:：]$/.test(t)) score -= 3000;                                        // "Bạn:" · "A Hạnh:"
      if(/^(hôm qua|hom qua|hôm nay|hom nay|vài|vai|\\d+\\s*(phút|phut|giờ|gio|ngày|ngay|thg))/i.test(t)) score -= 3000;
      if(t.length < 2) score -= 1000;
      if(part.lower) score -= 300;                                              // preview line
      return score;
    }

    function pickName(parts){
      var best = null;
      for(var i=0;i<parts.length;i++){
        var s = nameScore(parts[i]);
        if(!best || s > best.score) best = { text: parts[i].text, score: s };
      }
      return best;
    }

    // A declared selector beats any amount of scoring — use it when the plugin
    // knows where the name lives, and fall back to typography otherwise.
    function nameOf(el, parts){
      for(var i=0;i<NAME_SEL.length;i++){
        var n = null;
        try { n = el.querySelector(NAME_SEL[i]); } catch(_){}
        if(n){
          var t = clip(n.textContent, 80);
          if(t) return t;
        }
      }
      var best = pickName(parts);
      return best ? best.text : '';
    }

    function pickId(attrs){
      var keys = Object.keys(attrs);
      for(var i=0;i<ID_ATTRS.length;i++){
        for(var j=0;j<keys.length;j++){
          if(keys[j] === ID_ATTRS[i] && attrs[keys[j]]) return { id: attrs[keys[j]], from: keys[j] };
        }
      }
      var best = null;
      for(var k=0;k<keys.length;k++){
        var key = keys[k], val = attrs[key];
        if(key.charAt(0) === '^') continue;
        if(!/(^|-)(id|uid|key|conv|thread|chat|room|peer)/i.test(key)) continue;
        if(val.length < 2 || val.length > 80) continue;
        if(!best || val.length > best.id.length) best = { id: val, from: key };
      }
      return best || { id:'', from:'' };
    }

    // The avatar's own id. Only trustworthy when the row has EXACTLY one: a
    // group collage carries one id per member and none of them is the group.
    function avatarId(el){
      for(var i=0;i<AVA_SEL.length;i++){
        var imgs = null;
        try { imgs = el.querySelectorAll(AVA_SEL[i]); } catch(_){}
        if(imgs && imgs.length === 1 && /^[0-9]{6,}$/.test(imgs[0].id || '')) return imgs[0].id;
      }
      return '';
    }

    /** id from attributes first, then the avatar. */
    function resolveId(el){
      var picked = pickId(attrsOf(el));
      if(picked.id) return picked;
      var aid = avatarId(el);
      return aid ? { id: aid, from: 'avatar' } : picked;
    }

    // Group or 1-1? Three signals, weakest last:
    //   1. a collage avatar (a group that set its own picture defeats this)
    //   2. the preview carries a sender prefix — "QuiDN:" means someone OTHER
    //      than the peer wrote, which only happens in a group. "Bạn:" is you,
    //      and proves nothing either way.
    //   3. more than one image in the row
    // Ambiguous stays 'user'; the directory is reviewed by a human anyway, and
    // guessing 'group' wrongly is the more confusing error.
    function isGroup(el, imgs, parts){
      for(var i=0;i<GROUP_SEL.length;i++){
        try { if(el.querySelector(GROUP_SEL[i])) return true; } catch(_){}
      }
      for(var p=0;p<parts.length;p++){
        var t = parts[p].text;
        if(t.length <= 30 && /[^\\s]:$/.test(t) && !/^(bạn|ban|you)\\s*:$/i.test(t)) return true;
      }
      return imgs >= 2;
    }

    // ── every place markup can hide: main doc, same-origin iframes, shadow DOM ──
    var roots = [{ r: document, label: 'main' }];
    R.diag.url = clip(location.href, 120);
    R.diag.title = clip(document.title, 80);
    try { R.diag.elements = document.querySelectorAll('*').length; } catch(_){}

    try {
      var frames = document.querySelectorAll('iframe,frame');
      for(var f=0; f<frames.length && f<10; f++){
        var info = { src: clip(frames[f].getAttribute('src') || '(inline)', 120), accessible:false, elements:0 };
        try {
          var fd = frames[f].contentDocument;
          if(fd && fd.querySelectorAll){
            info.accessible = true;
            info.elements = fd.querySelectorAll('*').length;
            roots.push({ r: fd, label: 'iframe#'+(f+1) });
          }
        } catch(_){ /* cross-origin — reported as accessible:false */ }
        R.diag.frames.push(info);
      }
    } catch(_){}

    // querySelectorAll does not pierce shadow roots — collect them explicitly.
    try {
      var docCount = roots.length;
      for(var d0=0; d0<docCount; d0++){
        var all0 = roots[d0].r.querySelectorAll('*');
        for(var i0=0; i0<all0.length; i0++){
          if(all0[i0].shadowRoot){
            R.diag.shadowRoots++;
            if(roots.length < 40) roots.push({ r: all0[i0].shadowRoot, label: roots[d0].label+'/shadow' });
          }
        }
      }
    } catch(_){}

    // ── score every repeated row-stack ────────────────────────────────────
    // Matched by TAG, not class: a chat list gives the selected/unread row an
    // extra class, and requiring identical classes found nothing at all.
    function rowsOf(el){
      var kids = el.children, out = [];
      if(!kids || !kids.length) return out;
      var tag = kids[0].tagName;
      for(var k=0;k<kids.length;k++){
        var kid = kids[k];
        if(kid.tagName !== tag) continue;
        if(!(kid.textContent||'').trim()) continue;
        var kr = kid.getBoundingClientRect();
        if(kr.height < 20 || kr.height > 220) continue;
        out.push(kid);
      }
      return out;
    }

    var cands = [];
    for(var rI=0; rI<roots.length; rI++){
      var all;
      try { all = roots[rI].r.querySelectorAll('*'); } catch(_){ continue; }
      for(var i=0;i<all.length;i++){
        var el = all[i];
        if(!el.children || el.children.length < 4) continue;
        var rws = rowsOf(el);
        if(rws.length < 4) continue;
        var rect = el.getBoundingClientRect();
        if(rect.height < 120) continue;
        var withImg = 0;
        for(var w2=0; w2<rws.length; w2++){
          if(rws[w2].querySelector('img,svg,canvas,picture')) withImg++;
        }
        var score = rws.length * Math.min(rect.height, 1500);
        if(withImg >= rws.length * 0.5) score *= 2.5;                      // avatars ⇒ a chat list
        if(rect.width >= 140 && rect.width <= 640) score *= 1.8;           // a sidebar, not the page
        if(rect.left < VW * 0.55) score *= 1.4;                            // lists sit on the left
        cands.push({
          el: el, root: roots[rI].label, path: pathOf(el), rows: rws.length, withImg: withImg,
          x: Math.round(rect.left), y: Math.round(rect.top),
          w: Math.round(rect.width), h: Math.round(rect.height),
          score: Math.round(score), sample: clip(rws[0].textContent, 50)
        });
      }
    }
    cands.sort(function(a,b){ return b.score - a.score; });
    R.diag.candidates = cands.slice(0,8).map(function(c){
      return { root:c.root, path:c.path, rows:c.rows, withImg:c.withImg,
               x:c.x, y:c.y, w:c.w, h:c.h, score:c.score, sample:c.sample };
    });

    // ── the app's own label / filter UI ───────────────────────────────────
    // Zalo has "Phân loại": the user tags contacts and groups there already.
    // Driving that filter beats guessing which rows belong together, and it
    // shortens the list so scrolling barely matters. Locate the control now;
    // clicking it is the next step.
    try {
      var pat = /^(phân loại|phan loai|tất cả|tat ca|chưa đọc|chua doc|nhóm|nhom)$/i;
      for(var rF=0; rF<roots.length && R.diag.filters.length < 14; rF++){
        var leafs;
        try { leafs = roots[rF].r.querySelectorAll('div,span,button,a,li,p'); } catch(_){ continue; }
        for(var fi=0; fi<leafs.length && R.diag.filters.length < 14; fi++){
          var fe = leafs[fi];
          if(fe.children && fe.children.length) continue;      // leaf text only
          var ft = (fe.textContent||'').trim();
          if(!ft || ft.length > 24 || !pat.test(ft)) continue;
          var fr = fe.getBoundingClientRect();
          if(fr.width <= 0 || fr.height <= 0) continue;
          R.diag.filters.push({
            text: ft, path: pathOf(fe),
            x: Math.round(fr.left), y: Math.round(fr.top),
            w: Math.round(fr.width), h: Math.round(fr.height)
          });
        }
      }
    } catch(_){}

    // ── choose: declared selectors first, then the best-scoring stack ──────
    function rowsBySel(el, sels){
      for(var i=0;i<sels.length;i++){
        var found = el.querySelectorAll(sels[i]);
        if(found && found.length >= 3) return Array.prototype.slice.call(found);
      }
      return [];
    }

    var container = null, rows = [], rootLabel = '';

    // A human overriding the guess wins over everything else.
    if(FORCE >= 0 && cands[FORCE]){
      container = cands[FORCE].el; rows = rowsOf(container);
      R.how = 'forced'; rootLabel = cands[FORCE].root;
    }

    for(var s=0; s<LIST_SEL.length && !container; s++){
      for(var rr=0; rr<roots.length && !container; rr++){
        var hits;
        try { hits = roots[rr].r.querySelectorAll(LIST_SEL[s]); } catch(_){ continue; }
        for(var h=0; h<hits.length; h++){
          var tryRows = ITEM_SEL.length ? rowsBySel(hits[h], ITEM_SEL) : rowsOf(hits[h]);
          if(tryRows.length >= 3){
            container = hits[h]; rows = tryRows; R.how = 'selector'; rootLabel = roots[rr].label; break;
          }
        }
      }
    }
    if(!container && cands.length){
      container = cands[0].el; rows = rowsOf(container); R.how = 'auto'; rootLabel = cands[0].root;
    }

    if(!container){
      R.error = R.diag.frames.some(function(f){ return !f.accessible; })
        ? 'không thấy danh sách nào — trang có iframe khác miền, nội dung có thể nằm trong đó'
        : 'không thấy khối nào gồm nhiều dòng giống nhau (đang ở màn hình đăng nhập?)';
      return R;
    }

    R.root = rootLabel;
    R.containerPath = pathOf(container);
    if(rows[0]) R.sampleHtml = clip(rows[0].outerHTML, 900);

    // Whatever the label control is called, it sits ABOVE the list in the SAME
    // column. Report every short text in that band instead of guessing at the
    // wording — the keyword probe above found nothing on the real page.
    try {
      var cr = container.getBoundingClientRect();
      var rootNode = container.getRootNode ? container.getRootNode() : document;
      var leafs2 = rootNode.querySelectorAll('div,span,button,a,li,p');
      for(var hi=0; hi<leafs2.length && R.diag.header.length < 20; hi++){
        var he = leafs2[hi];
        if(he.children && he.children.length) continue;
        var ht = (he.textContent||'').trim();
        if(!ht || ht.length > 20) continue;
        var hr = he.getBoundingClientRect();
        if(hr.width <= 0 || hr.height <= 0) continue;
        if(hr.top >= cr.top) continue;                                  // above the list
        if(hr.left < cr.left - 60 || hr.left > cr.right + 60) continue; // same column
        R.diag.header.push({
          text: ht, path: pathOf(he),
          x: Math.round(hr.left), y: Math.round(hr.top),
          w: Math.round(hr.width), h: Math.round(hr.height)
        });
      }
    } catch(_){}

    // Measure the ancestor chain BEFORE trying to scroll: when nothing moves,
    // this is the evidence that says why (nobody can scroll natively / the
    // scroller is a custom-scrollbar div with overflow:hidden / …).
    var chain = [], cEl = container, cGuard = 0;
    while(cEl && cEl.nodeType === 1 && cGuard++ < 8){
      var ov = '';
      try { ov = getComputedStyle(cEl).overflowY || ''; } catch(_){}
      chain.push({
        path: pathOf(cEl), scrollH: cEl.scrollHeight, clientH: cEl.clientHeight,
        overflowY: ov, canScroll: cEl.scrollHeight > cEl.clientHeight + 20
      });
      cEl = cEl.parentElement;
    }
    R.diag.scroll = chain;

    // The element that actually scrolls is often an ancestor of the row stack.
    var scroller = container, sEl = container, guard = 0;
    while(sEl && guard++ < 8){
      if(sEl.scrollHeight > sEl.clientHeight + 20){ scroller = sEl; break; }
      sEl = sEl.parentElement;
    }
    var startTop = scroller.scrollTop;

    // Are the ids actually PER ROW? A virtual list often reuses positional ids
    // (row-0, row-1…) or hangs one id on every row. Keying the directory on
    // those would collapse forty conversations into one — which is exactly what
    // the first real run did. Measure first, then decide what to key on.
    var idProbe = {}, idDistinct = 0, withId = 0;
    for(var q=0;q<rows.length;q++){
      var pq = resolveId(rows[q]);
      if(!pq.id) continue;
      withId++;
      if(!idProbe[pq.id]){ idProbe[pq.id] = 1; idDistinct++; }
    }
    var idsUnique = withId >= 2 && idDistinct === withId;
    R.diag.rowsProbed = rows.length;
    R.diag.idDistinct = idDistinct;
    R.diag.idsUnique = idsUnique;

    var seen = {}, items = [];
    function collect(list){
      for(var i=0;i<list.length && items.length < LIMIT;i++){
        var el = list[i];
        var attrs = attrsOf(el);
        var picked = resolveId(el);
        var parts = partsOf(el);
        var name = nameOf(el, parts);
        if(!name && !picked.id) continue;
        // Only an id proven unique may identify a row; otherwise the visible
        // name is the honest key.
        var key = (idsUnique && picked.id) ? ('id:' + picked.id) : ('name:' + name);
        if(seen[key]){ R.diag.dupSkipped++; continue; }
        seen[key] = 1;
        var imgs = el.querySelectorAll('img').length;
        var rest = [];
        for(var t2=0; t2<parts.length && rest.length<3; t2++){
          if(parts[t2].text !== name) rest.push(parts[t2].text);
        }
        items.push({
          convId: picked.id, idFrom: picked.from, name: name,
          kind: isGroup(el, imgs, parts) ? 'group' : 'user',
          texts: rest, imgs: imgs, attrs: attrs
        });
      }
    }

    // A virtual list REPLACES its nodes as it scrolls, and reading a container
    // that has been detached looks exactly like "the list refuses to scroll".
    // So re-find it by its path whenever it drops out of the document.
    function refind(){
      for(var rI2=0; rI2<roots.length; rI2++){
        var all2;
        try { all2 = roots[rI2].r.querySelectorAll('*'); } catch(_){ continue; }
        for(var i2=0;i2<all2.length;i2++){
          if(pathOf(all2[i2]) !== R.containerPath) continue;
          if(rowsOf(all2[i2]).length >= 3) return all2[i2];
        }
      }
      return null;
    }
    function currentRows(){
      if(!container || !container.isConnected){
        var again = refind();
        if(again) container = again; else return [];
      }
      return (R.how === 'selector' && ITEM_SEL.length) ? rowsBySel(container, ITEM_SEL) : rowsOf(container);
    }

    // Progress is judged by what the list SHOWS, not by scrollTop: a custom
    // scrollbar never touches scrollTop even while it is scrolling perfectly.
    function sigOf(list){
      if(!list || !list.length) return 'empty';
      return list.length + '|' + clip(list[0].textContent, 30) + '|' +
             clip(list[list.length-1].textContent, 30) + '|' + scroller.scrollTop;
    }

    var STRATS = ['scrollTop','intoView','wheel'];
    function applyStrategy(name, list){
      var step = Math.max(120, Math.floor((scroller.clientHeight || 400) * 0.8));
      try {
        if(name === 'scrollTop'){
          scroller.scrollTop = scroller.scrollTop + step;
        } else if(name === 'intoView'){
          // The reliable move for a virtual list: ask the LAST rendered row to
          // show itself. Works no matter which ancestor really scrolls, and it
          // is a native scroll so custom scrollbars follow along.
          list[list.length-1].scrollIntoView({ block:'end', inline:'nearest' });
        } else if(name === 'wheel'){
          // overflow:hidden + transform lists ignore scrollTop but listen for
          // wheel. A synthetic wheel does not scroll natively — irrelevant here,
          // the listener is the whole point.
          var t = list[Math.floor(list.length/2)] || container;
          t.dispatchEvent(new WheelEvent('wheel', { deltaY: step, deltaMode: 0, bubbles: true, cancelable: true }));
        }
      } catch(_){}
    }

    var canNative = scroller.scrollHeight > scroller.clientHeight + 20;
    var atEnd = function(){
      return canNative && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    };
    var homeText = rows[0] ? clip(rows[0].textContent, 30) : '';

    // ALWAYS start from the very top. The list keeps whatever position the user
    // left it at, and scanning only downwards silently drops everything above —
    // which is how a scan came back complete:true yet missing every recent
    // conversation.
    async function goTop(){
      if(canNative){
        scroller.scrollTop = 0;
        await sleep(340);
        return;
      }
      var last = '';
      for(var g=0; g<25; g++){
        var l = currentRows();
        if(!l.length) return;
        var s = clip(l[0].textContent, 30);
        if(s === last) return;                     // first row stopped changing = at the top
        last = s;
        try { l[0].scrollIntoView({ block:'start', inline:'nearest' }); } catch(_){}
        await sleep(300);
      }
    }

    await goTop();
    var top = currentRows();
    if(top.length){ rows = top; R.diag.rowsProbed = rows.length; }

    collect(rows);
    var strat = 0;
    for(var p=0; p<PASSES && items.length < LIMIT; p++){
      var list = currentRows();
      if(!list.length) break;
      var before = items.length, sig = sigOf(list);
      if(atEnd() && R.usedStrategy){ R.complete = true; break; }

      applyStrategy(STRATS[strat], list);
      R.passes = p + 1;
      await sleep(340);                      // let the virtual list render

      var after = currentRows();
      collect(after);
      if(items.length > before || sigOf(after) !== sig){
        R.usedStrategy = STRATS[strat];      // this one works here — keep it
      } else {
        // Nothing moved. Try the next technique before declaring defeat.
        strat++;
        if(strat >= STRATS.length){
          if(atEnd()) R.complete = true; else R.stuck = true;
          break;
        }
      }
    }
    if(atEnd() && !R.stuck) R.complete = true;

    // Put the list back where the user left it.
    try {
      scroller.scrollTop = startTop;
      if(homeText && R.usedStrategy && R.usedStrategy !== 'scrollTop'){
        var back = currentRows();
        for(var b=0;b<back.length;b++){
          if(clip(back[b].textContent, 30) === homeText){ back[b].scrollIntoView({ block:'start' }); break; }
        }
      }
    } catch(_){}

    R.items = items;
    R.ok = items.length > 0;
    if(!R.ok) R.error = 'tìm thấy khối danh sách nhưng không đọc được dòng nào';
    return R;
  } catch(e){
    R.error = String(e && e.message ? e.message : e);
    return R;
  }
})()`;
}

/** Rows that carry no id at all — the directory would have to match by name. */
export const idlessCount = (r: ScanResult): number => r.items.filter((i) => !i.convId).length;

/** Attribute names that produced an id, most common first — the tuning hint. */
export function idSources(r: ScanResult): { attr: string; count: number }[] {
  const tally = new Map<string, number>();
  for (const it of r.items) {
    if (!it.idFrom) continue;
    tally.set(it.idFrom, (tally.get(it.idFrom) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([attr, count]) => ({ attr, count }))
    .sort((a, b) => b.count - a.count);
}
