// Danh sách nhà cung cấp STT/TTS + nhà cung cấp đang CHỌN cho từng loại — dùng
// chung giữa công cụ Giọng nói (chọn + cấu hình) và khung chat trợ lý (dùng).
// Danh sách nằm ở server (configs/speech-providers.json); lựa chọn nằm ở
// localStorage của máy. Chọn một id không còn tồn tại → tự rơi về mặc định.

import { useEffect, useSyncExternalStore } from 'react';
import { providersList } from './speech';
import { DEFAULT_PROVIDER, type ProviderKind, type SpeechProvider } from './speechProviders';

interface State {
  /** null = chưa nạp. */
  list: SpeechProvider[] | null;
  selected: Record<ProviderKind, string>;
  error: string | null;
}

const KEY: Record<ProviderKind, string> = { stt: 'speech.sttProvider', tts: 'speech.ttsProvider' };
const SERVER: State = { list: null, selected: { stt: DEFAULT_PROVIDER, tts: DEFAULT_PROVIDER }, error: null };

let state: State = SERVER;
let booted = false;
let loading = false;
const listeners = new Set<() => void>();
const set = (next: State) => { state = next; listeners.forEach((fn) => fn()); };

function boot(): void {
  if (booted || typeof window === 'undefined') return;
  booted = true;
  try {
    state = {
      ...state,
      selected: {
        stt: window.localStorage.getItem(KEY.stt) || DEFAULT_PROVIDER,
        tts: window.localStorage.getItem(KEY.tts) || DEFAULT_PROVIDER,
      },
    };
  } catch { /* nicety */ }
}

export const speechProviders = {
  subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  getSnapshot(): State { return state; },
  getServerSnapshot(): State { return SERVER; },

  load(force = false): void {
    boot();
    if (loading || (state.list && !force)) return;
    loading = true;
    providersList()
      .then((list) => set({ ...state, list, error: null }))
      .catch((e) => set({ ...state, list: state.list ?? [], error: (e as Error).message }))
      .finally(() => { loading = false; });
  },

  /** Sau khi lưu / xoá: server trả danh sách mới. */
  setList(list: SpeechProvider[]): void { set({ ...state, list, error: null }); },

  select(kind: ProviderKind, id: string): void {
    boot();
    try { window.localStorage.setItem(KEY[kind], id); } catch { /* nicety */ }
    set({ ...state, selected: { ...state.selected, [kind]: id } });
  },
};

/** Nhà cung cấp API đang chọn cho `kind`; null = mặc định (hoặc cái đã chọn không còn). */
export function activeProvider(s: State, kind: ProviderKind): SpeechProvider | null {
  const id = s.selected[kind];
  if (!id || id === DEFAULT_PROVIDER) return null;
  return s.list?.find((p) => p.id === id && p.kind === kind) ?? null;
}

export function useSpeechProviders() {
  const s = useSyncExternalStore(speechProviders.subscribe, speechProviders.getSnapshot, speechProviders.getServerSnapshot);
  useEffect(() => { speechProviders.load(); }, []);
  return {
    list: s.list,
    error: s.error,
    stt: activeProvider(s, 'stt'),
    tts: activeProvider(s, 'tts'),
    of: (kind: ProviderKind) => (s.list ?? []).filter((p) => p.kind === kind),
  };
}
