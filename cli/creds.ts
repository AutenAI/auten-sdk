import { Auten } from "../src/index.js";
import { C, loadConfig, fail, ok, info, prompt, promptHidden, readRc } from "./util.js";

export async function credsCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "add":
    case "save": return addCommand(argv.slice(1));
    case "ls":
    case "list": return listCommand(argv.slice(1));
    case "rm":
    case "delete": return rmCommand(argv.slice(1));
    case "show":
    case "reveal": return showCommand(argv.slice(1));
    case "categories":
    case "cats": return categoriesCommand(argv.slice(1));
    default: {
      console.log(`${C.bold}auten creds${C.reset} — manage encrypted per-device credentials`);
      console.log("");
      console.log("Subcommands:");
      console.log(`  ${C.bold}add${C.reset}         Save service login (interactive)`);
      console.log(`  ${C.bold}ls${C.reset}          List saved services for a device (grouped by category)`);
      console.log(`  ${C.bold}show${C.reset}        Reveal a credential (passwords included)`);
      console.log(`  ${C.bold}rm${C.reset}          Delete a credential`);
      console.log(`  ${C.bold}categories${C.reset}  List distinct categories with counts`);
      console.log("");
      console.log("Common flags:");
      console.log(`  --device <serial>   default: lastSerial from ~/.autenrc, else first online`);
      console.log(`  --category <name>   group label (e.g. \"Shipping lines\", \"Social\")`);
      console.log(`  --all               cross-device (creds ls / categories)`);
    }
  }
}

async function resolveSerial(auten: Auten, override?: string): Promise<string> {
  if (override) return override;
  const rc = readRc();
  if (rc.lastSerial) return rc.lastSerial;
  const fo = await auten.devices.firstOnline();
  if (!fo) {
    fail("No --device passed and no online phone found.");
    process.exit(1);
  }
  return fo.serial;
}

function flagOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return argv[i + 1];
}

/** Return positional (non-flag) args, skipping flag values too. */
function positional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      // Skip this flag plus the next token if it isn't a flag itself.
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

async function addCommand(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  const auten = new Auten(cfg);
  const serial = await resolveSerial(auten, flagOf(argv, "device"));

  const service = (flagOf(argv, "service")
    ?? positional(argv)[0]
    ?? await prompt("Service: ")).trim();
  if (!service) { fail("service required"); process.exit(1); }

  const username = (flagOf(argv, "username") ?? await prompt("Username/email: ")).trim();
  const password = flagOf(argv, "password") ?? await promptHidden("Password: ");
  const notes = flagOf(argv, "notes");
  const category = flagOf(argv, "category");

  try {
    await auten.phone(serial).credentials.save({
      service,
      username: username || undefined,
      password: password || undefined,
      notes: notes || undefined,
      category: category && category.trim().length > 0 ? category.trim() : undefined,
    });
    const tail = category ? ` (${C.dim}${category}${C.reset})` : "";
    ok(`Saved ${C.bold}${service}${C.reset} on ${serial}${tail}.`);
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}

async function listCommand(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  const auten = new Auten(cfg);
  const all = argv.includes("--all");
  const category = flagOf(argv, "category");
  const filter = category !== undefined ? { category } : {};

  try {
    const creds = all
      ? await auten.credentials.list(filter)
      : await auten.phone(await resolveSerial(auten, flagOf(argv, "device"))).credentials.list(filter);
    if (creds.length === 0) {
      info(all ? "No credentials saved." : "No credentials saved for this device.");
      return;
    }
    // Group by category — null bucket renders as "(uncategorised)".
    const groups = new Map<string, typeof creds>();
    for (const c of creds) {
      const k = c.category ?? "";
      const arr = groups.get(k) ?? [];
      arr.push(c);
      groups.set(k, arr);
    }
    const keys = Array.from(groups.keys()).sort((a, b) => {
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b);
    });
    for (const k of keys) {
      const label = k === "" ? `${C.dim}(uncategorised)${C.reset}` : `${C.bold}${k}${C.reset}`;
      console.log(`\n  ${label}`);
      for (const c of groups.get(k)!) {
        const dev = all ? `  ${C.dim}[${c.deviceSerial.slice(0, 8)}]${C.reset}` : "";
        console.log(`    ${C.dim}${c.id}${C.reset}  ${C.bold}${c.service}${C.reset}${dev}  ${C.dim}${c.username ?? "(no user)"}  ${c.updatedAt.slice(0, 19)}${C.reset}`);
        if (c.notes) console.log(`      ${C.dim}${c.notes}${C.reset}`);
      }
    }
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}

async function categoriesCommand(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  const auten = new Auten(cfg);
  const all = argv.includes("--all");
  try {
    const cats = all
      ? await auten.credentials.categories()
      : await auten.phone(await resolveSerial(auten, flagOf(argv, "device"))).credentials.categories();
    if (cats.length === 0) {
      info("No categories yet — pass --category when saving a credential.");
      return;
    }
    for (const c of cats) {
      console.log(`  ${C.bold}${c.name}${C.reset}  ${C.dim}(${c.count})${C.reset}`);
    }
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}

async function showCommand(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  const auten = new Auten(cfg);
  const serial = await resolveSerial(auten, flagOf(argv, "device"));
  const service = flagOf(argv, "service") ?? positional(argv)[0];
  if (!service) { fail("service required"); process.exit(1); }
  try {
    const data = await auten.phone(serial).credentials.reveal<Record<string, unknown>>(service);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}

async function rmCommand(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  const auten = new Auten(cfg);
  // Accept either --id <uuid> / positional UUID, or a service name.
  // UUID auto-detection means `auten creds rm <id>` and `auten creds rm <service>`
  // both work without an explicit flag.
  const idFlag = flagOf(argv, "id");
  const target = idFlag ?? flagOf(argv, "service") ?? positional(argv)[0];
  if (!target) { fail("service or --id required"); process.exit(1); }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
  try {
    if (isUuid || idFlag) {
      await auten.credentials.deleteById(target);
      ok(`Deleted credential ${target}.`);
    } else {
      const serial = await resolveSerial(auten, flagOf(argv, "device"));
      await auten.phone(serial).credentials.delete(target);
      ok(`Deleted ${target} on ${serial}.`);
    }
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}
