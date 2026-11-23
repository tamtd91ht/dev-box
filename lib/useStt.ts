// Hook dùng chung cho nút micro (khung chat trợ lý) và công cụ Giọng nói (tab
// Tools): ghi âm → giải mã → gửi Whisper trên máy → chữ. Xem lib/speech.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  STT_DEFAULT_MODEL, STT_LANGS, STT_MODELS, decodeToPcm16k, startRecording, sttStatusText, transcribe,
  type Recording, type SttPoll,
} from './speech';

const LANG_KEY = 'speech.sttLang';
const MODEL_KEY = 'speech.sttModel';

export type SttPhase = 'idle' | 'recording' | 'working';

export interface SttState {
  phase: SttPhase;
  /** Số giây đã ghi âm. */
  recSeconds: number;
  /** Dòng trạng thái lúc đang xử lý ("Đang nhận dạng… 40%"). */
  status: string;
  /** 0..1 trong lúc nhận dạng; null khi chưa biết (đang nạp model…). */
  progress: number | null;
  /** Chữ nhận dạng được tới lúc này (cập nhật dần). */
  partial: string;
  error: string | null;
}

const IDLE: SttState = { phase: 'idle', recSeconds: 0, status: '', progress: null, partial: '', error: null };

/** Ngôn ngữ + model STT người dùng chọn — nhớ chung cho mọi nơi dùng STT. */
export function useSttPrefs() {
  const [language, setLanguageState] = useState(STT_LANGS[0].id);
  const [model, setModelState] = useState(STT_DEFAULT_MODEL);
  useEffect(() => {
    try {
      const l = window.localStorage.getItem(LANG_KEY);
      if (l && STT_LANGS.some((x) => x.id === l)) setLanguageState(l);
      const m = window.localStorage.getItem(MODEL_KEY);
      if (m && STT_MODELS.some((x) => x.id === m)) setModelState(m);
    } catch { /* nicety */ }
  }, []);
  const setLanguage = useCallback((v: string) => {
    if (!STT_LANGS.some((x) => x.id === v)) return;
    setLanguageState(v);
    try { window.localStorage.setItem(LANG_KEY, v); } catch { /* nicety */ }
  }, []);
  const setModel = useCallback((v: string) => {
    if (!STT_MODELS.some((x) => x.id === v)) return;
    setModelState(v);
    try { window.localStorage.setItem(MODEL_KEY, v); } catch { /* nicety */ }
  }, []);
  return { language, model, setLanguage, setModel };
}

export function useStt() {
  const [state, setState] = useState<SttState>(IDLE);
  const recRef = useRef<Recording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  // Rời màn hình giữa chừng: tắt micro, dừng job đang chạy.
  useEffect(() => () => {
    clearTimer();
    recRef.current?.cancel();
    abortRef.current?.abort();
  }, []);

  /** Âm thanh (file hoặc bản ghi) → chữ. Trả null nếu lỗi / bị dừng (lỗi nằm ở state.error). */
  const transcribeBlob = useCallback(async (blob: Blob, opts: { model: string; language: string }): Promise<SttPoll | null> => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ ...IDLE, phase: 'working', status: 'Đang đọc âm thanh…' });
    try {
      const pcm = await decodeToPcm16k(blob);
      if (ac.signal.aborted) throw new Error('Đã dừng.');
      const done = await transcribe(pcm, {
        ...opts,
        signal: ac.signal,
        onUpdate: (p) => setState((s) => (s.phase !== 'working' ? s : {
          ...s,
          status: sttStatusText(p),
          progress: (p.status === 'running' || p.status === 'uploading') && p.progress > 0 ? p.progress : null,
          partial: p.text,
        })),
      });
      setState({ ...IDLE, partial: done.text, status: sttStatusText(done) });
      return done;
    } catch (e) {
      const msg = (e as Error).message;
      setState((s) => ({ ...IDLE, partial: s.partial, error: msg === 'Đã dừng.' ? null : msg, status: msg === 'Đã dừng.' ? msg : '' }));
      return null;
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, []);

  const startRec = useCallback(async () => {
    if (recRef.current) return;
    setState({ ...IDLE, phase: 'recording' });
    try {
      recRef.current = await startRecording();
      const t0 = Date.now();
      clearTimer();
      timerRef.current = setInterval(() => {
        setState((s) => (s.phase === 'recording' ? { ...s, recSeconds: Math.floor((Date.now() - t0) / 1000) } : s));
      }, 250);
    } catch (e) {
      recRef.current = null;
      setState({ ...IDLE, error: (e as Error).message });
    }
  }, []);

  /** Dừng ghi và lấy bản ghi (null nếu không đang ghi). */
  const stopRec = useCallback(async (): Promise<Blob | null> => {
    const rec = recRef.current;
    if (!rec) return null;
    recRef.current = null;
    clearTimer();
    return rec.stop();
  }, []);

  /** Bỏ bản ghi đang thu / dừng lượt nhận dạng đang chạy. */
  const cancel = useCallback(() => {
    clearTimer();
    if (recRef.current) { recRef.current.cancel(); recRef.current = null; setState(IDLE); return; }
    abortRef.current?.abort();
  }, []);

  const clearError = useCallback(() => setState((s) => (s.error ? { ...s, error: null } : s)), []);

  return { state, startRec, stopRec, transcribeBlob, cancel, clearError };
}
