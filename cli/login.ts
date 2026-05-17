import { Auten } from "../src/index.js";
import { AuthError } from "../src/errors.js";
import { C, banner, ok, fail, info, prompt, readRc, writeRc, rcPath } from "./util.js";

const DEFAULT_BASE_URL = "https://relay.auten.ai";

export async function loginCommand(argv: string[] = []): Promise<void> {
  banner("auten login");
  const existing = readRc();
  if (existing.apiKey) {
    info(`Existing key in ${rcPath()} (ends in ...${existing.apiKey.slice(-6)})`);
  }

  // The relay URL is implementation detail — we don't surface it in the
  // prompt or output. Self-hosters / advanced users can override via the
  // AUTEN_BASE_URL env var (read at request time by the SDK transport).
  const baseUrl = process.env.AUTEN_BASE_URL || DEFAULT_BASE_URL;

  // Accept the key as a positional arg: `auten login <key>` — saves a
  // round-trip and works when the user has the key on their clipboard.
  // Falls back to a visible prompt so paste reliably works across terminals
  // (raw-mode hidden input blocks paste on macOS Terminal).
  const inlineKey = argv.find((a) => a && !a.startsWith("-"));
  const apiKey = (inlineKey ?? (await prompt("API key: "))).trim();
  if (!apiKey) { fail("No key entered."); process.exit(1); }

  process.stdout.write(`${C.dim}Verifying...${C.reset}\n`);
  try {
    const auten = new Auten({ apiKey, baseUrl });
    const me = await auten.me();
    ok(`Authenticated as ${C.bold}${me.owner_id}${C.reset}${me.is_root ? " (root)" : ""} — ${me.device_count} device(s), ${me.task_count} task(s).`);
  } catch (err: unknown) {
    if (err instanceof AuthError) { fail(`Auth failed: ${err.message}`); process.exit(1); }
    fail(`Verification failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // Write only the API key. Omitting baseUrl lets future SDK upgrades change
  // the default without anyone being pinned to a stale URL in their rc file.
  writeRc({ apiKey });
  ok(`Saved to ${rcPath()}`);
}
