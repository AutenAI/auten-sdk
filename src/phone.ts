import type { Transport } from "./transport.js";
import type {
  LookResult, KeyName, Credential, CredentialCategory, SaveCredentialInput,
  CreateTaskResponse, Speed, TaskMode,
} from "./types.js";

/**
 * Phone — wraps a single device. All control calls go through the relay's
 * owner-scoped phone-proxy endpoint, which forwards them via the WS reverse
 * tunnel to the APK on the device.
 *
 *   const phone = auten.phone("a4e0eff201d020fd");
 *   const screen = await phone.look();
 *   await phone.tap(500, 800);
 *   await phone.task("open Instagram and like 5 posts");
 */
export class Phone {
  constructor(private readonly t: Transport, public readonly serial: string) {}

  private get base(): string {
    return `/v1/devices/${encodeURIComponent(this.serial)}`;
  }

  /**
   * Forward an HTTP envelope to the phone APK through the relay tunnel.
   * Most callers should use the named methods below; this is the escape
   * hatch for endpoints we haven't wrapped (and for forward-compat with
   * APK changes that ship before SDK updates).
   */
  proxy<T = unknown>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.t.post<T>(`${this.base}/proxy`, { method, path, body, timeout_ms: timeoutMs });
  }

  // ── Vision ────────────────────────────────────────────────────────
  look(): Promise<LookResult> {
    return this.proxy<LookResult>("POST", "/look");
  }
  screenshot(): Promise<{ jpeg: string; width: number; height: number; durationMs: number }> {
    return this.proxy("POST", "/screenshot");
  }

  // ── Input ─────────────────────────────────────────────────────────
  tap(x: number, y: number): Promise<{ ok: boolean }> {
    return this.proxy("POST", "/tap", { x: Math.round(x), y: Math.round(y) });
  }
  longPress(x: number, y: number, durationMs = 1000): Promise<{ ok: boolean }> {
    return this.proxy("POST", "/long_press", { x: Math.round(x), y: Math.round(y), duration: durationMs });
  }
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<{ ok: boolean }> {
    return this.proxy("POST", "/swipe", {
      x1: Math.round(x1), y1: Math.round(y1),
      x2: Math.round(x2), y2: Math.round(y2),
      duration: durationMs,
    });
  }
  /**
   * Type text into the focused field. Pass `target: { x, y }` of an
   * editable element to bypass the soft keyboard (uses accessibility
   * ACTION_SET_TEXT — instant, no layout shift).
   */
  type(text: string, target?: { x: number; y: number }): Promise<{ ok: boolean }> {
    return this.proxy("POST", "/type", target
      ? { text, x: Math.round(target.x), y: Math.round(target.y) }
      : { text },
    );
  }
  key(name: KeyName): Promise<{ ok: boolean }> {
    return this.proxy("POST", "/key", { key: name });
  }

  // ── Apps ──────────────────────────────────────────────────────────
  /** Force-stops the package first (clean slate), then launches it. */
  async launch(packageName: string): Promise<{ ok: boolean }> {
    await this.proxy("POST", "/stop", { package: packageName }).catch(() => {});
    return this.proxy("POST", "/launch", { package: packageName });
  }
  stop(packageName: string): Promise<{ ok: boolean }> {
    return this.proxy("POST", "/stop", { package: packageName });
  }
  /** ACTION_VIEW intent — one-shot navigation. Pass `pkg` to pin a browser. */
  openUrl(url: string, pkg?: string): Promise<{ ok: boolean; url: string; package?: string }> {
    return this.proxy("POST", "/open_url", pkg ? { url, package: pkg } : { url });
  }

  // ── Status / events ──────────────────────────────────────────────
  status(): Promise<unknown> { return this.proxy("GET", "/status"); }
  info(): Promise<unknown> { return this.proxy("GET", "/info"); }
  /** Kill all third-party apps + press home. Useful before benchmarks. */
  reset(): Promise<{ ok: boolean; killedCount: number }> { return this.proxy("POST", "/reset"); }
  notifications(): Promise<unknown[]> { return this.proxy("GET", "/notifications"); }
  clearNotifications(): Promise<{ ok: boolean }> { return this.proxy("POST", "/notifications/clear"); }

  // ── Clipboard ────────────────────────────────────────────────────
  clipboardSet(text: string): Promise<{ ok: boolean }> {
    return this.proxy("POST", "/clipboard/set", { text });
  }
  clipboardGet(): Promise<{ ok: boolean; text: string }> {
    return this.proxy("GET", "/clipboard/get");
  }
  pasteClipboard(target?: { x: number; y: number }): Promise<{ ok: boolean }> {
    return this.proxy("POST", "/paste-clipboard", target
      ? { x: Math.round(target.x), y: Math.round(target.y) }
      : {},
    );
  }

  // ── Task dispatch (sugar) ─────────────────────────────────────────
  /**
   * Shortcut for `auten.tasks.create({ device: this.serial, prompt, ... })`.
   * Returns the task handle; await `auten.tasks.wait(id)` for the result.
   */
  task(prompt: string, opts?: {
    speed?: Speed;
    mode?: TaskMode;
    timeout_seconds?: number;
    webhook_url?: string;
    webhook_secret?: string;
  }): Promise<CreateTaskResponse> {
    return this.t.post("/v1/tasks", {
      device_serial: this.serial,
      prompt,
      mode: opts?.mode,
      speed: opts?.speed,
      timeout_seconds: opts?.timeout_seconds,
      webhook_url: opts?.webhook_url,
      webhook_secret: opts?.webhook_secret,
    });
  }

  // ── Credentials (encrypted server-side, scoped to this device) ───
  readonly credentials = {
    save: (input: SaveCredentialInput): Promise<{ ok: boolean; service: string }> =>
      this.t.post(`${this.base}/credentials`, input),
    /** List this device's credentials. Each row carries `id` (UUID) and
     *  `category`. Pass `{ category }` to filter (empty string = only
     *  uncategorised). */
    list: async (opts: { category?: string } = {}): Promise<Credential[]> => {
      const q = opts.category !== undefined ? `?category=${encodeURIComponent(opts.category)}` : "";
      const r = await this.t.get<{ credentials: Credential[] }>(`${this.base}/credentials${q}`);
      return r.credentials;
    },
    /** Distinct categories used on this device, with counts. */
    categories: async (): Promise<CredentialCategory[]> => {
      const r = await this.t.get<{ categories: CredentialCategory[] }>(`${this.base}/credentials/categories`);
      return r.categories;
    },
    reveal: <T = Record<string, unknown>>(service: string): Promise<T> =>
      this.t.get(`${this.base}/credentials/${encodeURIComponent(service)}/reveal`),
    /** Delete by service name (unique per device). */
    delete: (service: string): Promise<{ ok: boolean }> =>
      this.t.del(`${this.base}/credentials/${encodeURIComponent(service)}`),
    /** Delete by UUID. Routed through the cross-device endpoint; the
     *  relay verifies the credential belongs to a device this key owns. */
    deleteById: (id: string): Promise<{ ok: boolean; id: string }> =>
      this.t.del(`/v1/credentials/${encodeURIComponent(id)}`),
  };
}
