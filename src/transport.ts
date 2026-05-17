import { AuthError, ApiError, DeviceOfflineError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://relay.auten.ai";
const DEFAULT_TIMEOUT_MS = 60_000;

export class Transport {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;

  constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    if (!apiKey) throw new AuthError("apiKey required");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async get<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>("GET", path, undefined, timeoutMs);
  }

  async post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>("POST", path, body, timeoutMs);
  }

  async put<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>("PUT", path, body, timeoutMs);
  }

  async del<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>("DELETE", path, undefined, timeoutMs);
  }

  private async request<T>(method: string, path: string, body: unknown, timeoutMs?: number): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      throw new ApiError(`network error calling ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`, 0);
    }

    const text = await res.text();
    if (res.status === 401) throw new AuthError(text || "unauthorized");
    if (res.status === 403) throw new AuthError(text || "forbidden");
    if (res.status === 503 && /not connected/i.test(text)) {
      const m = text.match(/serial\W*([\w-]+)/);
      throw new DeviceOfflineError(m?.[1] ?? "<unknown>");
    }
    if (!res.ok) {
      throw new ApiError(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`, res.status);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Some endpoints (e.g. /apk/latest) stream non-JSON. The SDK doesn't
      // call those; if we land here it's a contract violation worth surfacing.
      throw new ApiError(`${method} ${path}: response was not JSON`, res.status);
    }
  }
}
