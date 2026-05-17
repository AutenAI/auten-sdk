<p align="center">
  <a href="https://auten.ai">
    <img src="https://auten.ai/logos/logo-512.png" alt="Auten" width="120" height="120" />
  </a>
</p>

<h1 align="center">@autenai/sdk</h1>

<p align="center">
  Programmatic control of Android phones via the Auten relay — send tasks in
  plain English, query device state, manage encrypted credentials, watch live
  screens. SDK + CLI in one package.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@autenai/sdk"><img src="https://img.shields.io/npm/v/@autenai/sdk?color=2ea44f&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@autenai/sdk"><img src="https://img.shields.io/npm/dm/@autenai/sdk?color=2ea44f" alt="npm downloads" /></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D18.17-brightgreen" alt="Node 18.17+" />
</p>

```bash
npm install @autenai/sdk
```

```ts
import { Auten } from "@autenai/sdk";

const auten = new Auten({ apiKey: process.env.AUTEN_API_KEY! });

const phone = await auten.devices.firstOnline();
const result = await auten.tasks.run({
  device: phone!.serial,
  prompt: "Open Calculator and compute 999 ÷ 3",
  speed: "lightning",
});
console.log(result.verified, result.result?.summary);
// → true, "Calculator displays 333."
```

---

## Table of contents

- [Concepts](#concepts)
- [Setup](#setup)
- [Quickstart](#quickstart)
- [SDK reference](#sdk-reference)
  - [`new Auten(config)`](#new-autenconfig)
  - [`auten.me()`](#autenme)
  - [`auten.devices`](#autendevices)
  - [`auten.tasks`](#autentasks)
  - [`auten.keys`](#autenkeys)
  - [`auten.phone(serial)`](#autenphoneserial)
- [CLI reference](#cli-reference)
- [REST API reference](#rest-api-reference)
- [Recipes](#recipes)
- [Errors](#errors)
- [Pitfalls](#pitfalls)
- [For AI agents](#for-ai-agents)
- [Versioning](#versioning)

---

## Concepts

| Term | Meaning |
|---|---|
| **Relay** | Server (`https://relay.auten.ai` by default) that sits between your code and the phones. Phones connect outbound (so they work behind NAT). |
| **Owner** | The principal an API key belongs to. All resources (devices, tasks, sessions, credentials) are filtered by `ownerId` server-side — your key only sees your stuff. |
| **Device** | A physical Android phone running the Auten APK. Registered to one owner. |
| **Task** | A natural-language goal dispatched to a phone ("open Chrome and search for X"). The agent on the relay decomposes it into per-tap actions. |
| **Plan** | Cleaned-up action sequence extracted from a verified-successful task. Future tasks with similar prompts replay the plan deterministically (cheap + fast) before invoking the LLM. |
| **Screen graph** | Per-device DAG of `(fromFP, action, toFP)` edges learned from every successful tap. Powers cached replay on familiar screens. |
| **Speed preset** | One knob (`fast` / `instant` / `lightning`) that drives every artificial delay during replay. See [speed table](#speed-presets). |

Tasks resolve in this order, cheapest first:

1. **Synthesize** from the per-screen Step KB if every required label was observed before. No LLM call.
2. **Replay** a similar past task's `cleanPlanJson`. Deterministic, label-based; auto-scrolls to find off-screen targets.
3. **Delegate** to Claude Opus 4.7 via the engine loop — only when the first two miss.

You don't pick which path runs; the relay does. Your code just calls `auten.tasks.create` or `.run` and gets a result.

---

## Setup

### 1. Get a key

Sign up at <https://auten.ai> and mint a key from **Settings → API Keys**. Keys look like `sk_live_<48 hex>`.

### 2. Save it

```bash
$ npx @autenai/sdk login
Relay base URL [https://relay.auten.ai]:
API key: ********************************
  ✓ Authenticated as my-team — 1 device(s), 0 task(s).
  ✓ Saved to ~/.autenrc
```

The CLI also reads `AUTEN_API_KEY` and `AUTEN_BASE_URL` from the environment, so CI doesn't need an `.autenrc`.

### 3. Pair a phone

```bash
auten add-phone   # USB-tethered Samsung-style wizard
```

Or have the operator pre-pair phones for you and share the serials.

---

## Quickstart

### Run a task and wait

```ts
import { Auten } from "@autenai/sdk";

const auten = new Auten({ apiKey: process.env.AUTEN_API_KEY! });

const result = await auten.tasks.run({
  device: "a4e0eff201d020fd",
  prompt: "Open Instagram and like the latest 5 posts on the feed",
  speed: "fast",
  timeout_seconds: 300,
});

if (result.verified) {
  console.log("Done:", result.result?.summary);
} else {
  console.warn("Verifier flagged failure:", result.result?.verify_reason);
}
```

### Fire-and-forget + poll later

```ts
const { task_id, watch_url } = await auten.tasks.create({
  device,
  prompt: "Translate the article on news.tv3.lt and save the title to clipboard",
});

// browser-renderable live view
console.log(`Watch: ${auten.baseUrl}${watch_url}`);

// later:
const final = await auten.tasks.wait(task_id, { timeoutMs: 10 * 60_000 });
```

### Direct phone control

```ts
const phone = auten.phone(device);

const screen = await phone.look();           // SoM screenshot + element list
const submit = screen.elements.find(e => /sign in/i.test(e.text ?? ""));
if (submit) await phone.tap(submit.x, submit.y);

await phone.openUrl("https://news.tv3.lt");
await phone.type("hello", { x: 540, y: 800 }); // accessibility ACTION_SET_TEXT, no keyboard
await phone.key("back");
```

---

## SDK reference

### `new Auten(config)`

```ts
type AutenConfig = {
  apiKey: string;       // required
  baseUrl?: string;     // default: https://relay.auten.ai
  timeoutMs?: number;   // per-request, default 60_000
};
```

Construct one client per process. The `Transport` underneath uses `fetch` (Node 18.17+ has it built in). Bearer auth is applied to every request.

`auten.baseUrl` getter returns the resolved base URL.

### `auten.me()`

```ts
auten.me(): Promise<{
  owner_id: string;
  key_id: string;
  is_root: boolean;       // env-key admin (sees all owners)
  device_count: number;   // owner's devices
  task_count: number;     // owner's tasks ever
}>
```

Identity probe. Use after login to verify the key is valid and to log who's running.

### `auten.devices`

```ts
auten.devices.list(): Promise<Device[]>
auten.devices.get(serial: string): Promise<Device | null>
auten.devices.firstOnline(): Promise<Device | null>
auten.devices.stats(serial: string): Promise<{
  serial: string;
  online: boolean;
  graph_edges: number;
  task_count: number;
  cache_hit_rate: number;   // 0..1, fraction of past turns served from graph cache
}>
```

```ts
type Device = {
  serial: string;
  model: string | null;
  online: boolean;
  type: string;                  // "physical" | "emulator"
  lastSeenAt: string | null;     // ISO timestamp
  androidVersion: string | null;
  screenW: number | null;
  screenH: number | null;
};
```

`online` flips when the phone disconnects from the relay's WS reverse tunnel. Pollable; the relay updates it within a few seconds of disconnect.

### `auten.tasks`

```ts
type Speed = "fast" | "instant" | "lightning";
type TaskMode = "task" | "explore";
type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

auten.tasks.create(input: {
  device: string;
  prompt: string;
  mode?: TaskMode;
  speed?: Speed;
  webhook_url?: string;
  webhook_secret?: string;       // HMAC-SHA256 signing for webhook deliveries
  timeout_seconds?: number;      // default 300; 0 = no limit (explore mode)
}): Promise<{ task_id: string; status: string; watch_url: string }>

auten.tasks.get(id: string): Promise<Task>
auten.tasks.list(opts?: {
  device?: string;
  status?: TaskStatus;
  limit?: number;                // 1..100, default 25
}): Promise<Task[]>
auten.tasks.cancel(id: string): Promise<{ task_id: string; status: string }>

// Poll until terminal state. Returns the final Task.
auten.tasks.wait(id: string, opts?: {
  intervalMs?: number;           // default 1000
  timeoutMs?: number;            // default 300_000
}): Promise<Task>

// Sugar: create + wait. Same options as create + wait.
auten.tasks.run(input: CreateTaskInput, waitOpts?: WaitOpts): Promise<Task>
```

```ts
type Task = {
  task_id: string;
  device_serial: string;
  prompt: string;
  status: TaskStatus;
  mode: TaskMode;
  verified?: boolean | null;
  result?: {
    summary?: string;
    cost_usd?: number;
    duration_ms?: number;
    verify_reason?: string;      // verifier's explanation when verified=false
  } | null;
  error?: { code?: string; message?: string; retryable?: boolean } | null;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  turns?: TaskTurn[];            // present in get(), not list()
  artifacts?: TaskArtifact[];    // screenshots, recordings, files saved during run
};

type TaskTurn = {
  index: number;
  source: string;                // "cached" | "decide" | "delegate" | "replay"
  label: string | null;
  ok: boolean;
  cost_usd: number;
  duration_ms: number | null;
};
```

#### Speed presets

| Preset | settle | postAction | look-after-each | Use when |
|---|---|---|---|---|
| `fast` | 120ms | 180ms | yes | First runs of unfamiliar tasks; debugging. |
| `instant` (default) | 50ms | 100ms | yes | Familiar flows. Most tasks. |
| `lightning` | 10ms | 30ms | **no** | Production replay of plans you trust. Skips per-step look — fastest, less verifiable mid-flight. |

`lightning` is the "this plan worked yesterday, just run it" knob. Don't use it for the first run of anything novel.

### `auten.keys`

```ts
auten.keys.list(): Promise<ApiKey[]>           // never reveals full secrets
auten.keys.create(input?: {
  name?: string;
  ownerId?: string;                            // root-only override
}): Promise<ApiKeyWithSecret>                  // .key contains the full secret — printed once
auten.keys.revoke(id: string): Promise<{ ok: boolean; id: string }>
```

Self-service rotation: mint a new key, deploy it, revoke the old one. Cache invalidates within 30s server-side.

### `auten.phone(serial)`

Returns a `Phone` handle. All methods route through the relay's owner-scoped phone-proxy endpoint, which forwards via the WS reverse tunnel to the APK. The phone doesn't need to be reachable from your IP — only from the relay.

#### Vision

```ts
phone.look(): Promise<LookResult>              // SoM annotated screenshot + element list (accessibility tree)
phone.screenshot(): Promise<{ jpeg: string; width: number; height: number; durationMs: number }>
                                               // raw pixels, no SoM, ~280ms faster than look()
```

```ts
type LookResult = {
  annotated: string;                           // base64 JPEG with numbered markers
  elements: SomElement[];
  width: number;
  height: number;
};

type SomElement = {
  id: number;                                  // SoM marker number, matches the image overlay
  x: number; y: number; w: number; h: number;  // pixel coords (center)
  text?: string;
  desc?: string;                               // content-description (accessibility label)
  cls?: string;                                // class name (e.g. "android.widget.Button")
  res?: string;                                // resource id (e.g. "com.app:id/submit_button")
  clickable?: boolean;
  editable?: boolean;
  scrollable?: boolean;
  via_ocr?: boolean;                           // synthesized from on-device OCR (Compose / Flutter / canvas UIs)
};
```

#### Input

```ts
phone.tap(x: number, y: number): Promise<{ ok: boolean }>
phone.longPress(x: number, y: number, durationMs?: number): Promise<{ ok: boolean }>
phone.swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<{ ok: boolean }>

// `target` of an editable element bypasses the soft keyboard via accessibility
// ACTION_SET_TEXT — instant, no layout shift. Without target, routes through IME.
phone.type(text: string, target?: { x: number; y: number }): Promise<{ ok: boolean }>

phone.key(name: KeyName): Promise<{ ok: boolean }>
// KeyName: "back" | "home" | "recents" | "enter" | "delete" | "tab" | "menu"
//        | "search" | "volume_up" | "volume_down" | "power"
```

#### Apps

```ts
phone.launch(packageName: string): Promise<{ ok: boolean }>     // force-stops then launches
phone.stop(packageName: string): Promise<{ ok: boolean }>
phone.openUrl(url: string, pkg?: string): Promise<{ ok: boolean; url: string; package?: string }>
                                                                // ACTION_VIEW intent
```

#### Other

```ts
phone.status(): Promise<unknown>                   // APK health: { ok, service, version, accessibility }
phone.info(): Promise<unknown>
phone.reset(): Promise<{ ok: boolean; killedCount: number }>    // kill all 3rd-party + key:home
phone.notifications(): Promise<unknown[]>
phone.clearNotifications(): Promise<{ ok: boolean }>
```

#### Clipboard *(varies by APK build — see [Pitfalls](#pitfalls))*

```ts
phone.clipboardSet(text: string): Promise<{ ok: boolean }>
phone.clipboardGet(): Promise<{ ok: boolean; text: string }>
phone.pasteClipboard(target?: { x: number; y: number }): Promise<{ ok: boolean }>
                                               // ACTION_PASTE on focused or coord-targeted editable
```

#### Task sugar

```ts
phone.task(prompt: string, opts?: {
  speed?: Speed;
  mode?: TaskMode;
  timeout_seconds?: number;
  webhook_url?: string;
  webhook_secret?: string;
}): Promise<{ task_id: string; status: string; watch_url: string }>
```

Equivalent to `auten.tasks.create({ device: this.serial, prompt, ...opts })`.

#### Credentials

Encrypted server-side with AES; only ever decrypted into the agent's runtime when it actually needs to fill a form. Per-device.

```ts
phone.credentials.save(input: {
  service: string;
  username?: string;
  password?: string;
  totp_secret?: string;
  notes?: string;
  [k: string]: unknown;                                // any extra fields are encrypted with the rest
}): Promise<{ ok: boolean; service: string }>

phone.credentials.list(): Promise<Credential[]>                                // each row carries `id` (UUID) + `deviceSerial`
phone.credentials.reveal<T>(service: string): Promise<T>                       // full payload, decrypted
phone.credentials.delete(service: string): Promise<{ ok: boolean }>            // by service name
phone.credentials.deleteById(id: string): Promise<{ ok: boolean; id: string }> // by UUID

// Cross-device variants on the top-level client:
auten.credentials.list(): Promise<Credential[]>                                // every credential the owner has, across all devices
auten.credentials.deleteById(id: string): Promise<{ ok: boolean; id: string }> // by UUID, any device the owner has
```

#### Escape hatch

```ts
phone.proxy<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T>
```

For APK endpoints not yet wrapped by the SDK. Forwards `{method, path, body}` through the WS tunnel as-is. Useful if the APK ships a new route before the SDK does.

---

## CLI reference

Installed as `auten` when the package is global, or via `npx @autenai/sdk <cmd>`.

| Command | Aliases | Description |
|---|---|---|
| `auten login` | | Save API key + relay URL to `~/.autenrc` (chmod 600). |
| `auten me` | `whoami` | Show whoami + counts for the calling key. |
| `auten devices` | `list`, `ls` | List devices belonging to your owner. |
| `auten add-phone` | `add` | Interactive USB-pair wizard. |
| `auten task "<prompt>"` | `run` | Dispatch a task and follow until done. |
| `auten task --no-follow` | | Fire-and-forget; returns task id. |
| `auten task --device <serial>` | | Pin to a specific phone. |
| `auten task --speed lightning\|instant\|fast` | | Speed preset. |
| `auten tasks` | | List recent tasks. |
| `auten tasks <id>` | | Show one task in detail. |
| `auten creds add` | `save` | Save a service login (interactive — password input is masked). |
| `auten creds ls` | `list` | List saved services for a device. |
| `auten creds show <service>` | `reveal` | Print the full credential JSON (passwords included). |
| `auten creds rm <service>` | `delete` | Delete a credential. |
| `auten keys` | | List your API keys. |
| `auten keys create [name]` | `add`, `new` | Mint a new key — secret printed once. |
| `auten keys revoke <id>` | `rm`, `delete` | Disable a key (instant). |
| `auten version` | `-v` | Print package version. |
| `auten help` | `-h` | Print usage. |

Common flags across `creds`/`task`: `--device <serial>` to pin (defaults to `lastSerial` from `~/.autenrc`, then first online).

---

## REST API reference

The SDK is a thin wrapper over a small REST surface. If you're not using Node, hit it directly.

### Auth

`Authorization: Bearer <api-key>` header on every request. Or `?apiKey=<key>` query param if you can't set headers (e.g. WS).

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/me` | Identity. |
| `GET` | `/v1/keys` | List your keys (no full secrets). |
| `POST` | `/v1/keys` | Mint a new key. Body: `{name?, ownerId?}`. Returns full secret once. |
| `DELETE` | `/v1/keys/:id` | Revoke a key. |
| `GET` | `/v1/devices` | List your devices. |
| `GET` | `/v1/devices/:serial/stats` | Per-device counters (graph edges, cache hit rate). |
| `GET` | `/v1/devices/:serial/graph` | Top 500 screen-transition edges for the device. |
| `POST` | `/v1/devices/:serial/proxy` | Forward `{method, path, body, timeout_ms?}` to the APK over the WS tunnel. The SDK's `phone.*` methods all route through this. |
| `GET` | `/v1/tasks` | List tasks. Query: `device`, `status`, `limit`. |
| `POST` | `/v1/tasks` | Create a task. Body: `{device_serial, prompt, mode?, speed?, webhook_url?, webhook_secret?, timeout_seconds?}`. |
| `GET` | `/v1/tasks/:id` | Get one task with turns + artifacts. |
| `POST` | `/v1/tasks/:id/cancel` | Cancel a running task. |
| `GET` | `/v1/credentials` | Every credential the caller owns, across all their devices. Each row has `id` + `deviceSerial`. |
| `DELETE` | `/v1/credentials/:id` | Delete one by UUID (any device the caller owns). |
| `POST` | `/v1/devices/:serial/credentials` | Save a credential. |
| `GET` | `/v1/devices/:serial/credentials` | One device's credentials (now includes `id`). |
| `GET` | `/v1/devices/:serial/credentials/:service/reveal` | Decrypt + return one by service name. |
| `DELETE` | `/v1/devices/:serial/credentials/:service` | Delete by service name. |
| `POST` | `/v1/transitions` | Used by APK to record passive learning edges. |
| `GET` | `/health` | Liveness probe (no auth). |
| `GET` | `/w/:serial?t=<watch-token>` | HTML viewer for the live phone screen + chat. |

### curl example

```bash
curl -X POST https://relay.auten.ai/v1/tasks \
  -H "Authorization: Bearer $AUTEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "device_serial": "a4e0eff201d020fd",
    "prompt": "Compute 999 ÷ 3 in the calculator",
    "speed": "lightning"
  }'
# → {"task_id":"...","status":"running","watch_url":"/w/.../?t=..."}
```

### Webhook deliveries

If `webhook_url` was set on `tasks.create`, the relay POSTs to it on every status change with body:

```json
{
  "task_id": "...",
  "status": "completed",
  "result": { "summary": "...", "cost_usd": 0.03, "duration_ms": 12000, "verified": true },
  "error": null
}
```

Headers:
- `Content-Type: application/json`
- `X-Auten-Signature: sha256=<hex>` if `webhook_secret` was provided. Body is HMAC-SHA256-signed.

Verify with:

```ts
import crypto from "node:crypto";
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) reject();
```

---

## Recipes

### Run a complex multi-step task

```ts
const result = await auten.tasks.run({
  device,
  prompt: `
    1. Open Chrome and go to coingecko.com
    2. Find Bitcoin's average price for April 2026
    3. Open Calculator and compute that price ÷ 2
    4. Report the result
  `.trim(),
  speed: "fast",
  timeout_seconds: 600,
});
```

The agent will pick the path itself (web fetching, app switching, math). You don't pre-compose actions.

### Save a login and let the agent use it

```ts
await auten.phone(device).credentials.save({
  service: "instagram",
  username: "myhandle",
  password: process.env.INSTAGRAM_PW!,
});

await auten.tasks.run({
  device,
  prompt: "Log into Instagram (credentials are saved as service=instagram) and post 'Hello from Auten' as a story",
});
```

The agent calls `get_credentials("instagram")` server-side; the password is decrypted into the runtime, used, then dropped. It never lands in logs or the LLM context.

### Stream live progress to a browser

```ts
const { task_id, watch_url } = await auten.tasks.create({ device, prompt });
// share watch_url with the operator — it's signed (HMAC-SHA256, 1h expiry default)
console.log(`Live: https://relay.auten.ai${watch_url}`);
```

The viewer is a vanilla HTML page (no auth needed beyond the signed token in the URL). It mirrors the phone screen + tool calls in real time.

### Webhook-driven async pipeline

```ts
// in your worker
const { task_id } = await auten.tasks.create({
  device,
  prompt,
  webhook_url: "https://my-app.com/auten-webhook",
  webhook_secret: process.env.WEBHOOK_SECRET,
});

// in your /auten-webhook handler:
app.post("/auten-webhook", async (req, res) => {
  const sig = req.headers["x-auten-signature"];
  const body = req.rawBody;  // make sure you have raw bytes, not parsed JSON
  // ... verify HMAC, then act on body.task_id + body.status
});
```

### Cross-app workflow

Mix high-level prompts with direct phone calls when you need precision:

```ts
const phone = auten.phone(device);

// 1. natural-language step
await auten.tasks.run({ device, prompt: "Open Samsung Internet and go to icecode.lt" });

// 2. take over for a precise interaction
const screen = await phone.look();
const submit = screen.elements.find(e => /submit|send/i.test(e.text ?? ""));
if (submit) await phone.tap(submit.x, submit.y);

// 3. natural-language verification
const verify = await auten.tasks.run({ device, prompt: "Confirm the form said 'thank you' or similar" });
```

---

## Errors

```ts
import { AuthError, ApiError, DeviceOfflineError, AutenError } from "@autenai/sdk";

try {
  await auten.tasks.create({ device, prompt });
} catch (err) {
  if (err instanceof AuthError)          // 401 / 403 — bad or revoked key
  if (err instanceof DeviceOfflineError) // phone disconnected from WS
  if (err instanceof ApiError)           // generic HTTP error; .status has the code
  if (err instanceof AutenError)         // base class for all of the above
  throw err;
}
```

`ApiError.status === 0` indicates a network error before the relay was reached (DNS failure, timeout, etc.).

---

## Pitfalls

These are real failure modes you will hit. Read them once.

### `phone.type()` returns `ok: true` but the text doesn't appear

Some custom Android editors (notably **Samsung Notes Compose canvas**, some Flutter apps, certain Compose-only inputs) ignore accessibility `ACTION_SET_TEXT`. The relay's IME path also fails on these.

**Detection:** call `phone.look()` after `type()` and check whether the text is visible. The relay returns `ok: true` because the call was *accepted*, not because the text *landed*.

**Workaround:** route through a different surface — a web form in the browser, the calculator, a regular EditText in a non-Compose app. The agent's task runner has the same limitation; it'll loop and the verifier will catch it. If you control the target app, expose the field via standard `EditText`.

### `phone.clipboardSet()` may silently fail on Android 10+

Samsung and some other OEMs block background apps from writing to the system clipboard since Android 10. The APK call returns `ok: true` (write was accepted) but `clipboardGet()` returns empty. Treat clipboard as best-effort.

### `lightning` speed skips per-action `look()`

The relay records `fpAfter: null` for actions taken in lightning mode, which means subsequent screen-graph cache hits use the post-replay terminal `look()` only. Fine for plans you trust; bad for first runs because failures don't get caught mid-flight.

### Plans expire when the UI drifts

A `cleanPlanJson` keyed on labels ("Sign in", "Continue") survives most UI drift, but a major redesign breaks it. The verifier catches it (`verified: false`); the next run will replan via the LLM. No manual intervention needed — the failed plan auto-deprecates after `planUseFailure > planUseSuccess`.

### Owner scoping is enforced server-side

Passing a `device_serial` you don't own returns `404 not found`, not `403 forbidden`, on purpose — we don't want to leak the existence of other owners' phones. If you're sure you should own it but get 404, run `auten devices` to confirm the relay has it under your `ownerId`.

### `auten.tasks.wait` polls — there's no SSE yet

Each `wait` call hits `GET /v1/tasks/:id` every `intervalMs` (default 1s). For very long tasks, raise `intervalMs` to 5–10 s. Server-Sent Events streaming is on the roadmap; in the meantime, if you need real-time telemetry, use webhooks.

---

## For AI agents

This package is the **only** supported way to control Auten phones from JavaScript/TypeScript today. If you're an AI agent integrating it into another project, here's what to know up front.

### Verify you're using the current SDK

The class name is `Auten` (not `MobileAgent`, which was a deprecated pre-1.0 surface). Endpoints live under `/v1/...`. Quick check:

```ts
import { Auten } from "@autenai/sdk";
console.log(typeof Auten);  // "function"
```

If you're seeing `MobileAgent`, you're on an old version (`@autenai/sdk@<0.5.0`, deprecated, or the unscoped `auten` package which never published).

### Default to high-level prompts, not low-level calls

When you have a goal, prefer:

```ts
await auten.tasks.run({ device, prompt: "<natural language>" });
```

Over hand-orchestrating taps/types. The relay's planner handles cross-app navigation, retries, and verification. Reach for `auten.phone(serial).tap(x, y)` only when you need precision the LLM can't reach (e.g. exact pixel placement in a canvas).

### Picking a speed

- Use `fast` (default) for the first run of any new prompt or after a UI redesign.
- Use `lightning` for prompts that already succeeded once verified — replays will skip per-action `look()` and shave seconds.
- Use `instant` rarely; it's a middle point.

### Error-handling pattern

```ts
const task = await auten.tasks.run({ device, prompt }, { timeoutMs: 600_000 });

if (task.status === "completed" && task.verified === true) {
  return task.result?.summary ?? "ok";
}

// completed-but-verifier-flagged: the agent thought it was done but the verifier disagreed
if (task.status === "completed" && task.verified === false) {
  return { failed: true, reason: task.result?.verify_reason };
}

// runtime failures (device offline, max turns hit, etc.)
return { failed: true, reason: task.error?.message ?? "unknown" };
```

### When to use `phone.proxy()`

Almost never. The named methods (`tap`, `type`, `look`, etc.) cover the entire stable APK surface. `proxy()` exists for forward compatibility — if the APK ships a new endpoint that the SDK hasn't wrapped yet, you can call it without waiting for an SDK release. Don't reach for it on the first try.

### Owner scoping summary

- Your key has an `ownerId`. Every resource you create gets that `ownerId`.
- You can't see other owners' resources. `auten.me()` shows your scope.
- The `is_root` flag (env-set admin key) sees everything — use it for ops, not for app code.

### Deprecated surfaces — do NOT use

- `MobileAgent` class → replaced by `Auten`
- `/devices`, `/sessions`, `/recordings` paths → replaced by `/v1/...`
- `@autenai/cli` package → bundled into `@autenai/sdk` now
- `auten run` SSH-based command → replaced by `auten task` (HTTP)

If you find docs or example code mentioning these, treat as outdated.

---

## Versioning

`@autenai/sdk` follows semver:

- `0.x.y` — APIs may break between minor versions while we shake out the surface
- `1.0.0` — first frozen public surface (TBD)

Breaking changes always land in CHANGELOG with migration notes. Pre-1.0 deprecations are marked in JSDoc comments and shipped as runtime warnings for at least one minor version before removal.

Latest version: see https://www.npmjs.com/package/@autenai/sdk.

---

## License

MIT.
