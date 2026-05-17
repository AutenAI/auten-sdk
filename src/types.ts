/** Speed preset — drives the BIOS replay engine's settle / postAction / look-skip behaviour.
 *
 *   "fast"      — human pace (default), 250ms settle, look after every action
 *   "instant"   — 50ms settle, still looks after each step
 *   "lightning" — 10ms settle, skips per-action look (fastest, less verifiable)
 */
export type Speed = "fast" | "instant" | "lightning";

export type TaskMode = "task" | "explore";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type Device = {
  serial: string;
  model: string | null;
  online: boolean;
  type: string;
  lastSeenAt: string | null;
  androidVersion: string | null;
  screenW: number | null;
  screenH: number | null;
};

export type TaskTurn = {
  index: number;
  source: string;        // "cached" | "decide" | "delegate" | "replay"
  label: string | null;
  ok: boolean;
  cost_usd: number;
  duration_ms: number | null;
};

export type TaskArtifact = {
  type: string;
  name: string;
  url: string | null;
  data: unknown;
};

/** One MCP tool call inside a task — the granular debug-mode unit. */
export type TaskAction = {
  index: number;
  turnIndex: number;
  toolName: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  ok: boolean;
  durationMs: number | null;
  fpBefore: string | null;
  fpAfter: string | null;
  createdAt: string;
};

export type Task = {
  task_id: string;
  device_serial: string;
  prompt: string;
  status: TaskStatus;
  mode: TaskMode;
  verified?: boolean | null;
  result?: { summary?: string; cost_usd?: number; duration_ms?: number; verified?: boolean; verify_reason?: string } | null;
  error?: { code?: string; message?: string; retryable?: boolean } | null;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  turns?: TaskTurn[];
  artifacts?: TaskArtifact[];
};

export type CreateTaskInput = {
  device: string;
  prompt: string;
  mode?: TaskMode;
  speed?: Speed;
  webhook_url?: string;
  webhook_secret?: string;
  timeout_seconds?: number;
};

export type CreateTaskResponse = {
  task_id: string;
  status: string;
  watch_url: string;
};

export type ListTasksOptions = {
  device?: string;
  status?: TaskStatus;
  limit?: number;
};

export type Whoami = {
  owner_id: string;
  key_id: string;
  is_root: boolean;
  device_count: number;
  task_count: number;
  plan?: "FREE" | "STARTER" | "PRO" | "STUDIO";
  limits?: {
    /** -1 means unlimited */
    phones: number;
    clicks_per_month: number;
  };
  /** A "click" = one phone interaction (tap, swipe, type, key-press, ...). */
  usage?: {
    phones: number;
    clicks_this_month: number;
    month_start: string;
  };
};

export type ApiKey = {
  id: string;
  owner_id: string;
  name: string | null;
  active: boolean;
  created_at: string;
  last_used_at?: string | null;
  key_preview: string;
};

export type ApiKeyWithSecret = ApiKey & { key: string };

export type CreateKeyInput = {
  name?: string;
  /** Only root keys can mint keys for other owners. */
  ownerId?: string;
};

export type Credential = {
  /** Stable UUID — pass to `auten.credentials.deleteById(id)` or `phone.credentials.deleteById(id)`. */
  id: string;
  service: string;
  username: string | null;
  notes: string | null;
  /** Free-form group label (e.g. \"Shipping lines\", \"Social\"). null = uncategorised. */
  category: string | null;
  /** Phone serial the credential is scoped to. */
  deviceSerial: string;
  updatedAt: string;
};

export type SaveCredentialInput = {
  service: string;
  username?: string;
  password?: string;
  totp_secret?: string;
  notes?: string;
  /** Free-form group label. Pass null to clear; omit to leave unchanged on update. */
  category?: string | null;
  [k: string]: unknown;
};

/** Distinct category, with how many credentials currently use it. */
export type CredentialCategory = {
  name: string;
  count: number;
};

export type SomElement = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  desc?: string;
  cls?: string;
  res?: string;
  clickable?: boolean;
  editable?: boolean;
  scrollable?: boolean;
  via_ocr?: boolean;
};

export type LookResult = {
  annotated: string;     // base64 JPEG with SoM markers drawn on top
  elements: SomElement[];
  width: number;
  height: number;
};

export type KeyName =
  | "back" | "home" | "recents" | "enter" | "delete" | "tab"
  | "menu" | "search" | "volume_up" | "volume_down" | "power";
