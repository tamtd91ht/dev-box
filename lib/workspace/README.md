# Browser Workspace Framework

Embed **real web applications** — Zalo cá nhân, Grafana, Kibana, Jenkins, GitLab, an internal
admin — as first-class **workspaces** inside VHS DevBox. Each workspace is a genuine browser
context (an Electron `<webview>`, **not** an iframe, **not** reverse-engineered) with its **own
persistent login session** stored on your machine. Log in once (scan the QR for Zalo) and it
survives restarts.

Zalo and Telegram are simply the **first two plugins** — the framework itself knows nothing about
any specific site.

## Why it needs the desktop app

A cross-origin iframe cannot host apps like `chat.zalo.me`: the browser partitions 3rd-party
`SharedWorker` / `localStorage` / `IndexedDB`, so the app stalls at the splash screen. A real,
persistent, per-workspace browser profile is only possible in a desktop shell. DevBox therefore
runs as an Electron app for this tab; every other tab (Redis/Kafka/Mongo/…) is unchanged, and in a
plain browser the Workspace tab shows a short "run the desktop app" note instead of an error.

## Run it

One command — the Electron shell starts the Next.js dev server itself:

```bash
npm run desktop   # boots next dev if :3000 is free, then opens the window
```

The server is shut down when you close the app. If you prefer to run the dev
server yourself (e.g. to watch its logs in a dedicated terminal), start it first
and `npm run desktop` will detect and reuse it instead of starting a second one:

```bash
npm run dev       # terminal 1 — optional; the app reuses it if already running
npm run desktop   # terminal 2
```

Point at a remote/staging build instead by setting `DESKTOP_URL` — then no dev
server is started.

Login sessions live under `data/browser/` (gitignored). "Đăng xuất" (⎋) wipes a single
workspace's session; deleting `data/browser/` wipes them all.

## Add a workspace (no engine code)

A plugin is a pure declaration. Append to `lib/workspace/plugins.ts`:

```ts
{ id: 'grafana', name: 'Grafana', icon: '📊', url: 'https://grafana.internal/', badge: 'vpn' }
```

| Field         | Meaning                                                        |
| ------------- | ------------------------------------------------------------- |
| `id`           | Stable key + session-partition suffix (`persist:ws-<id>-<account>`). |
| `url`          | Home URL — the only place a workspace URL is hardcoded.       |
| `brand`        | `{ color, logo }` — accent + built-in vector mark (see below). |
| `permissions`  | Extra web APIs the site may request (default: none extra).   |
| `keepAlive`    | Keep the guest in memory when you switch away (e.g. Zalo).    |
| `multiAccount` | Allow several independent accounts of this app at once.      |
| `capture`      | Declarative knobs for the shared collector (unread + messages). |
| `userAgent`    | Optional User-Agent override.                                |

Allowed `permissions`: `notifications`, `media` (mic/cam for calls), `clipboard-read`,
`clipboard-sanitized-write`, `fullscreen`, `pointerLock`, `geolocation`. Anything not requested is
denied by the engine (screen capture, HID/serial/USB, MIDI are never granted).

## Brand identity — one rail, several apps

Zalo and Telegram share the rail but are **never** partitioned together: each account of each
plugin already has its own session (`persist:ws-{pluginId}-{instanceId}`), so no cookie, storage
or login is shared. What the UI has to solve is telling them apart *at a glance* — reading a label
is too slow when you have four accounts stacked.

So a plugin declares `brand: { color, logo }` and every surface uses it:

- `components/BrandMark.tsx` draws the real vector mark (`zalo` · `telegram` · `whatsapp`,
  emoji `icon` as fallback) — on the plugin row, on each account chip, in the toolbar.
- The accent colour tints the active row, the account avatar ring and the unread bubble, so an
  incoming Telegram message reads blue-cyan and Zalo reads blue-royal without any text.

A new app needs one entry with its colour + (optionally) one more `logo` case — no engine change.

## Multiple accounts

A plugin marked `multiAccount: true` (Zalo and Telegram both are) can hold several accounts at
once, each a fully independent browser session with its own persistent partition
(`persist:ws-{plugin}-<account>`) — so two Zalo accounts, or a Zalo and a Telegram, stay logged in
side by side. Add / rename / remove accounts from the rail; the list is
remembered per machine (`localStorage` under `data/browser/`). Removing an account also wipes its
on-disk session. Single-account plugins just have one implicit account.

## New-message alerts

Each workspace reports its unread count from the shared collector — the page title (`(N) Zalo`,
`(N) Telegram`), the Web Notification API and a DOM badge scan, in that order of trust. That
drives a red bubble on the account and — key point — a red **🔔 bell + count on the top-level 🧭
Workspace tab itself**, so a message arriving while you sit on the Git / Redis / Kafka / … tab is
impossible to miss. While the Workspace tab is *not* the active one, the bell **swings** and the whole
tab gives a periodic **shake + glow**; open the tab and it settles. It also updates the window /
taskbar title (`(N) VHS DevBox`) and rings a short chime when the total goes up. The 🔔/🔕 button in
the rail header mutes the chime (remembered); the visual bell/shake always shows.
Because visited workspaces stay mounted and background throttling is disabled, alerts keep working
while you are on another tab. Zalo's own OS notifications also fire (the `notifications` permission is
granted), giving a system toast + sound even when the window is in the background.

## Message capture → Automation

The same collector that counts unread can hand each message to the
[Automation engine](../automation/README.md) as a `social` event. It is **one generic script**
(`capture.ts`) that hooks the two universal signals every chat web app has — `new Notification()`
*and* `ServiceWorkerRegistration.showNotification()` (PWAs like Telegram/WhatsApp use the latter)
— plus a DOM badge scan. A plugin tunes it declaratively (`capture: { genericTitles,
bodySenderSeparator, extraScript, disableBadgeScan }`); it never forks the script.

Privacy is enforced **inside the guest**: message text is recorded only while the page-level flag
`window.__wsCap` is true, and the renderer sets that flag from the automation config's
`captureEnabled` switch — which is **OFF by default**. With capture off the guest counts unread
and stores nothing at all. `storeMessageText: false` additionally reduces what is kept to `••••`.

## Layout

```
lib/workspace/
  types.ts      shared types (plugin, brand, config, bridge, webview) + JSX/Window augmentation
  plugins.ts    the plugin registry (declarations only) — Zalo, Telegram, WhatsApp (commented)
  config.ts     defaults, isDesktop(), resolveConfig()
  accounts.ts   multi-account instances (per-account partition) + persistence
  capture.ts    the generic guest collector (unread + messages) + CaptureSpec
components/
  BrowserWorkspace.tsx   Workspace Manager — rail, accounts, LRU mount-and-keep, unread + chime
  WorkspaceView.tsx      one account — <webview> + toolbar + loading/failed/crashed + collector poll
  BrandMark.tsx          built-in vector marks (zalo · telegram · whatsapp), emoji fallback
electron/
  main.cjs      Browser Engine — window, webview hardening, permissions, downloads, logging, clearSession
  preload.cjs   contextBridge → window.workspace { isDesktop, version, config, clearSession }
```

The three layers — Browser Engine (`electron/`), Workspace Manager + UI (`components/`), and the
plugin declarations (`lib/workspace/plugins.ts`) — are independent. Nothing is hardcoded per site.

## Config

Runtime knobs default in `lib/workspace/config.ts` and may be overridden by
`data/browser/workspace.config.json` (read by the main process, handed to the renderer via
`window.workspace.config`):

| Key                  | Default | Meaning                                             |
| -------------------- | ------- | --------------------------------------------------- |
| `persistSession`     | `true`  | Persist cookies/storage to disk (login survives).   |
| `lazyLoad`           | `true`  | Only create a guest when its workspace is opened.   |
| `maxActiveWorkspace` | `3`     | Max alive guests; least-recently-used are evicted.  |
| `keepAlive`          | `true`  | Keep visited guests mounted (hidden) on switch.     |
| `allowDownload`      | `true`  | Allow file downloads from workspaces.               |
| `enableDevTools`     | `false` | Show a DevTools button on the workspace toolbar.    |

Per-plugin `keepAlive: true` pins a workspace in memory even past the LRU cap (Zalo keeps
receiving messages in the background).

## Non-goals

No per-site AI, no changing site behaviour, no replacement UIs, no automated sending. The framework
embeds sites as-is and manages their sessions; the only thing it reads out is the notification
stream the app already shows you, and only when you switch capture on. Acting on that stream is the
Automation engine's job — and even there, `reply` is a proposal for a human, never a silent send.
