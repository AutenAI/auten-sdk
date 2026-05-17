import { Auten } from "../src/index.js";
import { C, loadConfig, fail, ok, info, prompt } from "./util.js";

export async function keysCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "ls":
    case "list":
    case undefined:
      return listKeys();
    case "create":
    case "new":
    case "add":
      return createKey(argv.slice(1));
    case "rm":
    case "revoke":
    case "delete":
      return revokeKey(argv.slice(1));
    default: {
      console.log(`${C.bold}auten keys${C.reset} — manage API keys for your account`);
      console.log("");
      console.log("Subcommands:");
      console.log(`  ${C.bold}ls${C.reset}              List your keys (no full secrets shown)`);
      console.log(`  ${C.bold}create [name]${C.reset}   Mint a new key — secret printed once`);
      console.log(`  ${C.bold}revoke <id>${C.reset}     Disable a key (invalidates instantly)`);
    }
  }
}

async function listKeys(): Promise<void> {
  const cfg = loadConfig();
  const auten = new Auten(cfg);
  try {
    const keys = await auten.keys.list();
    if (keys.length === 0) {
      info("No keys yet.");
      return;
    }
    for (const k of keys) {
      const status = k.active ? `${C.green}active${C.reset}` : `${C.dim}revoked${C.reset}`;
      const lastUsed = k.last_used_at ? k.last_used_at.slice(0, 19) : "never";
      console.log(`  ${status}  ${C.dim}${k.id}${C.reset}  ${k.name ?? "(unnamed)"}  ${C.dim}${k.key_preview}  used: ${lastUsed}${C.reset}`);
    }
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}

async function createKey(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  const auten = new Auten(cfg);
  const name = argv.find((a) => !a.startsWith("--")) ?? (await prompt("Key name (e.g. laptop, ci): ")).trim();
  const ownerFlag = argv.indexOf("--owner");
  const ownerId = ownerFlag >= 0 ? argv[ownerFlag + 1] : undefined;
  try {
    const created = await auten.keys.create({ name: name || undefined, ownerId });
    console.log("");
    ok(`Key created.`);
    console.log(`  ${C.bold}id${C.reset}     ${created.id}`);
    console.log(`  ${C.bold}name${C.reset}   ${created.name ?? "(unnamed)"}`);
    console.log(`  ${C.bold}owner${C.reset}  ${created.owner_id}`);
    console.log("");
    console.log(`  ${C.bold}${C.green}${created.key}${C.reset}`);
    console.log("");
    console.log(`${C.yellow}Save this key now — it will never be shown again.${C.reset}`);
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}

async function revokeKey(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  const auten = new Auten(cfg);
  const id = argv[0];
  if (!id) { fail("Usage: auten keys revoke <id>"); process.exit(1); }
  try {
    await auten.keys.revoke(id);
    ok(`Revoked ${id}.`);
  } catch (err) {
    fail((err as Error).message);
    process.exit(1);
  }
}
