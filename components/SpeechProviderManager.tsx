'use client';

// Quản lý nhà cung cấp STT / TTS tích hợp qua API — hộp thoại mở từ công cụ
// Giọng nói. Trái: danh sách (mặc định + các bản đã thêm). Phải: form cấu hình
// một nhà cung cấp, đi đúng thứ tự một lần gọi API:
//   Tên → Endpoint → Authentication → Headers → Biến tự đặt → Body → Response
// rồi khối THỬ: gọi thật bằng bản cấu hình đang soạn (chưa cần lưu) và hiện
// nguyên phản hồi của API bên cạnh kết quả đọc được — để dò đường dẫn output
// thay vì đoán. Kiểu cấu hình + cú pháp biến: lib/speechProviders.ts.
//
// Một nút đặc duy nhất (Lưu, xanh lá); xoá phải bấm hai lần; khoá API nhập ở ô
// che ký tự.

import { useEffect, useMemo, useRef, useState } from 'react';
import { providerRemove, providerSave, providerTest, type ProviderTestResult } from '@/lib/speech';
import {
  AUDIO_FORMATS, DEFAULT_PROVIDER_NAME, PROVIDER_PRESETS, PROVIDER_VARS, blankProvider, templateVars, withScheme,
  type KV, type ProviderAuth, type ProviderBody, type ProviderKind, type ProviderResponse, type SpeechProvider,
} from '@/lib/speechProviders';
import { speechProviders, useSpeechProviders } from '@/lib/useSpeechProviders';

const KIND_LABEL: Record<ProviderKind, string> = { stt: 'STT · âm thanh → chữ', tts: 'TTS · chữ → âm thanh' };

/** Bảng khoá – giá trị sửa được (headers, biến, trường form). */
function KVEditor(props: {
  rows: KV[]; onChange: (rows: KV[]) => void;
  keyPlaceholder: string; valuePlaceholder: string; addLabel: string; label: string;
}) {
  const { rows, onChange } = props;
  const patch = (i: number, p: Partial<KV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="spm-kv">
      {rows.map((r, i) => (
        <div key={i} className="spm-kv-row">
          <input className="input spm-mono" value={r.key} placeholder={props.keyPlaceholder}
            aria-label={`${props.label} — tên dòng ${i + 1}`} onChange={(e) => patch(i, { key: e.target.value })} />
          <input className="input spm-mono" value={r.value} placeholder={props.valuePlaceholder}
            aria-label={`${props.label} — giá trị dòng ${i + 1}`} onChange={(e) => patch(i, { value: e.target.value })} />
          <button className="spm-x" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Xoá dòng ${i + 1}`} title="Xoá dòng">✕</button>
        </div>
      ))}
      <button className="ghost sm spm-add" onClick={() => onChange([...rows, { key: '', value: '' }])}>＋ {props.addLabel}</button>
    </div>
  );
}

export default function SpeechProviderManager(props: {
  /** Loại mở sẵn (cột nào bấm ⚙ thì mở loại đó). */
  kind: ProviderKind;
  /** Âm thanh mẫu để thử nhà cung cấp STT (PCM base64 của file đang mở ở cột STT); null = chưa có file. */
  getSttSample: () => Promise<string | null>;
  onClose: () => void;
}) {
  const providers = useSpeechProviders();
  const [draft, setDraft] = useState<SpeechProvider | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [askDel, setAskDel] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [testText, setTestText] = useState('Xin chào, đây là câu thử giọng đọc.');
  const [testLang, setTestLang] = useState('vi');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Esc đóng hộp thoại.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);

  const open = (p: SpeechProvider) => {
    setDraft(JSON.parse(JSON.stringify(p)) as SpeechProvider);
    setErr(null); setSaved(false); setAskDel(false); setTest(null); setShowSecret(false);
  };
  const startNew = (kind: ProviderKind) => { open(blankProvider(kind)); setTimeout(() => nameRef.current?.focus(), 0); };

  const up = (p: Partial<SpeechProvider>) => { setDraft((d) => (d ? { ...d, ...p } : d)); setSaved(false); };

  /** Biến dùng trong template mà chưa được định nghĩa ở đâu → cảnh báo sớm. */
  const unknownVars = useMemo(() => {
    if (!draft) return [];
    const known = new Set([...PROVIDER_VARS[draft.kind].map((v) => v.name), ...draft.vars.map((v) => v.key.trim())]);
    const used = new Set<string>();
    const scan = (s: string) => templateVars(s).forEach((v) => used.add(v));
    scan(draft.endpoint);
    draft.headers.forEach((h) => scan(h.value));
    if (draft.auth.type === 'header') scan(draft.auth.value);
    if (draft.body.type === 'json' || draft.body.type === 'raw') scan(draft.body.template);
    if (draft.body.type === 'form' || draft.body.type === 'urlencoded') draft.body.fields.forEach((f) => scan(f.value));
    return [...used].filter((v) => !known.has(v));
  }, [draft]);

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true); setErr(null);
    try {
      const list = await providerSave(draft);
      speechProviders.setList(list);
      // Bản mới: mở lại đúng bản vừa tạo (đã có id) để lần Lưu sau là cập nhật.
      const cur = draft.id ? list.find((p) => p.id === draft.id) : [...list].reverse().find((p) => p.name === draft.name.trim() && p.kind === draft.kind);
      if (cur) setDraft(JSON.parse(JSON.stringify(cur)) as SpeechProvider);
      setSaved(true);
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!draft?.id) return;
    try {
      speechProviders.setList(await providerRemove(draft.id));
      setDraft(null); setAskDel(false);
    } catch (e) { setErr((e as Error).message); }
  };

  const runTest = async () => {
    if (!draft || testing) return;
    setTesting(true); setTest(null);
    try {
      if (draft.kind === 'tts') {
        setTest(await providerTest(draft, { text: testText, language: testLang }));
      } else {
        const pcm = await props.getSttSample();
        if (!pcm) { setTest({ ok: false, error: 'Chưa có âm thanh để thử — đóng hộp thoại, chọn một file ở cột “Âm thanh → Chữ” rồi mở lại.', debug: null }); return; }
        setTest(await providerTest(draft, { pcm, language: testLang }));
      }
    } catch (e) {
      setTest({ ok: false, error: (e as Error).message, debug: null });
    } finally { setTesting(false); }
  };

  const setAuthType = (type: ProviderAuth['type']) => {
    const a: ProviderAuth = type === 'bearer' ? { type, token: '' }
      : type === 'header' ? { type, name: 'X-API-Key', value: '' }
        : type === 'query' ? { type, name: 'key', value: '' }
          : type === 'basic' ? { type, username: '', password: '' } : { type: 'none' };
    up({ auth: a });
  };
  const setBodyType = (type: ProviderBody['type']) => {
    if (!draft) return;
    const b: ProviderBody = type === 'json' ? { type, template: draft.kind === 'tts' ? '{\n  "text": "{{text}}"\n}' : '{\n  "audio": "{{audio_base64}}"\n}' }
      : type === 'raw' ? { type, template: draft.kind === 'tts' ? '{{text}}' : '' }
        : type === 'form' ? { type, fields: draft.kind === 'stt' ? [{ key: 'file', value: '{{audio}}' }] : [{ key: 'text', value: '{{text}}' }] }
          : type === 'urlencoded' ? { type, fields: [{ key: draft.kind === 'tts' ? 'text' : 'audio', value: draft.kind === 'tts' ? '{{text}}' : '{{audio_base64}}' }] }
            : type === 'binary' ? { type } : { type: 'none' };
    up({ body: b });
  };
  const setRespType = (type: ProviderResponse['type']) => {
    if (!draft) return;
    // Giữ định dạng audio đã chọn khi đổi kiểu.
    const mime = (draft.response as { mime?: string }).mime;
    const r: ProviderResponse = type === 'json' ? { type, path: 'text' } : type === 'text' ? { type }
      : type === 'base64' ? { type, path: 'audioContent', mime }
        : type === 'url' ? (draft.kind === 'stt' ? { type, path: 'data.url | url' } : { type, path: 'data.url | url', mime })
          : type === 'auto' ? { type, path: 'data.url | url | audioContent | audio', mime } : { type: 'audio', mime };
    up({ response: r });
  };
  /** Định dạng audio đang khai (rỗng = tự nhận). Giá trị lạ (bản cũ gõ tay) vẫn hiện để không mất. */
  const curMime = (draft?.response as { mime?: string } | undefined)?.mime ?? '';

  const secretType = showSecret ? 'text' : 'password';
  const valid = !!draft && draft.name.trim() !== '' && /^https?:\/\/\S+$/i.test(withScheme(draft.endpoint));

  return (
    <div className="mail-compose-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="mail-compose panel spm" role="dialog" aria-modal="true" aria-label="Nhà cung cấp STT và TTS">
        <div className="mail-compose-head">
          <b>⚙ Nhà cung cấp STT &amp; TTS</b>
          <span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={props.onClose} aria-label="Đóng">✕</button>
        </div>

        <div className="spm-body">
          {/* ── Danh sách ─────────────────────────────────────────────────── */}
          <aside className="spm-list" aria-label="Danh sách nhà cung cấp">
            {(['stt', 'tts'] as ProviderKind[]).map((kind) => (
              <div key={kind} className="spm-group">
                <div className="spm-group-head">
                  <span>{KIND_LABEL[kind]}</span>
                  <button className="ghost sm" onClick={() => startNew(kind)} title={`Thêm nhà cung cấp ${kind.toUpperCase()}`}>＋ Thêm</button>
                </div>
                <div className="spm-item fixed" title="Có sẵn, không cần cấu hình">
                  <span className="spm-item-name">{DEFAULT_PROVIDER_NAME[kind]}</span>
                  <span className="spm-item-sub">có sẵn</span>
                </div>
                {providers.list === null ? <div className="spm-skel" aria-label="Đang tải" />
                  : providers.of(kind).map((p) => (
                    <button key={p.id} className={`spm-item${draft?.id === p.id ? ' on' : ''}`} onClick={() => open(p)}>
                      <span className="spm-item-name">{p.name}</span>
                      <span className="spm-item-sub">{p.endpoint.replace(/^https?:\/\//, '').split(/[/?]/)[0]}</span>
                    </button>
                  ))}
                {providers.list !== null && providers.of(kind).length === 0 && (
                  <p className="spm-empty">Chưa có nhà cung cấp API nào.</p>
                )}
              </div>
            ))}
            {providers.error && <p className="spm-note err" role="alert">Không tải được danh sách: {providers.error}</p>}
          </aside>

          {/* ── Form cấu hình ─────────────────────────────────────────────── */}
          {!draft ? (
            <div className="spm-form spm-blank">
              <p className="spm-blank-title">Chọn một nhà cung cấp để sửa, hoặc bấm “＋ Thêm”</p>
              <p className="spm-blank-sub">
                Nhà cung cấp API được cấu hình động: bạn khai endpoint, authentication, headers, body và chỉ ra kết quả nằm ở đâu trong
                response. Biến như <code>{'{{text}}'}</code>, <code>{'{{audio}}'}</code>, <code>{'{{language}}'}</code> được thay bằng dữ liệu thật mỗi lần gọi.
              </p>
            </div>
          ) : (
            <div className="spm-form">
              <div className="spm-scroll">
                <div className="spm-row2">
                  <label className="spm-field">
                    <span>Tên nhà cung cấp <i className="spm-req" aria-hidden>*</i></span>
                    <input ref={nameRef} className="input" value={draft.name} maxLength={60} placeholder="Vd: FPT.AI, ElevenLabs, máy chủ nội bộ…"
                      onChange={(e) => up({ name: e.target.value })} />
                  </label>
                  <label className="spm-field spm-narrow">
                    <span>Loại</span>
                    <input className="input" value={KIND_LABEL[draft.kind]} readOnly disabled />
                  </label>
                </div>
                {!draft.id && (
                  <label className="spm-field">
                    <span>Điền theo mẫu <i className="spm-opt">không bắt buộc</i></span>
                    <select className="input" value="" onChange={(e) => {
                      const preset = PROVIDER_PRESETS.find((x) => x.id === e.target.value);
                      if (preset) open(preset.make());
                    }}>
                      <option value="">— Tự cấu hình từ đầu —</option>
                      {PROVIDER_PRESETS.filter((x) => x.make().kind === draft.kind).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    </select>
                  </label>
                )}

                <h4 className="spm-h">1 · Endpoint</h4>
                <div className="spm-row2">
                  <label className="spm-field spm-method">
                    <span>Method</span>
                    <select className="input" value={draft.method} onChange={(e) => up({ method: e.target.value as SpeechProvider['method'] })}>
                      <option>POST</option><option>PUT</option><option>GET</option>
                    </select>
                  </label>
                  <label className="spm-field">
                    <span>URL <i className="spm-req" aria-hidden>*</i></span>
                    <input className="input spm-mono" value={draft.endpoint} placeholder="https://api.example.com/v1/speech?lang={{language}}"
                      onChange={(e) => up({ endpoint: e.target.value })} />
                  </label>
                </div>

                <h4 className="spm-h">2 · Authentication</h4>
                <div className="spm-row2">
                  <label className="spm-field spm-narrow">
                    <span>Kiểu</span>
                    <select className="input" value={draft.auth.type} onChange={(e) => setAuthType(e.target.value as ProviderAuth['type'])}>
                      <option value="none">Không cần</option>
                      <option value="bearer">Bearer token</option>
                      <option value="header">API key trong header</option>
                      <option value="query">API key trên URL</option>
                      <option value="basic">Basic (user / mật khẩu)</option>
                    </select>
                  </label>
                  {draft.auth.type === 'bearer' && (
                    <label className="spm-field">
                      <span>Token <i className="spm-opt">gửi kèm “Authorization: Bearer …”</i></span>
                      <input className="input spm-mono" type={secretType} value={draft.auth.token} autoComplete="off"
                        onChange={(e) => up({ auth: { type: 'bearer', token: e.target.value } })} />
                    </label>
                  )}
                  {(draft.auth.type === 'header' || draft.auth.type === 'query') && (
                    <>
                      <label className="spm-field spm-narrow">
                        <span>{draft.auth.type === 'header' ? 'Tên header' : 'Tên tham số'}</span>
                        <input className="input spm-mono" value={draft.auth.name}
                          onChange={(e) => up({ auth: { ...(draft.auth as Extract<ProviderAuth, { type: 'header' | 'query' }>), name: e.target.value } })} />
                      </label>
                      <label className="spm-field">
                        <span>Giá trị (khoá API)</span>
                        <input className="input spm-mono" type={secretType} value={draft.auth.value} autoComplete="off"
                          onChange={(e) => up({ auth: { ...(draft.auth as Extract<ProviderAuth, { type: 'header' | 'query' }>), value: e.target.value } })} />
                      </label>
                    </>
                  )}
                  {draft.auth.type === 'basic' && (
                    <>
                      <label className="spm-field">
                        <span>User</span>
                        <input className="input spm-mono" value={draft.auth.username} autoComplete="off"
                          onChange={(e) => up({ auth: { ...(draft.auth as Extract<ProviderAuth, { type: 'basic' }>), username: e.target.value } })} />
                      </label>
                      <label className="spm-field">
                        <span>Mật khẩu</span>
                        <input className="input spm-mono" type={secretType} value={draft.auth.password} autoComplete="off"
                          onChange={(e) => up({ auth: { ...(draft.auth as Extract<ProviderAuth, { type: 'basic' }>), password: e.target.value } })} />
                      </label>
                    </>
                  )}
                </div>
                {draft.auth.type !== 'none' && (
                  <label className="spm-check">
                    <input type="checkbox" checked={showSecret} onChange={(e) => setShowSecret(e.target.checked)} /> Hiện khoá
                    <span className="spm-opt">· khoá lưu trong configs/speech-providers.json trên máy này</span>
                  </label>
                )}

                <h4 className="spm-h">3 · Headers <i className="spm-opt">ngoài header xác thực ở trên</i></h4>
                <KVEditor rows={draft.headers} onChange={(headers) => up({ headers })} label="Header"
                  keyPlaceholder="Tên header" valuePlaceholder="Giá trị (dùng được biến)" addLabel="Thêm header" />

                <h4 className="spm-h">4 · Biến tự đặt <i className="spm-opt">vd model, voice, speed — dùng trong URL / headers / body dưới dạng {'{{tên}}'}</i></h4>
                <KVEditor rows={draft.vars} onChange={(vars) => up({ vars })} label="Biến"
                  keyPlaceholder="Tên biến (vd voice)" valuePlaceholder="Giá trị" addLabel="Thêm biến" />

                <h4 className="spm-h">5 · Body <i className="spm-opt">đưa input vào</i></h4>
                <div className="spm-vars" aria-label="Biến có sẵn">
                  {PROVIDER_VARS[draft.kind].map((v) => (
                    <button key={v.name} className="spm-var" title={`${v.hint} — bấm để chép`}
                      onClick={() => { void navigator.clipboard.writeText(`{{${v.name}}}`).catch(() => {}); }}>
                      {`{{${v.name}}}`}
                    </button>
                  ))}
                  <span className="spm-opt">biến có sẵn — bấm để chép · trong JSON viết {'"{{text}}"'} hay {'{{text}}'} đều được · {'{{x|number}}'} ra số, {'{{x|bool}}'} ra true/false</span>
                </div>
                <label className="spm-field spm-narrow">
                  <span>Kiểu body</span>
                  <select className="input" value={draft.body.type} onChange={(e) => setBodyType(e.target.value as ProviderBody['type'])}>
                    <option value="json">JSON</option>
                    <option value="form">Form (multipart/form-data)</option>
                    <option value="urlencoded">Form (x-www-form-urlencoded)</option>
                    {draft.kind === 'stt' && <option value="binary">File âm thanh (WAV thô)</option>}
                    <option value="raw">Chuỗi thô (text / XML / SSML)</option>
                    <option value="none">Không có</option>
                  </select>
                </label>
                {(draft.body.type === 'json' || draft.body.type === 'raw') && (
                  <textarea className="spm-code" spellCheck={false} value={draft.body.template} aria-label="Nội dung body"
                    onChange={(e) => up({ body: { type: (draft.body as { type: 'json' | 'raw' }).type, template: e.target.value } })} />
                )}
                {(draft.body.type === 'form' || draft.body.type === 'urlencoded') && (
                  <>
                    <KVEditor rows={draft.body.fields} label="Trường body"
                      onChange={(fields) => up({ body: { type: (draft.body as { type: 'form' | 'urlencoded' }).type, fields } })}
                      keyPlaceholder="Tên trường" valuePlaceholder={draft.kind === 'stt' && draft.body.type === 'form' ? 'Giá trị — {{audio}} = file âm thanh' : 'Giá trị (dùng được biến)'}
                      addLabel="Thêm trường" />
                    <p className="spm-hint">Trường nào ra giá trị rỗng (vd <code>{'{{language}}'}</code> khi chọn “Tự nhận diện”) sẽ không được gửi.</p>
                  </>
                )}
                {draft.body.type === 'binary' && <p className="spm-hint">Body là chính file WAV 16 kHz mono; Content-Type mặc định <code>audio/wav</code> (đổi ở mục Headers nếu cần).</p>}

                <h4 className="spm-h">6 · Response <i className="spm-opt">đọc output ra</i></h4>
                <div className="spm-row2">
                  <label className="spm-field spm-narrow">
                    <span>Kết quả nằm ở</span>
                    <select className="input" value={draft.response.type} onChange={(e) => setRespType(e.target.value as ProviderResponse['type'])}>
                      {draft.kind === 'stt' ? (
                        <>
                          <option value="json">Một trường trong JSON</option>
                          <option value="url">URL file kết quả trong JSON</option>
                          <option value="text">Cả body là chữ</option>
                        </>
                      ) : (
                        <>
                          <option value="auto">URL hoặc base64 trong JSON (tự nhận)</option>
                          <option value="url">URL audio trong JSON</option>
                          <option value="base64">Audio base64 trong JSON</option>
                          <option value="audio">Body là file audio</option>
                        </>
                      )}
                    </select>
                  </label>
                  {'path' in draft.response && (
                    <label className="spm-field">
                      <span>Đường dẫn trong JSON <i className="spm-opt">nhiều phương án ngăn bằng |</i></span>
                      <input className="input spm-mono" value={draft.response.path}
                        placeholder={draft.kind === 'stt'
                          ? (draft.response.type === 'url' ? 'data.url | data.link | result_url' : 'text | data.text | results[0].alternatives[0].transcript')
                          : 'data.url | data.link | audioContent'}
                        onChange={(e) => up({ response: { ...(draft.response as Extract<ProviderResponse, { path: string }>), path: e.target.value } })} />
                    </label>
                  )}
                  {draft.kind === 'tts' && (
                    <label className="spm-field spm-narrow">
                      <span>Định dạng audio</span>
                      <select className="input" value={curMime}
                        onChange={(e) => up({ response: { ...draft.response, mime: e.target.value || undefined } as ProviderResponse })}>
                        <option value="">Tự nhận</option>
                        {AUDIO_FORMATS.map((f) => <option key={f.mime} value={f.mime}>{f.label} (.{f.ext})</option>)}
                        {curMime && !AUDIO_FORMATS.some((f) => f.mime === curMime) && <option value={curMime}>{curMime}</option>}
                      </select>
                    </label>
                  )}
                </div>
                {draft.kind === 'stt' && draft.response.type === 'url' && (
                  <label className="spm-field">
                    <span>Đường dẫn chữ trong file kết quả <i className="spm-opt">chỉ khi file là JSON — file .txt thì để trống</i></span>
                    <input className="input spm-mono" value={draft.response.textPath ?? ''} placeholder="text | transcript | segments[*].text"
                      onChange={(e) => up({ response: { ...(draft.response as Extract<ProviderResponse, { type: 'url' }>), textPath: e.target.value } })} />
                  </label>
                )}
                <p className="spm-hint">
                  Đường dẫn: <code>data.url</code>, <code>results[0].text</code>, <code>segments[*].text</code> (nối mọi phần tử),
                  {' '}<code>["khoá.có.chấm"]</code>. Khai nhiều phương án <code>data.url | data.link | url</code> — lấy cái đầu tiên có giá trị.
                  {draft.kind === 'tts' && ' Định dạng “Tự nhận”: theo đuôi file trong URL (.mp3, .wav…), rồi Content-Type, rồi nội dung file. Chọn định dạng chỉ là khai báo để phát / lưu đúng, không chuyển đổi.'}
                </p>
                <div className="spm-row2">
                  {draft.kind === 'tts' && (
                    <label className="spm-field spm-narrow">
                      <span>Ký tự mỗi lần gọi</span>
                      <input className="input" type="number" min={100} max={20000} value={draft.maxChars ?? 2000}
                        onChange={(e) => up({ maxChars: Number(e.target.value) })} />
                    </label>
                  )}
                  <label className="spm-field spm-narrow">
                    <span>Hạn chờ (giây)</span>
                    <input className="input" type="number" min={5} max={600} value={draft.timeoutSec ?? 60}
                      onChange={(e) => up({ timeoutSec: Number(e.target.value) })} />
                  </label>
                </div>
                {unknownVars.length > 0 && (
                  <p className="spm-note warn" role="status">
                    Biến chưa được định nghĩa: {unknownVars.map((v) => `{{${v}}}`).join(', ')} — sẽ thành chuỗi rỗng. Thêm ở mục “Biến tự đặt” hoặc sửa tên.
                  </p>
                )}

                {/* ── Thử ───────────────────────────────────────────────── */}
                <h4 className="spm-h">Thử <i className="spm-opt">gọi thật bằng cấu hình đang soạn — chưa cần lưu</i></h4>
                <div className="spm-test">
                  {draft.kind === 'tts' ? (
                    <input className="input" value={testText} aria-label="Câu để thử" onChange={(e) => setTestText(e.target.value)} />
                  ) : (
                    <span className="spm-hint" style={{ flex: 1 }}>Dùng file đang mở ở cột “Âm thanh → Chữ” (tối đa 45 giây đầu).</span>
                  )}
                  <input className="input spm-lang" value={testLang} aria-label="Mã ngôn ngữ khi thử" title="Giá trị của {{language}} khi thử"
                    onChange={(e) => setTestLang(e.target.value.trim())} />
                  <button className="ghost sm" onClick={() => void runTest()} disabled={testing || !valid}>
                    {testing ? <span className="spinner" aria-hidden /> : '▶'} Thử
                  </button>
                </div>
                {test && (
                  <div className={`spm-result ${test.ok ? 'ok' : 'err'}`} role="status">
                    <p className="spm-result-head">{test.ok ? '✓ Gọi được và đọc được kết quả' : `✕ ${test.error}`}</p>
                    {test.ok && test.text !== undefined && <p className="spm-result-text">“{test.text || '(rỗng)'}”</p>}
                    {test.ok && test.audio && (
                      <audio className="sp-audio" controls src={`data:${test.audio.mime};base64,${test.audio.chunks[0]}`} />
                    )}
                    {test.debug && (
                      <>
                        <p className="spm-debug-line">
                          {test.debug.method} {test.debug.url} → {test.debug.status ?? 'không có phản hồi'}
                          {test.debug.contentType ? ` · ${test.debug.contentType}` : ''} · {test.debug.bytes.toLocaleString('vi-VN')} byte · {test.debug.ms} ms
                        </p>
                        {(test.debug.picked || test.debug.fetched || test.debug.format) && (
                          <p className="spm-debug-line">
                            {test.debug.picked && <>Đọc ở <code>{test.debug.picked}</code></>}
                            {test.debug.fetched && <> · tải {test.debug.fetched}</>}
                            {test.debug.format && <> · định dạng {test.debug.format}</>}
                          </p>
                        )}
                        <pre className="spm-pre" aria-label="Phản hồi thô của API">{test.debug.body || '(body rỗng)'}</pre>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="spm-foot">
                {draft.id && (askDel
                  ? <button className="spm-del ask" autoFocus onBlur={() => setAskDel(false)} onClick={() => void remove()}>Xoá hẳn?</button>
                  : <button className="spm-del" onClick={() => setAskDel(true)}>Xoá</button>)}
                {err && <span className="spm-note err" role="alert">{err}</span>}
                {saved && !err && <span className="spm-note ok" role="status">Đã lưu.</span>}
                <span style={{ flex: 1 }} />
                <button className="ghost sm" onClick={props.onClose}>Đóng</button>
                <button className="aic-cta" onClick={() => void save()} disabled={!valid || saving}>
                  {saving ? <span className="spinner" aria-hidden /> : null} {draft.id ? 'Lưu thay đổi' : 'Lưu nhà cung cấp'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
