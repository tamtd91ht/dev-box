'use client';

// The Automation tab.
//
//   ┌ safety strip — the switches that decide what the engine may touch
//   ├ Quy tắc          rules, grouped by feature (social · infra · system)
//   ├ Theo dõi hạ tầng watches that turn a metric into an event
//   ├ Hoạt động        what the engine did, with skip reasons
//   ├ Log & báo cáo    where history is kept, and what you can ask of it
//   └ Thử              hand-written events, dry or live
//
// Edits live in a local draft until saved: the engine keeps running the last
// saved config, so a half-finished rule never fires.

import { useEffect, useState } from 'react';
import { useAutomation } from '@/lib/automation/useAutomation';
import { automation } from '@/lib/automation/runtime';
import type { AutomationConfig } from '@/lib/automation/types';
import { GROUPS } from '@/lib/automation/catalog';
import ActivityPanel from './ActivityPanel';
import CapturePanel from './CapturePanel';
import LogPanel from './LogPanel';
import RulesPanel from './RulesPanel';
import TestPanel from './TestPanel';
import WatchesPanel from './WatchesPanel';
import { Toggle } from './parts';

type Tab = 'rules' | 'watches' | 'activity' | 'logs' | 'capture' | 'test';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'rules', label: 'Quy tắc', icon: '⚙' },
  { key: 'watches', label: 'Theo dõi hạ tầng', icon: '📡' },
  { key: 'activity', label: 'Hoạt động', icon: '🕓' },
  { key: 'logs', label: 'Log & báo cáo', icon: '🗄' },
  { key: 'capture', label: 'Thu tin', icon: '🔬' },
  { key: 'test', label: 'Thử', icon: '🧪' },
];

export default function AutomationWorkspace() {
  const snap = useAutomation();
  const [tab, setTab] = useState<Tab>('rules');
  const [draft, setDraft] = useState<AutomationConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const cfg = draft ?? snap.config;
  const dirty = draft !== null;

  // Nạp lại config từ đĩa mỗi lần MỞ tab — cửa sổ/thiết bị khác vừa sửa thì
  // thấy ngay, thay vì bản cũ session này load một lần lúc khởi động (nguồn
  // gốc của lost-update). Không đè lên draft đang sửa dở.
  useEffect(() => {
    if (!dirty) void automation.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a draft exists it WINS over the store: a config saved from elsewhere
  // must never overwrite the user's unsaved edits under their hands.
  const edit = (next: AutomationConfig) => setDraft(next);

  /** Safety switches apply at once when clean; otherwise they join the draft. */
  const flip = (patch: Partial<AutomationConfig>) => {
    if (dirty) setDraft({ ...cfg, ...patch });
    else void automation.patch(patch);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setConflict(false);
    // onConflict: đĩa đã đổi từ lúc mở tab → save() đã tự merge (rule người
    // khác thêm không bị mất, thay đổi của mình vẫn được ghi). Chỉ báo để biết.
    await automation.save(draft, () => setConflict(true));
    setDraft(null);
    setSaving(false);
  };

  return (
    <div className="panel auto-root">
      <div className="auto-top">
        <div className="auto-switches">
          <Toggle
            checked={cfg.enabled}
            onChange={(v) => flip({ enabled: v })}
            label="Engine"
            hint="tắt = không quy tắc nào chạy"
          />
          <Toggle
            checked={cfg.captureEnabled}
            onChange={(v) => flip({ captureEnabled: v })}
            label="Đọc tin nhắn"
            hint="social: bật mới lấy được nội dung tin"
            tone="risk"
          />
          <Toggle
            checked={cfg.storeMessageText}
            onChange={(v) => flip({ storeMessageText: v })}
            label="Lưu nội dung"
            hint="tắt = nhật ký chỉ giữ ••••"
            disabled={!cfg.captureEnabled}
          />
          <Toggle
            checked={cfg.watchEnabled}
            onChange={(v) => flip({ watchEnabled: v })}
            label="Theo dõi hạ tầng"
            hint="chạy các poller đo chỉ số"
          />
          <Toggle
            checked={cfg.allowSend}
            onChange={(v) => flip({ allowSend: v })}
            label="Cho phép gửi"
            // Từ khi có `wsSend`, công tắc này mở khoá việc gửi THẬT bằng tài
            // khoản cá nhân — không còn "vẫn phải duyệt tay" như hồi chỉ có
            // `reply`. Chú thích phải nói đúng thứ nó mở ra.
            hint="mở khoá 💬 Gửi Zalo (gửi thật, tự động) và ↩ trả lời (vẫn chờ duyệt)"
            tone="risk"
          />
          <Toggle
            checked={cfg.loopGuard}
            onChange={(v) => flip({ loopGuard: v })}
            label="Chặn vòng lặp"
            hint="bỏ qua tin do chính automation vừa gửi — tắt là có thể tự bắn vòng tròn"
          />
        </div>

        {/* Thông báo hệ điều hành: TẮT hết theo mặc định. Mỗi lần bắn là một cửa
            sổ Electron riêng, nằm ngoài app và sống lâu hơn app — lúc dính vòng
            lặp thì nó phủ kín màn hình. Bật lại theo từng nhóm nếu thật sự cần
            biết khi không nhìn vào DevBox. */}
        <div className="auto-osnoti">
          <span className="auto-hint">Thông báo hệ điều hành:</span>
          {GROUPS.map((g) => {
            const on = cfg.osNotify.includes(g.id);
            return (
              <button
                key={g.id}
                type="button"
                className={`auto-chip${on ? ' on' : ''}`}
                title={on ? `${g.label}: có bật cửa sổ thông báo ngoài app` : `${g.label}: chỉ hiện toast trong app`}
                onClick={() =>
                  flip({
                    osNotify: on
                      ? cfg.osNotify.filter((x) => x !== g.id)
                      : [...cfg.osNotify, g.id],
                  })
                }
              >
                {g.icon} {g.label}
              </button>
            );
          })}
          {!cfg.osNotify.length && <span className="auto-hint">đang tắt hết — chỉ toast trong app</span>}
        </div>

        <div className="auto-top-right">
          {conflict ? (
            <span className="auto-dirty" style={{ color: 'var(--warn)' }} title="Cấu hình trên đĩa đã thay đổi từ lúc mở tab — thay đổi của bạn đã được gộp lên bản mới nhất, không đè mất phần người khác sửa.">
              ⚠ đã gộp với thay đổi bên ngoài
            </span>
          ) : null}
          {dirty ? <span className="auto-dirty">có thay đổi chưa lưu</span> : null}
          <button type="button" className="ghost sm" disabled={!dirty} onClick={() => setDraft(null)}>
            Hoàn tác
          </button>
          <button type="button" className="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        </div>
      </div>

      <div className="gitsub auto-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
            <span aria-hidden>{t.icon}</span> {t.label}
            {t.key === 'rules' ? <span className="auto-count">{cfg.rules.length}</span> : null}
            {t.key === 'watches' ? <span className="auto-count">{cfg.watches.length}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'rules' ? <RulesPanel config={cfg} onChange={edit} /> : null}
      {tab === 'watches' ? <WatchesPanel config={cfg} onChange={edit} /> : null}
      {tab === 'activity' ? <ActivityPanel activity={snap.activity} /> : null}
      {tab === 'logs' ? <LogPanel config={cfg} onChange={edit} /> : null}
      {tab === 'capture' ? <CapturePanel /> : null}
      {tab === 'test' ? <TestPanel /> : null}
    </div>
  );
}
