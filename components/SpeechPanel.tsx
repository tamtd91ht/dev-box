'use client';

// Tab "Giọng nói" trong Tools — STT & TTS, hai chiều cạnh nhau:
//
//   · TRÁI  Âm thanh → Chữ (STT): thả / chọn file âm thanh hay video, hoặc ghi
//           âm từ micro. Nhận dạng bằng Whisper CHẠY TRÊN MÁY (lib/speechServer.ts)
//           — âm thanh không rời máy. Chữ hiện dần theo từng đoạn, dừng được.
//   · PHẢI  Chữ → Âm thanh (TTS): dán chữ, nghe thử hoặc tải file .mp3. Giọng
//           đọc của Google (cùng nguồn với nút 🔊 của Dịch nhanh) — chữ được gửi
//           tới Google, nên đừng đưa nội dung mật vào đây.
//
// NHÀ CUNG CẤP: mỗi cột có ô chọn nhà cung cấp. Mặc định là hai thứ trên; nút
// "⚙ Nhà cung cấp" mở hộp thoại thêm nhà cung cấp tích hợp qua API bằng cấu
// hình động (components/SpeechProviderManager.tsx). Lựa chọn dùng chung với
// nút micro / nút Đọc của trợ lý (lib/useSpeechProviders.ts).
//
// Ngôn ngữ + model STT nhớ chung với nút micro của trợ lý (lib/useStt.ts).
// Mỗi cột chỉ một nút đặc; mọi khối có trạng thái đang chạy / trống / lỗi.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  STT_LANGS, STT_LIMITS, STT_MODELS, TTS_LANGS, TTS_MAX_CHARS, decodeToPcm16k, fmtDuration, pcmSampleBase64, speaker, sttStatus, ttsToBlob,
  type SttStatus,
} from '@/lib/speech';
import { DEFAULT_PROVIDER, DEFAULT_PROVIDER_NAME, extOfMime, type ProviderKind } from '@/lib/speechProviders';
import { speechProviders, useSpeechProviders } from '@/lib/useSpeechProviders';
import { useStt, useSttPrefs } from '@/lib/useStt';
import SpeechProviderManager from './SpeechProviderManager';

const TTS_LANG_KEY = 'speech.ttsLang';
const SPEAK_KEY = 'tools-tts';
const num = (n: number) => n.toLocaleString('vi-VN');

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function SpeechPanel() {
  // ── STT ────────────────────────────────────────────────────────────────────
  const stt = useStt();
  const prefs = useSttPrefs();
  const providers = useSpeechProviders();
  /** Hộp thoại quản lý nhà cung cấp đang mở cho loại nào (null = đóng). */
  const [manage, setManage] = useState<ProviderKind | null>(null);
  const [models, setModels] = useState<SttStatus['models'] | null>(null);
  const [source, setSource] = useState<{ blob: Blob; name: string; url: string } | null>(null);
  const [text, setText] = useState('');
  const [sttNote, setSttNote] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);

  const loadModels = useCallback(() => { sttStatus().then((s) => setModels(s.models)).catch(() => setModels(null)); }, []);
  useEffect(() => { loadModels(); }, [loadModels]);

  // Chữ hiện dần trong lúc nhận dạng.
  useEffect(() => { if (stt.state.phase === 'working' && stt.state.partial) setText(stt.state.partial); }, [stt.state.phase, stt.state.partial]);

  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source]);

  const run = useCallback(async (blob: Blob, name: string, keepSource = false) => {
    setSttNote(null);
    setText('');
    if (!keepSource) setSource({ blob, name, url: URL.createObjectURL(blob) });
    const done = await stt.transcribeBlob(blob, { model: prefs.model, language: prefs.language, provider: providers.stt?.id });
    if (done) {
      setText(done.text);
      if (!done.text) setSttNote('Không nghe ra chữ nào — âm thanh quá nhỏ, toàn nhạc/tiếng ồn, hoặc chọn sai ngôn ngữ.');
      loadModels(); // model vừa tải xong → đổi nhãn "đã tải"
    }
  }, [stt, prefs.model, prefs.language, providers.stt?.id, loadModels]);

  const pickFiles = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    if (files.length > 1) setSttNote(`Mỗi lượt một file — đang nhận dạng ${f.name}.`);
    void run(f, f.name);
  };

  const toggleRec = async () => {
    if (stt.state.phase === 'recording') {
      const blob = await stt.stopRec();
      if (blob && blob.size) void run(blob, `ghi-âm-${new Date().toLocaleTimeString('vi-VN').replace(/:/g, '-')}.webm`);
      return;
    }
    void stt.startRec();
  };

  const working = stt.state.phase === 'working';
  const recording = stt.state.phase === 'recording';
  const curModel = models?.find((m) => m.id === prefs.model);

  // ── TTS ────────────────────────────────────────────────────────────────────
  const speak = useSyncExternalStore(speaker.subscribe, speaker.getSnapshot, speaker.getServerSnapshot);
  const [ttsText, setTtsText] = useState('');
  const [ttsLang, setTtsLang] = useState('auto');
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);
  const [ttsErr, setTtsErr] = useState<string | null>(null);
  const [mp3, setMp3] = useState<{ url: string; name: string } | null>(null);

  useEffect(() => {
    try {
      const l = window.localStorage.getItem(TTS_LANG_KEY);
      if (l && TTS_LANGS.some((x) => x.id === l)) setTtsLang(l);
    } catch { /* nicety */ }
  }, []);
  useEffect(() => () => { if (mp3) URL.revokeObjectURL(mp3.url); }, [mp3]);
  // Rời tab thì ngừng đọc.
  useEffect(() => () => { if (speaker.getSnapshot().key === SPEAK_KEY) speaker.stop(); }, []);

  const playing = speak.key === SPEAK_KEY;
  const tooLong = ttsText.length > TTS_MAX_CHARS;
  /** Nhà cung cấp đọc đang chọn (rỗng = Google) + cỡ mỗi lần gọi của nó. */
  const ttsVia = providers.tts ? { provider: providers.tts.id, partChars: providers.tts.maxChars } : {};
  const canSpeak = ttsText.trim() !== '' && !tooLong;

  const exportMp3 = async () => {
    if (!canSpeak || exporting) return;
    setTtsErr(null);
    setExporting({ done: 0, total: 1 });
    try {
      const blob = await ttsToBlob(ttsText, ttsLang, (done, total) => setExporting({ done, total }), ttsVia);
      const ext = extOfMime(blob.type);
      const name = `doc-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
      setMp3({ url: URL.createObjectURL(blob), name });
      download(blob, name);
    } catch (e) {
      setTtsErr((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="sp-wrap">
      <div className="epoch-cols sp-cols">
        {/* ── STT ─────────────────────────────────────────────────────────── */}
        <section className="epoch-card sp-card">
          <div className="tools-pane-head">
            🎙 Âm thanh → Chữ{' '}
            <span className="tools-pane-hint">
              {providers.stt ? `STT · âm thanh được gửi tới ${providers.stt.name}` : 'STT · Whisper chạy trên máy, âm thanh không gửi đi đâu'}
            </span>
          </div>
          <div className="epoch-card-body">
            <div
              className={`sp-drop${dropping ? ' on' : ''}${recording ? ' rec' : ''}`}
              onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragDepth.current += 1; setDropping(true); } }}
              onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } }}
              onDragLeave={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                dragDepth.current -= 1;
                if (dragDepth.current <= 0) { dragDepth.current = 0; setDropping(false); }
              }}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault(); e.stopPropagation();
                dragDepth.current = 0; setDropping(false);
                if (!working && !recording) pickFiles([...e.dataTransfer.files]);
              }}
            >
              {recording ? (
                <>
                  <p className="sp-drop-title"><span className="sp-recdot" aria-hidden /> Đang ghi âm · {fmtDuration(stt.state.recSeconds)}</p>
                  <div className="sp-row">
                    <button className="sp-cta" onClick={() => void toggleRec()}>■ Dừng &amp; nhận dạng</button>
                    <button className="ghost sm" onClick={stt.cancel}>Huỷ</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="sp-drop-title">Thả file âm thanh hoặc video vào đây</p>
                  <p className="sp-drop-sub">mp3 · wav · m4a · ogg · webm · mp4… tối đa {Math.round(STT_LIMITS.maxSeconds / 60)} phút mỗi lượt</p>
                  <div className="sp-row">
                    <button className="sp-cta" onClick={() => fileRef.current?.click()} disabled={working}>Chọn file</button>
                    <button className="ghost sm" onClick={() => void toggleRec()} disabled={working} title="Ghi âm từ micro rồi nhận dạng">
                      ● Ghi âm
                    </button>
                  </div>
                </>
              )}
              <input ref={fileRef} type="file" hidden accept="audio/*,video/*,.mp3,.wav,.m4a,.ogg,.oga,.opus,.flac,.aac,.webm,.mp4,.mkv,.mov"
                onChange={(e) => { pickFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </div>

            <div className="sp-opts">
              <label className="sp-field sp-field-wide">
                <span>Nhà cung cấp</span>
                <select className="input" value={providers.stt?.id ?? DEFAULT_PROVIDER} disabled={working || recording}
                  onChange={(e) => speechProviders.select('stt', e.target.value)}>
                  <option value={DEFAULT_PROVIDER}>{DEFAULT_PROVIDER_NAME.stt}</option>
                  {providers.of('stt').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <button className="ghost sm" onClick={() => setManage('stt')} title="Thêm / sửa nhà cung cấp tích hợp qua API">⚙ Nhà cung cấp</button>
            </div>
            <div className="sp-opts">
              <label className="sp-field">
                <span>Ngôn ngữ nói</span>
                <select className="input" value={prefs.language} disabled={working || recording} onChange={(e) => prefs.setLanguage(e.target.value)}>
                  {STT_LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
              </label>
              {!providers.stt && (
              <label className="sp-field">
                <span>Model</span>
                <select className="input" value={prefs.model} disabled={working || recording} onChange={(e) => prefs.setModel(e.target.value)}>
                  {(models ?? []).length
                    ? models!.map((m) => <option key={m.id} value={m.id}>{m.label}{m.cached ? '' : ` — tải ${m.sizeMb} MB lần đầu`}</option>)
                    : STT_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </label>
              )}
            </div>
            {providers.stt && (
              <p className="small epoch-note">
                Nhận dạng bằng API của {providers.stt.name} ({providers.stt.endpoint.replace(/^https?:\/\//, '').split(/[/?]/)[0]}) — âm thanh rời máy, không có tiến độ từng đoạn.
              </p>
            )}
            {!providers.stt && curModel && (
              <p className="small epoch-note">
                {curModel.hint} · {curModel.cached ? 'đã có sẵn trên máy' : `sẽ tải ${curModel.sizeMb} MB ở lần dùng đầu (cần mạng)`}.
              </p>
            )}

            {source && (
              <div className="sp-source">
                <span className="sp-source-name" title={source.name}>📄 {source.name}</span>
                <audio className="sp-audio" src={source.url} controls preload="metadata" />
              </div>
            )}

            {working && (
              <div className="sp-progress" role="status">
                <div className="sp-progress-row">
                  <span>{stt.state.status}</span>
                  <button className="ghost sm" onClick={stt.cancel}>Dừng</button>
                </div>
                <div className={`sp-bar${stt.state.progress === null ? ' busy' : ''}`} aria-hidden>
                  <i style={{ width: `${Math.round((stt.state.progress ?? 0.3) * 100)}%` }} />
                </div>
              </div>
            )}
            {!working && stt.state.status && !stt.state.error && <p className="small sp-done">{stt.state.status}</p>}
            {stt.state.error && (
              <div className="sp-error" role="alert">
                <span>{stt.state.error}</span>
                {source && <button className="ghost sm" onClick={() => void run(source.blob, source.name, true)}>Thử lại</button>}
              </div>
            )}
            {sttNote && <p className="small sp-warn" role="status">{sttNote}</p>}

            <textarea
              className="sp-text"
              value={text}
              readOnly={working}
              placeholder="Chữ nhận dạng được sẽ hiện ở đây — sửa trực tiếp được."
              aria-label="Chữ nhận dạng được"
              onChange={(e) => setText(e.target.value)}
            />
            <div className="sp-row sp-actions">
              <span className="small sp-count">{text ? `${num(text.length)} ký tự` : 'Chưa có chữ'}</span>
              <span style={{ flex: 1 }} />
              {source && !working && (
                <button className="ghost sm" onClick={() => void run(source.blob, source.name, true)}
                  title="Chạy lại với ngôn ngữ / model đang chọn">↻ Nhận dạng lại</button>
              )}
              <button className="ghost sm" disabled={!text}
                onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ } }}>
                {copied ? '✓ Đã chép' : '⧉ Sao chép'}
              </button>
              <button className="ghost sm" disabled={!text}
                onClick={() => download(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${(source?.name ?? 'van-ban').replace(/\.[^.]+$/, '')}.txt`)}>
                ⬇ Tải .txt
              </button>
              <button className="ghost sm" disabled={!text} onClick={() => { setTtsText(text); setTtsErr(null); }}
                title="Đưa chữ này sang cột bên phải để đọc lại">→ Sang TTS</button>
            </div>
          </div>
        </section>

        {/* ── TTS ─────────────────────────────────────────────────────────── */}
        <section className="epoch-card sp-card">
          <div className="tools-pane-head">
            🔊 Chữ → Âm thanh{' '}
            <span className="tools-pane-hint">
              {providers.tts ? `TTS · chữ được gửi tới ${providers.tts.name}` : 'TTS · giọng đọc Google, chữ được gửi tới Google'}
            </span>
          </div>
          <div className="epoch-card-body">
            <textarea
              className="sp-text sp-text-tts"
              value={ttsText}
              placeholder="Dán hoặc gõ chữ cần đọc…"
              aria-label="Chữ cần đọc"
              onChange={(e) => { setTtsText(e.target.value); setTtsErr(null); }}
            />
            <div className="sp-opts">
              <label className="sp-field sp-field-wide">
                <span>Nhà cung cấp</span>
                <select className="input" value={providers.tts?.id ?? DEFAULT_PROVIDER}
                  onChange={(e) => { speaker.stop(); speechProviders.select('tts', e.target.value); }}>
                  <option value={DEFAULT_PROVIDER}>{DEFAULT_PROVIDER_NAME.tts}</option>
                  {providers.of('tts').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <button className="ghost sm" onClick={() => setManage('tts')} title="Thêm / sửa nhà cung cấp tích hợp qua API">⚙ Nhà cung cấp</button>
            </div>
            <div className="sp-opts">
              <label className="sp-field">
                <span>Ngôn ngữ đọc</span>
                <select className="input" value={ttsLang}
                  onChange={(e) => {
                    setTtsLang(e.target.value);
                    try { window.localStorage.setItem(TTS_LANG_KEY, e.target.value); } catch { /* nicety */ }
                  }}>
                  {TTS_LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
              </label>
              <span className={`small sp-count${tooLong ? ' over' : ''}`}>{num(ttsText.length)} / {num(TTS_MAX_CHARS)} ký tự</span>
            </div>
            {tooLong && <p className="small sp-warn" role="alert">Dài quá {num(TTS_MAX_CHARS)} ký tự — cắt bớt hoặc chia làm nhiều lần.</p>}
            {(ttsErr || (speak.error && !playing)) && (
              <div className="sp-error" role="alert"><span>{ttsErr ?? speak.error}</span></div>
            )}
            <div className="sp-row sp-actions">
              <button className="sp-cta" disabled={!canSpeak && !playing}
                onClick={() => void speaker.speak(SPEAK_KEY, ttsText, ttsLang, ttsVia)}>
                {playing ? (speak.loading ? '… Đang tải' : '■ Dừng') : '▶ Nghe'}
              </button>
              <button className="ghost sm" disabled={!canSpeak || exporting !== null} onClick={() => void exportMp3()}
                title="Ghép toàn bộ thành một file MP3 và tải về">
                {exporting ? `Đang tạo file… ${exporting.done}/${exporting.total}` : '⬇ Tải file'}
              </button>
              <span style={{ flex: 1 }} />
              <button className="ghost sm" disabled={!ttsText} onClick={() => { setTtsText(''); setTtsErr(null); }}>Xoá</button>
            </div>
            {mp3 && (
              <div className="sp-source">
                <span className="sp-source-name" title={mp3.name}>🎵 {mp3.name}</span>
                <audio className="sp-audio" src={mp3.url} controls preload="metadata" />
              </div>
            )}
            {!ttsText && !mp3 && <p className="small epoch-note">Chưa có chữ. Dán văn bản vào ô trên rồi bấm “Nghe”, hoặc bấm “→ Sang TTS” ở cột bên trái.</p>}
          </div>
        </section>
      </div>

      {manage && (
        <SpeechProviderManager
          kind={manage}
          onClose={() => setManage(null)}
          // Mẫu để thử nhà cung cấp STT: chính file đang mở ở cột trái.
          getSttSample={async () => (source ? pcmSampleBase64(await decodeToPcm16k(source.blob)) : null)}
        />
      )}
    </div>
  );
}
