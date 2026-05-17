/**
 * `auten task "<prompt>"` — dispatch one task to a phone via the relay's
 * REST API and tail its progress until completion. Replaces the old SSH-
 * based `auten run` command.
 */
import { Auten } from "../src/index.js";
import type { Speed, TaskMode, Task } from "../src/index.js";
import { C, banner, info, fail, ok, warn, loadConfig } from "./util.js";

interface TaskOpts {
  serial?: string;
  prompt: string;
  speed?: Speed;
  mode?: TaskMode;
  timeoutSec?: number;
  noFollow: boolean;
  debug: boolean;
  webhook?: string;
}

function parseArgs(argv: string[]): TaskOpts {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) {
      flags[a.slice(2)] = argv[++i]!;
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = "true";
    } else {
      positional.push(a);
    }
  }
  const speed = (flags["speed"] ?? undefined) as Speed | undefined;
  const mode = (flags["mode"] ?? undefined) as TaskMode | undefined;
  return {
    serial: flags["device"] ?? flags["serial"],
    prompt: flags["prompt"] ?? positional.join(" "),
    speed,
    mode,
    timeoutSec: flags["timeout"] ? Number(flags["timeout"]) : undefined,
    noFollow: flags["no-follow"] === "true",
    debug: flags["debug"] === "true" || flags["verbose"] === "true" || flags["v"] === "true",
    webhook: flags["webhook"],
  };
}

/**
 * Format a tool call line for --debug stream. Truncates long inputs/outputs
 * so the terminal stays readable, but keeps enough to be useful for debugging.
 */
function formatAction(C: { reset: string; bold: string; dim: string; green: string; red: string }, a: {
  index: number; toolName: string; input: Record<string, unknown> | null; ok: boolean;
  durationMs: number | null; fpAfter: string | null;
}): string {
  const flag = a.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const idx = `${C.dim}[${String(a.index).padStart(2, "0")}]${C.reset}`;
  const tool = `${C.bold}${a.toolName}${C.reset}`;
  const argsRaw = a.input ? JSON.stringify(a.input) : "";
  const argsShort = argsRaw.length > 80 ? argsRaw.slice(0, 77) + "…" : argsRaw;
  const args = argsShort ? ` ${C.dim}${argsShort}${C.reset}` : "";
  const ms = a.durationMs ? ` ${C.dim}${a.durationMs}ms${C.reset}` : "";
  const fp = a.fpAfter ? ` ${C.dim}→${a.fpAfter.slice(0, 8)}${C.reset}` : "";
  return `  ${flag} ${idx} ${tool}${args}${ms}${fp}`;
}

export async function taskCommand(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (!opts.prompt) {
    fail("Missing prompt.");
    info('Usage: auten task [--device <serial>] [--speed lightning|instant|fast] [--no-follow] "<task>"');
    info('Example: auten task --device a4e0eff... --speed lightning "999÷3"');
    process.exit(1);
  }

  const cfg = loadConfig();
  const auten = new Auten(cfg);

  // Resolve device: explicit flag wins; otherwise pick first online phone.
  let serial = opts.serial;
  if (!serial) {
    info("No --device given; querying for the first online phone...");
    const candidate = await auten.devices.firstOnline();
    if (!candidate) {
      fail("No online phone found. Run `auten devices` to list yours.");
      process.exit(1);
    }
    serial = candidate.serial;
    ok(`Using ${serial} (${candidate.model || "?"})`);
  }

  banner("auten task");
  console.log(`${C.dim}Phone:  ${serial}${C.reset}`);
  if (opts.speed) console.log(`${C.dim}Speed:  ${opts.speed}${C.reset}`);
  if (opts.mode) console.log(`${C.dim}Mode:   ${opts.mode}${C.reset}`);
  console.log(`${C.dim}Speed:  ${opts.speed ?? "instant"}${opts.speed ? "" : " (default)"}${C.reset}`);
  console.log(`${C.dim}Prompt: ${opts.prompt.slice(0, 200)}${opts.prompt.length > 200 ? "…" : ""}${C.reset}`);
  console.log("");

  const created = await auten.tasks.create({
    device: serial,
    prompt: opts.prompt,
    speed: opts.speed,
    mode: opts.mode,
    timeout_seconds: opts.timeoutSec,
    webhook_url: opts.webhook,
  });
  ok(`Task ${C.bold}${created.task_id}${C.reset} dispatched.`);
  if (created.watch_url) {
    info(`Live: ${cfg.baseUrl}${created.watch_url}`);
  }
  if (opts.noFollow) {
    console.log("");
    console.log(`Run \`auten tasks ${created.task_id}\` to check status.`);
    return;
  }

  // Poll until done. Print step-by-step progress as the BIOS records turns.
  // With --debug we also poll the per-tool-call audit log and stream each
  // mobile_look / mobile_tap_* etc. as it happens — full visibility into
  // what the agent actually did.
  console.log("");
  if (opts.debug) info(`${C.dim}debug mode — streaming tool calls live${C.reset}`);
  let lastTurnIndex = -1;
  let lastActionIndex = -1;
  let lastStatus = "";
  const start = Date.now();
  const timeoutMs = (opts.timeoutSec ?? 600) * 1000;
  const pollMs = opts.debug ? 500 : 1000;
  while (true) {
    if (Date.now() - start > timeoutMs) {
      warn(`Local follow timed out after ${opts.timeoutSec ?? 600}s — task may still be running.`);
      info(`Check later: auten tasks ${created.task_id}`);
      process.exit(1);
    }
    let task: Task;
    try {
      task = await auten.tasks.get(created.task_id);
    } catch (err) {
      warn(`Status fetch failed: ${(err as Error).message}; retrying...`);
      await sleep(2000);
      continue;
    }

    // Debug: stream new tool calls as they are recorded.
    if (opts.debug) {
      try {
        const { actions } = await auten.tasks.actions(created.task_id);
        for (const a of actions) {
          if (a.index > lastActionIndex) {
            console.log(formatAction(C, a));
            lastActionIndex = a.index;
          }
        }
      } catch {
        /* ignore — actions endpoint may temporarily 5xx during high write rate */
      }
    }

    // Always: stream new high-level turns (cached / delegate / replay).
    if (Array.isArray(task.turns)) {
      for (const t of task.turns) {
        if (t.index > lastTurnIndex) {
          const cost = t.cost_usd ? `${C.dim} $${t.cost_usd.toFixed(4)}${C.reset}` : "";
          const ms = t.duration_ms ? `${C.dim} ${t.duration_ms}ms${C.reset}` : "";
          const flag = t.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
          console.log(`  ${flag} [${t.source}] ${t.label ?? "(no label)"}${cost}${ms}`);
          lastTurnIndex = t.index;
        }
      }
    }
    if (task.status !== lastStatus) {
      lastStatus = task.status;
      info(`status: ${task.status}`);
    }

    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      console.log("");
      const r = task.result ?? null;
      const ms = r?.duration_ms ?? Date.now() - start;
      const cost = r?.cost_usd ?? 0;
      if (task.status === "completed") {
        const verified = r?.verified ?? task.verified;
        if (verified === true) ok(`done ${C.dim}(${ms}ms, $${cost.toFixed(4)})${C.reset} — ${r?.summary ?? ""}`);
        else if (verified === false) warn(`done but verifier flagged failure: ${r?.verify_reason ?? "(no reason)"}`);
        else ok(`done ${C.dim}(${ms}ms, $${cost.toFixed(4)})${C.reset}`);
      } else if (task.status === "cancelled") {
        warn("cancelled");
      } else {
        fail(`failed: ${task.error?.message ?? "(unknown)"}`);
        process.exit(1);
      }

      // Debug: final summary table — counts, fp transitions, verifier reason.
      if (opts.debug) {
        try {
          const { actions } = await auten.tasks.actions(created.task_id);
          const fpHops = actions.filter((a) => a.fpBefore && a.fpAfter && a.fpBefore !== a.fpAfter).length;
          const failed = actions.filter((a) => !a.ok).length;
          const avgPerAction = actions.length > 0 ? Math.round(ms / actions.length) : 0;
          console.log("");
          console.log(`  ${C.bold}── debug summary ──${C.reset}`);
          console.log(`  ${C.dim}speed:${C.reset}      ${opts.speed ?? "instant"}${opts.speed ? "" : " (default)"}`);
          console.log(`  ${C.dim}actions:${C.reset}    ${actions.length} (${failed} failed)`);
          console.log(`  ${C.dim}fp hops:${C.reset}    ${fpHops}`);
          console.log(`  ${C.dim}duration:${C.reset}   ${ms}ms (~${avgPerAction}ms/action)`);
          console.log(`  ${C.dim}cost:${C.reset}       $${cost.toFixed(4)}`);
          if (r?.verify_reason) {
            console.log(`  ${C.dim}verifier:${C.reset}   ${r.verify_reason}`);
          }
          if (!opts.speed && avgPerAction > 400) {
            console.log(`  ${C.dim}hint:${C.reset}       try ${C.bold}--speed lightning${C.reset} (skips per-action look()) for stable UIs like calculators`);
          }
        } catch {
          /* ignore — best-effort summary */
        }
      }
      return;
    }

    await sleep(pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
