/**
 * Shared CLI helpers — output formatting, config file location, prompts.
 * Kept stdlib-only on purpose so the package has zero CLI deps beyond `ws`.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { createInterface, type Interface } from "readline";

export const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", blue: "\x1b[34m", magenta: "\x1b[35m",
  // 256-colour mid-grey background, subtle on both light and dark themes.
  bgDim: "\x1b[48;5;236m",
};

export const banner = (s: string) => console.log(`\n${C.cyan}${C.bold}${s}${C.reset}`);
export const step = (n: number, total: number, t: string) =>
  console.log(`\n${C.cyan}${C.bold}[${n}/${total}]${C.reset} ${C.bold}${t}${C.reset}`);
export const ok = (m: string) => console.log(`  ${C.green}✓${C.reset} ${m}`);
export const warn = (m: string) => console.log(`  ${C.yellow}⚠${C.reset} ${m}`);
export const info = (m: string) => console.log(`  ${C.dim}→${C.reset} ${m}`);
export const fail = (m: string) => console.log(`  ${C.red}✗${C.reset} ${m}`);
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const RC_PATH = resolve(homedir(), ".autenrc");
const HISTORY_PATH = resolve(homedir(), ".auten_history");
const HISTORY_MAX = 1000;

export interface Rc {
  apiKey?: string;
  baseUrl?: string;
  lastSerial?: string;
  model?: string;
  budget?: string;
  /** Speed multiplier for deterministic tiers (smart-replay, app-plan). */
  speed?: number;
}

export function readRc(): Rc {
  if (existsSync(RC_PATH)) {
    try { return JSON.parse(readFileSync(RC_PATH, "utf-8")); } catch { /* fall through */ }
  }
  return {};
}

export function writeRc(rc: Rc): void {
  writeFileSync(RC_PATH, JSON.stringify(rc, null, 2));
  try { chmodSync(RC_PATH, 0o600); } catch {}
}

export function rcPath(): string { return RC_PATH; }

export function readHistory(): string[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const lines = readFileSync(HISTORY_PATH, "utf-8").split("\n").map(l => l.trim()).filter(Boolean);
    return lines.slice(-HISTORY_MAX);
  } catch { return []; }
}

export function appendHistory(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const existing = readHistory();
    if (existing[existing.length - 1] === trimmed) return;
    const next = [...existing, trimmed].slice(-HISTORY_MAX);
    writeFileSync(HISTORY_PATH, next.join("\n") + "\n");
    try { chmodSync(HISTORY_PATH, 0o600); } catch {}
  } catch { /* not fatal */ }
}

/**
 * Resolve config in this order: env vars → ~/.autenrc.
 * Returns the API key + base URL or exits if no key is found.
 */
export function loadConfig(): { apiKey: string; baseUrl: string } {
  const rc = readRc();
  const apiKey = process.env.AUTEN_API_KEY || rc.apiKey;
  const baseUrl = process.env.AUTEN_BASE_URL || rc.baseUrl || "https://relay.auten.ai";
  if (!apiKey) {
    fail("No API key configured.");
    info("Run `auten login` first, or set AUTEN_API_KEY in the environment.");
    process.exit(1);
  }
  return { apiKey, baseUrl };
}

export function rl(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

export function prompt(question: string): Promise<string> {
  const r = rl();
  return new Promise(resolve => r.question(question, answer => { r.close(); resolve(answer.trim()); }));
}

export async function promptHidden(question: string): Promise<string> {
  // Best-effort hidden input — masks characters as they're typed.
  process.stdout.write(question);
  return new Promise<string>(resolve => {
    const stdin = process.stdin;
    let buf = "";
    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    const onData = (ch: string) => {
      switch (ch) {
        case "\n": case "\r": case "":
          stdin.setRawMode?.(wasRaw);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(buf);
          return;
        case "":
          process.exit(130);
          return;
        case "":
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          return;
        default:
          buf += ch;
          process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}
