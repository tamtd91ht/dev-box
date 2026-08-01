'use client';

// Browser Workspace Framework — the app mark.
//
// One tiny component renders "which app is this?" everywhere an account shows
// up: the rail group header, every account row, the view toolbar, the
// automation scope pickers and the activity feed. Two apps must be
// distinguishable WITHOUT reading text, so the marks differ in silhouette as
// well as colour — Zalo is a rounded square, Telegram a circle, WhatsApp a
// circle with a handset. That still reads on a greyscale monitor.
//
// Everything is inline SVG: no network request, no icon font, crisp at 14px.

import type { WorkspacePlugin } from '@/lib/workspace/types';

interface Props {
  plugin: Pick<WorkspacePlugin, 'icon' | 'name' | 'brand'>;
  /** Edge length in px. 14–16 for rows, 20–22 for headers. */
  size?: number;
  className?: string;
  /** Dim it (e.g. a background account). */
  faded?: boolean;
}

export default function BrandMark({ plugin, size = 18, className = '', faded = false }: Props) {
  const color = plugin.brand?.color ?? '#64748b';
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    className: `brand-mark${faded ? ' is-faded' : ''}${className ? ' ' + className : ''}`,
    role: 'img' as const,
    'aria-label': plugin.name,
  };

  switch (plugin.brand?.logo) {
    case 'zalo':
      // Rounded square + a solid "Z" drawn as a path (no font dependency).
      return (
        <svg {...common}>
          <rect x="1" y="1" width="22" height="22" rx="6.5" fill={color} />
          <path d="M7.2 6.4h9.6v2.3l-6 6.6h6.2v2.3H7v-2.3l6-6.6H7.2z" fill="#fff" />
        </svg>
      );
    case 'telegram':
      // Circle + the paper plane, fold included.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="11" fill={color} />
          <path d="M18.6 6.4 4.9 11.9l3.4 1.1 1.3 4.2 2-2.2 3.3 2.6z" fill="#fff" />
          <path d="M8.3 13 18.6 6.4l-8.9 8.8-.1 2z" fill="#d7ecf9" />
        </svg>
      );
    case 'whatsapp':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="11" fill={color} />
          <path
            d="M9.1 7.3c.3 0 .5.1.6.4l.7 1.7c.1.3.1.5-.1.7l-.6.7c-.1.2-.2.4 0 .6a7.5 7.5 0 0 0 3 2.9c.2.1.4.1.6-.1l.7-.7c.2-.2.4-.2.6-.1l1.7.8c.3.1.4.4.3.7-.3 1-1.2 1.6-2.2 1.5-3.4-.3-6.4-3.3-6.7-6.7-.1-1 .5-1.9 1.4-2.2z"
            fill="#fff"
          />
        </svg>
      );
    default:
      // No vector mark declared → the emoji on a tinted chip, same footprint.
      return (
        <span
          className={`brand-mark brand-mark--emoji${faded ? ' is-faded' : ''}${className ? ' ' + className : ''}`}
          style={{ width: size, height: size, fontSize: size * 0.62, background: `${color}22`, color }}
          title={plugin.name}
        >
          {plugin.icon}
        </span>
      );
  }
}
