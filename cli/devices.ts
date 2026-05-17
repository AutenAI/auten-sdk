import { Auten } from "../src/index.js";
import type { Device } from "../src/index.js";
import { C, loadConfig, fail } from "./util.js";

export async function devicesCommand(): Promise<void> {
  const cfg = loadConfig();
  try {
    const auten = new Auten(cfg);
    const list = await auten.devices.list();
    if (list.length === 0) {
      console.log(`${C.dim}No devices registered for this owner yet.${C.reset}`);
      console.log(`${C.dim}Run \`auten add-phone\` with a phone connected via USB to add one.${C.reset}`);
      return;
    }
    const rows = list
      .slice()
      .sort((a, b) => Number(b.online) - Number(a.online) || a.serial.localeCompare(b.serial))
      .map((d: Device) => ({
        status: d.online ? `${C.green}online${C.reset}` : `${C.dim}offline${C.reset}`,
        serial: d.serial,
        model: d.model || "?",
        screen: d.screenW && d.screenH ? `${d.screenW}x${d.screenH}` : "?",
        lastSeen: d.lastSeenAt ? d.lastSeenAt.replace("T", " ").slice(0, 19) : "?",
      }));
    const cols = ["status", "serial", "model", "screen", "lastSeen"] as const;
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => stripAnsi(r[c]).length)));
    const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stripAnsi(s).length));
    console.log(cols.map((c, i) => pad(c.toUpperCase(), widths[i]!)).join("  "));
    console.log(cols.map((_, i) => "─".repeat(widths[i]!)).join("  "));
    for (const r of rows) console.log(cols.map((c, i) => pad(r[c], widths[i]!)).join("  "));
    console.log(`\n${C.dim}${list.length} device(s) total, ${list.filter((d) => d.online).length} online.${C.reset}`);
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}
