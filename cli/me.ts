import { Auten } from "../src/index.js";
import { C, loadConfig, fail } from "./util.js";

function fmtLimit(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n === -1) return "∞";
  return n.toLocaleString();
}

function pct(used: number, limit: number): number | null {
  if (limit <= 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

function bar(used: number, limit: number, width = 20): string {
  if (limit <= 0) return "─".repeat(width);
  const filled = Math.min(width, Math.round((used / limit) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export async function meCommand(): Promise<void> {
  const cfg = loadConfig();
  try {
    const auten = new Auten(cfg);
    const me = await auten.me();

    console.log("");
    console.log(`${C.bold}Owner${C.reset}     ${me.owner_id}${me.is_root ? `  ${C.yellow}(root)${C.reset}` : ""}`);
    console.log(`${C.bold}Key ID${C.reset}    ${me.key_id}`);

    if (me.plan) {
      console.log("");
      console.log(`${C.bold}Plan${C.reset}      ${C.green}${me.plan}${C.reset}`);
    }

    if (me.limits && me.usage) {
      console.log("");
      const phonesPct = pct(me.usage.phones, me.limits.phones);
      const phonesLine =
        `${C.dim}Phones${C.reset}        ` +
        `${bar(me.usage.phones, me.limits.phones)}  ` +
        `${me.usage.phones} / ${fmtLimit(me.limits.phones)}` +
        (phonesPct !== null ? `  ${C.dim}(${phonesPct}%)${C.reset}` : "");
      console.log(phonesLine);

      const clicksPct = pct(me.usage.clicks_this_month, me.limits.clicks_per_month);
      const clicksLine =
        `${C.dim}Clicks (mo)${C.reset}   ` +
        `${bar(me.usage.clicks_this_month, me.limits.clicks_per_month)}  ` +
        `${me.usage.clicks_this_month.toLocaleString()} / ${fmtLimit(me.limits.clicks_per_month)}` +
        (clicksPct !== null ? `  ${C.dim}(${clicksPct}%)${C.reset}` : "");
      console.log(clicksLine);

      if (me.usage.month_start) {
        const reset = new Date(me.usage.month_start);
        const nextReset = new Date(Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() + 1, 1));
        console.log(`${C.dim}Resets on${C.reset}     ${nextReset.toISOString().slice(0, 10)}`);
      }
    } else {
      // Fallback for older relays that don't return plan info yet.
      console.log("");
      console.log(`${C.bold}Devices${C.reset}   ${me.device_count}`);
      console.log(`${C.bold}Tasks${C.reset}     ${me.task_count}`);
    }
    console.log("");
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}
