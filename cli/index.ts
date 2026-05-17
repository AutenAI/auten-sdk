/**
 * Subcommand router for the `auten` CLI.
 */
import { C, banner } from "./util.js";

const argv = process.argv.slice(2);
const command = argv[0];

async function main() {
  switch (command) {
    case "login": {
      const { loginCommand } = await import("./login.js");
      await loginCommand(argv.slice(1));
      break;
    }
    case "me":
    case "whoami": {
      const { meCommand } = await import("./me.js");
      await meCommand();
      break;
    }
    case "devices":
    case "list":
    case "ls": {
      const { devicesCommand } = await import("./devices.js");
      await devicesCommand();
      break;
    }
    case "task":
    case "run": {
      const { taskCommand } = await import("./task.js");
      await taskCommand(argv.slice(1));
      break;
    }
    case "tasks": {
      const { tasksCommand } = await import("./tasks.js");
      await tasksCommand(argv.slice(1));
      break;
    }
    case "creds":
    case "credentials": {
      const { credsCommand } = await import("./creds.js");
      await credsCommand(argv.slice(1));
      break;
    }
    case "keys": {
      const { keysCommand } = await import("./keys.js");
      await keysCommand(argv.slice(1));
      break;
    }
    case "add-phone":
    case "add": {
      const { addPhoneCommand } = await import("./add-phone.js");
      await addPhoneCommand();
      break;
    }
    case "version":
    case "--version":
    case "-v": {
      const pkg = await import("../package.json", { with: { type: "json" } });
      console.log((pkg.default as { version: string }).version);
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      printUsage();
      break;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  }
}

function printUsage() {
  banner("auten — control Android phones via the Auten relay");
  console.log("");
  console.log("Account:");
  console.log(`  ${C.bold}auten login${C.reset}                    Save API key + relay URL to ~/.autenrc`);
  console.log(`  ${C.bold}auten me${C.reset}                       Show whoami + counts for the calling key`);
  console.log(`  ${C.bold}auten keys${C.reset}                     Manage API keys (ls / create / revoke)`);
  console.log("");
  console.log("Devices:");
  console.log(`  ${C.bold}auten devices${C.reset}                  List devices belonging to your owner`);
  console.log(`  ${C.bold}auten add-phone${C.reset}                Interactive setup for a new phone (USB)`);
  console.log("");
  console.log("Tasks:");
  console.log(`  ${C.bold}auten task "<prompt>"${C.reset}          Dispatch a task and follow until done`);
  console.log(`  ${C.bold}auten tasks${C.reset}                    List recent tasks`);
  console.log(`  ${C.bold}auten tasks <id>${C.reset}               Show one task in detail`);
  console.log("");
  console.log("Credentials:");
  console.log(`  ${C.bold}auten creds add${C.reset}                Save a service login (encrypted server-side)`);
  console.log(`  ${C.bold}auten creds ls${C.reset}                 List saved services`);
  console.log(`  ${C.bold}auten creds rm <service>${C.reset}       Delete a saved service`);
  console.log("");
  console.log(`${C.dim}Auth: AUTEN_API_KEY env var or saved in ~/.autenrc (via login).${C.reset}`);
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal:${C.reset} ${err.message}`);
  process.exit(1);
});
