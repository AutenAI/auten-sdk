import { Auten } from "../src/index.js";
import { C, loadConfig, fail } from "./util.js";

export async function tasksCommand(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  const auten = new Auten(cfg);

  // If first arg looks like a uuid → show one task. Otherwise list.
  const arg = argv[0];
  if (arg && /^[0-9a-f]{8}-/.test(arg)) {
    return showTask(auten, arg);
  }
  return listTasks(auten, argv);
}

async function listTasks(auten: Auten, argv: string[]): Promise<void> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) {
      flags[a.slice(2)] = argv[++i]!;
    }
  }
  try {
    const list = await auten.tasks.list({
      device: flags["device"],
      status: flags["status"] as never,
      limit: flags["limit"] ? Number(flags["limit"]) : 25,
    });
    if (list.length === 0) {
      console.log(`${C.dim}No tasks yet.${C.reset}`);
      return;
    }
    for (const t of list) {
      const status =
        t.status === "completed" && t.verified ? `${C.green}✓ done${C.reset}` :
        t.status === "completed" ? `${C.yellow}○ done${C.reset}` :
        t.status === "failed" ? `${C.red}✗ fail${C.reset}` :
        t.status === "cancelled" ? `${C.dim}cancel${C.reset}` :
        `${C.cyan}${t.status}${C.reset}`;
      const when = t.completed_at ?? t.created_at ?? "";
      const promptPreview = t.prompt.replace(/\s+/g, " ").slice(0, 80);
      console.log(`  ${status}  ${C.dim}${t.task_id.slice(0, 8)}${C.reset}  ${C.dim}${when?.slice(0, 19)}${C.reset}  ${promptPreview}${t.prompt.length > 80 ? "…" : ""}`);
    }
    console.log(`\n${C.dim}${list.length} task(s).${C.reset}`);
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}

async function showTask(auten: Auten, id: string): Promise<void> {
  try {
    const t = await auten.tasks.get(id);
    console.log(`${C.bold}Task${C.reset}      ${t.task_id}`);
    console.log(`${C.bold}Device${C.reset}    ${t.device_serial}`);
    console.log(`${C.bold}Status${C.reset}    ${t.status}${t.verified === true ? `  ${C.green}(verified)${C.reset}` : t.verified === false ? `  ${C.yellow}(verify failed)${C.reset}` : ""}`);
    console.log(`${C.bold}Prompt${C.reset}    ${t.prompt}`);
    if (t.result?.summary) console.log(`${C.bold}Summary${C.reset}   ${t.result.summary}`);
    if (t.result?.cost_usd != null) console.log(`${C.bold}Cost${C.reset}      $${t.result.cost_usd.toFixed(4)}`);
    if (t.result?.duration_ms != null) console.log(`${C.bold}Duration${C.reset}  ${t.result.duration_ms}ms`);
    if (t.error) console.log(`${C.bold}Error${C.reset}     ${C.red}${t.error.message ?? "(no message)"}${C.reset}`);
    if (t.turns && t.turns.length > 0) {
      console.log(`\n${C.bold}Turns:${C.reset}`);
      for (const turn of t.turns) {
        const flag = turn.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
        console.log(`  ${flag} [${turn.source}] ${turn.label ?? "(no label)"} ${C.dim}$${turn.cost_usd.toFixed(4)} ${turn.duration_ms ?? "?"}ms${C.reset}`);
      }
    }
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}
