// Browser Workspace Framework — ảnh đại diện của TÀI KHOẢN ĐANG ĐĂNG NHẬP.
//
// Rail vẽ huy hiệu app (BrandMark): nhìn là biết Zalo hay Telegram, nhưng KHÔNG
// biết đang là tài khoản nào — hai dòng Zalo cạnh nhau trông y hệt, mà nhãn thì
// người dùng đổi thành "Sếp"/"CSKH" nên cũng không cứu được. Ảnh đại diện thật
// là thứ duy nhất phân biệt được bằng mắt trong một nhịp.
//
// AI TẢI ẢNH: MAIN PROCESS, KHÔNG PHẢI GUEST.
//
// Avatar được phục vụ từ CDN khác gốc (s160-26-ava-talk.zadn.vn, scontent.*,
// cdn5.telesco.pe) và KHÔNG kèm header CORS. Trong guest, cả hai đường đều chết
// đúng với loại ảnh ta cần:
//
//   - canvas: drawImage chạy được, nhưng canvas thành "tainted" nên toDataURL
//     ném SecurityError. Thêm crossOrigin='anonymous' còn tệ hơn — request bị
//     chặn hẳn, onload không bao giờ chạy.
//   - fetch(): net::ERR_FAILED, vì thiếu Access-Control-Allow-Origin. Dùng
//     mode:'no-cors' thì được response mờ (opaque), đọc không ra bytes.
//
// Nên script này KHÔNG tải ảnh. Nó chỉ tìm phần tử avatar và trả về URL; renderer
// cầm URL đó gọi `window.workspace.fetchImage(partition, url)`, main process tải
// bằng `net.request` qua đúng session của partition — tầng mạng không có khái
// niệm CORS, mà cookie phiên vẫn được gửi nên ảnh riêng tư vẫn tải được.
//
// Ngoại lệ: `data:` (đã là bytes) và `blob:` (chỉ sống trong guest, main process
// tra không ra) được xử lý ngay tại chỗ.

/** Khai báo cách tìm avatar tài khoản của một app. */
export interface AvatarSpec {
  /**
   * Nơi đặt ảnh đại diện của CHÍNH mình, ưu tiên từ trên xuống. Phải trỏ vào
   * khung "tài khoản tôi" (nút mở menu cá nhân, thanh bên), TUYỆT ĐỐI không
   * trỏ vào danh sách hội thoại — ở đó là mặt người khác.
   */
  selectors: string[];
  /**
   * Ảnh nhỏ hơn ngần này (px) coi như icon giao diện, không phải avatar. Chặn
   * trường hợp selector vô tình bắt trúng một icon 16px. Mặc định 24.
   *
   * Đo bằng KÍCH THƯỚC HIỂN THỊ (getBoundingClientRect) chứ không phải
   * naturalWidth: avatar hay được phục vụ ở ảnh gốc rất nhỏ hoặc rất to, còn ô
   * hiển thị mới phản ánh "đây là một avatar".
   */
  minSize?: number;
  /**
   * Cứu cánh khi mọi selector đều trượt: quét toàn trang tìm ảnh nằm ở GÓC TRÊN
   * BÊN TRÁI khung nhìn — chỗ mọi app chat đặt "tài khoản tôi".
   *
   * Vì sao cần: class của Zalo/Facebook là chuỗi sinh tự động, đổi theo mỗi lần
   * họ dựng lại giao diện, nên selector viết tay có tuổi thọ ngắn. Vị trí thì
   * không đổi — avatar của mình mười năm nay vẫn nằm góc trên trái.
   *
   * Chặn nhầm sang danh sách hội thoại bằng `excludeSelectors` (tổ tiên của ảnh
   * khớp cái nào trong đó thì loại) + giới hạn ô quét.
   */
  probeCorner?: {
    /** Bề rộng vùng quét tính từ mép ngang (px). Mặc định 120. */
    width?: number;
    /** Chiều cao vùng quét tính từ mép trên (px). Mặc định 220. */
    height?: number;
    /**
     * Quét từ mép PHẢI thay vì mép trái. Facebook để avatar tài khoản ở góc
     * trên-phải (thanh điều hướng), ngược với đám app chat.
     */
    fromRight?: boolean;
    /** Ảnh có tổ tiên khớp các selector này thì bỏ (danh sách hội thoại…). */
    excludeSelectors?: string[];
  };
}

/** Kết quả đọc avatar. `ok` sai thì `why` nói rõ hụt ở đâu — không đoán mò. */
export interface AvatarProbe {
  ok: boolean;
  /** data URL khi ok. */
  dataUrl?: string;
  /**
   * Lý do hụt. `need-fetch` KHÔNG phải lỗi — nó nghĩa là đã tìm thấy avatar và
   * `src` đang chờ main process tải hộ (xem đầu file).
   * Còn lại: no-match | no-match-probe | not-loaded | too-small | blob-failed |
   * read-failed | threw.
   */
  why?: string;
  /** Selector đã khớp (chẩn đoán khi phải chỉnh selector). */
  matched?: string;
  /** URL ảnh tìm được (chẩn đoán). */
  src?: string;
  /** Mỗi selector khớp bao nhiêu phần tử — biết ngay cái nào trượt. */
  counts?: Record<string, number>;
}

/**
 * Biểu thức tìm avatar trong guest. Trả về AvatarProbe (hoặc Promise của nó khi
 * gặp `blob:`) — executeJavaScript chờ được cả hai dạng.
 *
 * Không bao giờ ném: poll này chạy trên trang của người khác, lỗi lọt ra chỉ
 * làm rác console của guest.
 */
export function buildAvatarScript(spec: AvatarSpec): string {
  const sel = JSON.stringify(spec.selectors ?? []);
  const min = Math.max(1, Math.floor(spec.minSize ?? 24));
  const probe = spec.probeCorner;
  const pw = Math.max(1, Math.floor(probe?.width ?? 120));
  const ph = Math.max(1, Math.floor(probe?.height ?? 220));
  const excl = JSON.stringify(probe?.excludeSelectors ?? []);
  const useProbe = probe ? 'true' : 'false';
  const fromRight = probe?.fromRight ? 'true' : 'false';
  return `(function(){try{
  var SEL=${sel},MIN=${min};
  var PROBE=${useProbe},PW=${pw},PH=${ph},EXCL=${excl},RIGHT=${fromRight};
  var counts={};

  // Lấy URL ảnh từ <img> hoặc <image> (Facebook vẽ avatar bằng SVG <image>).
  function srcOf(el){
    if(!el||!el.tagName)return '';
    var t=String(el.tagName).toUpperCase();
    if(t==='IMG')return el.currentSrc||el.src||'';
    if(t==='IMAGE')return el.getAttribute('href')||el.getAttribute('xlink:href')||'';
    return '';
  }

  var found=null,why='no-match';
  for(var i=0;i<SEL.length;i++){
    var list;
    try{list=document.querySelectorAll(SEL[i]);}catch(e){counts[SEL[i]]=-1;continue;}
    counts[SEL[i]]=list.length;
    if(found)continue;                      // vẫn đếm nốt để chẩn đoán
    for(var j=0;j<list.length;j++){
      var el=list[j];
      var cand=srcOf(el)?el:(el.querySelector?el.querySelector('img,image'):null);
      var src=srcOf(cand);
      if(!src){if(why==='no-match')why='not-loaded';continue;}
      // data:/blob: cũng hợp lệ — WhatsApp dùng blob: cho avatar.
      var box=cand.getBoundingClientRect?cand.getBoundingClientRect():{width:0,height:0};
      // Phần tử ẩn (ngăn kéo đóng) có box 0 — KHÔNG loại, vì Telegram giấu
      // ngăn kéo mà ảnh vẫn đúng. Chỉ loại khi thấy rõ là icon bé.
      if(box.width&&box.height&&(box.width<MIN||box.height<MIN)){
        if(why==='no-match'||why==='not-loaded')why='too-small';continue;
      }
      found={src:src,sel:SEL[i]};break;
    }
  }
  // Cứu cánh: quét ảnh ở góc trên-trái. Chỉ chạy khi selector trượt hết.
  if(!found&&PROBE){
    var best=null;
    var imgs=document.querySelectorAll('img,image');
    for(var k=0;k<imgs.length;k++){
      var e2=imgs[k],s2=srcOf(e2);
      if(!s2)continue;
      var b2=e2.getBoundingClientRect?e2.getBoundingClientRect():null;
      if(!b2||!b2.width||!b2.height)continue;
      if(b2.width<MIN||b2.height<MIN)continue;
      // Phải nằm trong ô ở góc trên (trái hoặc phải tùy app).
      if(b2.top<0||b2.top>PH)continue;
      if(RIGHT){
        var vw=window.innerWidth||document.documentElement.clientWidth||0;
        if(b2.right>vw+1||b2.right<vw-PW)continue;
      }else{
        if(b2.left<0||b2.left>PW)continue;
      }
      // Gần vuông — avatar là hình vuông/tròn, banner thì không.
      var ratio=b2.width/b2.height;
      if(ratio<0.8||ratio>1.25)continue;
      // Loại nếu nằm trong danh sách hội thoại (mặt người khác).
      var bad=false;
      for(var m=0;m<EXCL.length&&!bad;m++){
        try{if(e2.closest&&e2.closest(EXCL[m]))bad=true;}catch(e){}
      }
      if(bad)continue;
      // Cao nhất trước; hòa thì lấy cái sát mép mình đang quét (trái hoặc phải).
      var edge=RIGHT?-b2.right:b2.left;
      if(!best||b2.top<best.top-4||(Math.abs(b2.top-best.top)<=4&&edge<best.edge)){
        best={src:s2,top:b2.top,edge:edge};
      }
    }
    if(best){found={src:best.src,sel:'probeCorner'};}
    else if(why==='no-match')why='no-match-probe';
  }
  if(!found)return {ok:false,why:why,counts:counts};

  if(found.src.indexOf('data:')===0)
    return {ok:true,dataUrl:found.src,matched:found.sel,src:'data:',counts:counts};

  // blob: CHỈ sống trong guest — main process tra ra không có gì. Nhưng nó cùng
  // gốc nên fetch ngay tại đây được (WhatsApp Web dùng dạng này cho avatar).
  if(found.src.indexOf('blob:')===0){
    return fetch(found.src)
      .then(function(r){return r.blob();})
      .then(function(b){return new Promise(function(res,rej){
        var fr=new FileReader();
        fr.onload=function(){res(String(fr.result||''));};
        fr.onerror=function(){rej(new Error('read'));};
        fr.readAsDataURL(b);
      });})
      .then(function(d){
        return d.indexOf('data:image/')===0
          ? {ok:true,dataUrl:d,matched:found.sel,src:'blob:',counts:counts}
          : {ok:false,why:'read-failed',src:'blob:',counts:counts};
      })
      .catch(function(e){
        return {ok:false,why:'blob-failed',src:'blob:',
                detail:String((e&&e.message)||e),counts:counts};
      });
  }

  // Còn lại: KHÔNG tự tải. fetch() ở đây chết vì CORS (avatar nằm ở CDN khác
  // gốc, không kèm Access-Control-Allow-Origin) — đó chính là ERR_FAILED thấy
  // trong console. Chỉ trả URL về, renderer nhờ main process tải hộ ở tầng
  // mạng, nơi không có khái niệm CORS.
  return {ok:false,why:'need-fetch',src:found.src,matched:found.sel,counts:counts};
}catch(e){return {ok:false,why:'threw',detail:String((e&&e.message)||e)};}})()`;
}
