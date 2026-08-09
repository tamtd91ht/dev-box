// DevBox Automation — the SOCIAL source.
//
// Turns one raw capture from a messaging guest (Zalo, Telegram, WhatsApp…) into
// the normalized AutomationEvent every rule sees. The app-specific part stopped
// at the guest collector: from here on a Telegram message and a Zalo message
// are the same object, distinguished only by `sourceId`.

import type { CollectResult } from '@/lib/workspace/capture';
import type { WorkspaceAccount } from '@/lib/workspace/accounts';
import type { WorkspacePlugin } from '@/lib/workspace/types';
import type { AutomationEvent } from '../types';

type Captured = CollectResult['m'][number];

/** Short stable hash — same message captured twice yields the same event id. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function socialEvent(
  plugin: WorkspacePlugin,
  account: WorkspaceAccount,
  m: Captured,
): AutomationEvent {
  const sender = (m.s || '').trim();
  const conversation = (m.c || '').trim();
  const text = m.x || '';
  const ts = Number.isFinite(m.t) ? m.t : Date.now();

  // Group or 1-1, derived rather than guessed by the UI.
  //
  // The collector splits a group notification ("OMITeam" / "Alice: hi") into
  // conversation=OMITeam, sender=Alice; a 1-1 has no sender prefix, so both
  // come out as the same person. Different names therefore mean a third party
  // spoke — which only happens in a group. This is what makes {{sender}}
  // meaningful: in a 1-1 it merely repeats the conversation name.
  const chatType: 'group' | 'user' = conversation && sender && conversation !== sender ? 'group' : 'user';

  return {
    // Timestamp + content hash: a re-delivered batch after a guest reload maps
    // to the same id, and the engine drops it.
    id: `${plugin.id}:${account.instanceId}:${ts}:${hash(sender + '|' + conversation + '|' + text)}`,
    ts,
    category: 'social',
    type: 'message.received',
    sourceId: plugin.id,
    instanceId: account.instanceId,
    instanceLabel: account.label,
    // Headline reads like the chat list does: a group shows the group, a 1-1
    // shows the person.
    title: (chatType === 'group' ? conversation : sender) || conversation || sender || plugin.name,
    text,
    fields: {
      sender,
      conversation,
      /** 'group' | 'user' — lets a rule ask for group messages only. */
      chatType,
      app: plugin.name,
      /** 'notification' (an app toast) or 'dom' (a plugin's extraScript). */
      capture: m.k || 'notification',
    },
  };
}
