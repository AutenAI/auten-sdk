import { Transport, DEFAULT_BASE_URL } from "./transport.js";
import { Phone } from "./phone.js";
import type {
  Device, Task, TaskAction, ApiKey, ApiKeyWithSecret, Whoami,
  CreateTaskInput, CreateTaskResponse, ListTasksOptions, CreateKeyInput,
  Credential, CredentialCategory,
} from "./types.js";

export type AutenConfig = {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in ms. Default 60s. */
  timeoutMs?: number;
};

/**
 * Auten — top-level SDK client. Wraps the relay's REST API with typed
 * methods grouped by resource:
 *
 *   const auten = new Auten({ apiKey: process.env.AUTEN_API_KEY });
 *   const me = await auten.me();
 *   const devices = await auten.devices.list();
 *   const { task_id } = await auten.tasks.create({ device: devices[0].serial, prompt: "open chrome" });
 *   const result = await auten.tasks.wait(task_id);
 *   const phone = auten.phone(devices[0].serial);
 *   await phone.tap(500, 800);
 */
export class Auten {
  private readonly t: Transport;

  constructor(config: AutenConfig) {
    this.t = new Transport(config.apiKey, config.baseUrl ?? DEFAULT_BASE_URL, config.timeoutMs);
  }

  get baseUrl(): string { return this.t.baseUrl; }

  /** Identity + counters for the calling key. */
  me(): Promise<Whoami> {
    return this.t.get<Whoami>("/v1/me");
  }

  // ── Devices ──────────────────────────────────────────────────────
  readonly devices = {
    list: async (): Promise<Device[]> => {
      const r = await this.t.get<{ devices: Device[] }>("/v1/devices");
      return r.devices;
    },
    get: async (serial: string): Promise<Device | null> => {
      const all = await this.devices.list();
      return all.find((d) => d.serial === serial) ?? null;
    },
    /** First device that's currently online, or null. */
    firstOnline: async (): Promise<Device | null> => {
      const all = await this.devices.list();
      return all.find((d) => d.online) ?? null;
    },
    stats: (serial: string): Promise<{
      serial: string;
      online: boolean;
      graph_edges: number;
      task_count: number;
      cache_hit_rate: number;
    }> => this.t.get(`/v1/devices/${encodeURIComponent(serial)}/stats`),
  };

  // ── Tasks ────────────────────────────────────────────────────────
  readonly tasks = {
    create: (input: CreateTaskInput): Promise<CreateTaskResponse> => {
      return this.t.post<CreateTaskResponse>("/v1/tasks", {
        device_serial: input.device,
        prompt: input.prompt,
        mode: input.mode,
        speed: input.speed,
        webhook_url: input.webhook_url,
        webhook_secret: input.webhook_secret,
        timeout_seconds: input.timeout_seconds,
      });
    },
    get: (id: string): Promise<Task> => this.t.get<Task>(`/v1/tasks/${encodeURIComponent(id)}`),
    /**
     * Per-tool-call audit log for a task. Returns the full MCP execution
     * trace — every mobile_look / mobile_tap_* / etc. with input, output,
     * timing, and FP transition. Backs `auten task --debug` live streaming.
     */
    actions: (id: string): Promise<{ task_id: string; actions: TaskAction[] }> =>
      this.t.get(`/v1/tasks/${encodeURIComponent(id)}/actions`),
    list: async (opts: ListTasksOptions = {}): Promise<Task[]> => {
      const q = new URLSearchParams();
      if (opts.device) q.set("device", opts.device);
      if (opts.status) q.set("status", opts.status);
      if (opts.limit !== undefined) q.set("limit", String(opts.limit));
      const qs = q.toString();
      const r = await this.t.get<{ tasks: Task[] }>(`/v1/tasks${qs ? `?${qs}` : ""}`);
      return r.tasks;
    },
    cancel: (id: string): Promise<{ task_id: string; status: string }> =>
      this.t.post(`/v1/tasks/${encodeURIComponent(id)}/cancel`),

    /**
     * Poll until the task reaches a terminal state. Backs off from `intervalMs`
     * (default 1s) and aborts at `timeoutMs` (default 5 min).
     * Returns the final Task object.
     */
    wait: async (id: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<Task> => {
      const interval = opts.intervalMs ?? 1000;
      const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
      // First fetch is immediate so the caller doesn't pay an interval delay
      // for a task that's already done by the time wait() is called.
      let t = await this.tasks.get(id);
      while (t.status === "queued" || t.status === "running") {
        if (Date.now() > deadline) {
          throw new Error(`task ${id} did not complete within ${opts.timeoutMs ?? 300_000}ms`);
        }
        await new Promise((r) => setTimeout(r, interval));
        t = await this.tasks.get(id);
      }
      return t;
    },

    /**
     * One-shot helper: create + wait. Returns the final Task.
     *
     *   const result = await auten.tasks.run({ device, prompt: "999÷3", speed: "lightning" });
     *   console.log(result.verified, result.result?.summary);
     */
    run: async (input: CreateTaskInput, waitOpts?: { intervalMs?: number; timeoutMs?: number }): Promise<Task> => {
      const created = await this.tasks.create(input);
      return this.tasks.wait(created.task_id, waitOpts);
    },
  };

  // ── API keys ─────────────────────────────────────────────────────
  readonly keys = {
    list: async (): Promise<ApiKey[]> => {
      const r = await this.t.get<{ keys: ApiKey[] }>("/v1/keys");
      return r.keys;
    },
    /** Returns the new key with the FULL secret in `key`. Store it — the
     *  listing endpoint never reveals it again. */
    create: (input: CreateKeyInput = {}): Promise<ApiKeyWithSecret> =>
      this.t.post<ApiKeyWithSecret>("/v1/keys", input),
    revoke: (id: string): Promise<{ ok: boolean; id: string }> =>
      this.t.del(`/v1/keys/${encodeURIComponent(id)}`),
  };

  // ── Credentials (cross-device) ───────────────────────────────────
  // Per-device save / reveal lives on `auten.phone(serial).credentials`;
  // these are the helpers for "I want to see / delete one credential
  // and I have its UUID, not its (serial, service) pair".
  readonly credentials = {
    /** Every credential the calling key can see, across all of the owner's
     *  devices. Each row carries `id`, `category` and `deviceSerial`.
     *  Pass `{ category }` to filter (use empty string to fetch only
     *  uncategorised rows). */
    list: async (opts: { category?: string } = {}): Promise<Credential[]> => {
      const q = opts.category !== undefined ? `?category=${encodeURIComponent(opts.category)}` : "";
      const r = await this.t.get<{ credentials: Credential[] }>(`/v1/credentials${q}`);
      return r.credentials;
    },
    /** Distinct categories across every device this key owns, with counts.
     *  Categories are auto-created the first time you save a cred with one
     *  and disappear when the last cred in them is deleted. */
    categories: async (): Promise<CredentialCategory[]> => {
      const r = await this.t.get<{ categories: CredentialCategory[] }>("/v1/credentials/categories");
      return r.categories;
    },
    /** Delete a credential by its UUID. The relay verifies the calling key
     *  owns the device the credential belongs to. */
    deleteById: (id: string): Promise<{ ok: boolean; id: string }> =>
      this.t.del(`/v1/credentials/${encodeURIComponent(id)}`),
  };

  /** Phone handle for direct control / per-device credentials. */
  phone(serial: string): Phone {
    return new Phone(this.t, serial);
  }
}
