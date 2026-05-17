/**
 * Walk the user through adding a new phone:
 *   USB plug-in → ADB authorization → APK install → service config → WS verify.
 *
 * Uses the SDK to verify the WS connection appears against the relay.
 */
import { execFileSync } from "child_process";
import { existsSync, statSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir, tmpdir } from "os";
import { Auten } from "../src/index.js";
import { C, banner, step, ok, warn, info, fail, sleep, loadConfig } from "./util.js";

const PACKAGE = "com.sce.agent";

function adb(args: string[], timeoutMs = 10_000): string {
  return execFileSync("adb", args, { encoding: "utf-8", timeout: timeoutMs }).trim();
}

interface AdbDevice { serial: string; status: string }

function adbDevices(): AdbDevice[] {
  return adb(["devices"]).split("\n").slice(1)
    .map(l => l.trim()).filter(Boolean)
    .map(l => { const [serial, status] = l.split(/\s+/); return { serial, status }; });
}

function getDeviceInfo(serial: string) {
  const prop = (k: string) => adb(["-s", serial, "shell", "getprop", k]).trim();
  const model = prop("ro.product.model");
  const androidVersion = prop("ro.build.version.release");
  const sizeOut = adb(["-s", serial, "shell", "wm", "size"]);
  const m = sizeOut.match(/(\d+)x(\d+)/);
  const ipOut = adb(["-s", serial, "shell", "ip", "route"]);
  const ipLine = ipOut.split("\n").find(l => l.includes("wlan0") && l.includes("src")) || "";
  const tokens = ipLine.split(/\s+/);
  const srcIdx = tokens.indexOf("src");
  return {
    serial,
    model,
    androidVersion,
    screenWidth: m ? parseInt(m[1], 10) : 0,
    screenHeight: m ? parseInt(m[2], 10) : 0,
    wifiIp: srcIdx >= 0 && tokens[srcIdx + 1] ? tokens[srcIdx + 1] : "",
  };
}

/**
 * Resolve which APK to install:
 *   1. APK_PATH env (dev override — used when iterating locally on APK source)
 *   2. Relay's /apk/latest — version-aware. Caches per versionCode under
 *      ~/.auten/apk/ so repeat runs don't redownload, but a relay-side
 *      version bump triggers a fresh pull automatically.
 */
async function resolveApk(baseUrl: string): Promise<string | null> {
  if (process.env.APK_PATH && existsSync(process.env.APK_PATH)) {
    info(`Using APK from APK_PATH env: ${process.env.APK_PATH}`);
    return process.env.APK_PATH;
  }

  const cacheDir = resolve(homedir(), ".auten/apk");
  mkdirSync(cacheDir, { recursive: true });

  // Ask the relay what it currently serves.
  let remoteVersionCode: number | null = null;
  let remoteVersion = "";
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/apk/latest/version`);
    if (res.ok) {
      const meta = await res.json() as { version?: string; versionCode?: number };
      remoteVersionCode = typeof meta.versionCode === "number" ? meta.versionCode : null;
      remoteVersion = meta.version ?? "";
    }
  } catch {
    /* fall through to legacy cache fallback below */
  }

  const versionedPath = remoteVersionCode
    ? resolve(cacheDir, `auten-agent-v${remoteVersionCode}.apk`)
    : null;
  const legacyPath = resolve(cacheDir, "auten-agent.apk");

  if (versionedPath && existsSync(versionedPath)) {
    info(`Using cached APK v${remoteVersion} (${remoteVersionCode}).`);
    return versionedPath;
  }

  // Download from relay.
  try {
    info(`Downloading APK${remoteVersion ? ` v${remoteVersion}` : ""} from relay...`);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/apk/latest`);
    if (!res.ok) {
      warn(`Relay returned ${res.status} for /apk/latest`);
      // Last resort — a previously cached unversioned APK may still work.
      return existsSync(legacyPath) ? legacyPath : null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = versionedPath ?? legacyPath;
    writeFileSync(dest, buf);
    ok(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    return dest;
  } catch (err) {
    warn(`APK download failed: ${(err as Error).message}`);
    return existsSync(legacyPath) ? legacyPath : null;
  }
}

function installApk(serial: string, apkPath: string) {
  try {
    const out = execFileSync("adb", ["-s", serial, "install", "-r", apkPath], { encoding: "utf-8", timeout: 120_000 });
    if (out.includes("Success")) return { ok: true as const };
    return { ok: false as const, reinstallNeeded: false, error: out };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const msg = String(e.stderr || e.stdout || e.message || "");
    if (msg.includes("INSTALL_FAILED_UPDATE_INCOMPATIBLE") || msg.includes("signatures do not match")) {
      return { ok: false as const, reinstallNeeded: true, error: msg };
    }
    return { ok: false as const, reinstallNeeded: false, error: msg };
  }
}

async function enableIme(serial: string): Promise<boolean> {
  // Right after install, Android's PackageManager hasn't necessarily indexed
  // the new IME yet — `ime enable` fails with "Unknown input method ...".
  // Retry a handful of times with short waits.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      adb(["-s", serial, "shell", "ime", "enable", `${PACKAGE}/.AgentIME`]);
      adb(["-s", serial, "shell", "ime", "set", `${PACKAGE}/.AgentIME`]);
      return true;
    } catch {
      if (attempt < 5) await sleep(1500);
    }
  }
  return false;
}

/**
 * Make the headless AgentIME the *only* enabled IME. Anything else (Samsung
 * keyboard, Gboard, SwiftKey, vendor input apps) can reclaim the slot or
 * still draw its UI on focus, blocking the agent's view of the screen.
 *
 * Strategy: list every enabled IME via `ime list -s`, then disable each
 * one that isn't AgentIME. This is dynamic and survives unknown vendor IMEs.
 */
function lockAgentImeAsDefault(serial: string): void {
  const agentIme = `${PACKAGE}/.AgentIME`;
  let enabled: string[] = [];
  try {
    enabled = adb(["-s", serial, "shell", "ime", "list", "-s"])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    // Older Android shells use a different `ime list` shape — fall back to a
    // hardcoded vendor list.
    enabled = [
      "com.samsung.android.honeyboard/.service.HoneyBoardService",
      "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME",
      "com.touchtype.swiftkey/com.touchtype.KeyboardService",
    ];
  }
  for (const id of enabled) {
    if (id === agentIme) continue;
    try { adb(["-s", serial, "shell", "ime", "disable", id]); } catch {}
  }
  // Re-assert default after disabling siblings so Android can't fall back.
  try { adb(["-s", serial, "shell", "ime", "set", agentIme]); } catch {}

  // Belt-and-braces: write the secure setting directly. Some OEM ROMs ignore
  // `ime set` if their own input app aggressively re-registers itself.
  try {
    adb(["-s", serial, "shell", "settings", "put", "secure", "default_input_method", agentIme]);
    adb(["-s", serial, "shell", "settings", "put", "secure", "enabled_input_methods", agentIme]);
    adb(["-s", serial, "shell", "settings", "put", "secure", "selected_input_method_subtype", "0"]);
  } catch {}
}

function verifyAgentImeActive(serial: string): boolean {
  try {
    const current = adb(["-s", serial, "shell", "settings", "get", "secure", "default_input_method"]);
    return current.includes(`${PACKAGE}/.AgentIME`);
  } catch {
    return false;
  }
}

async function configureServices(serial: string): Promise<{ imeOk: boolean }> {
  adb(["-s", serial, "shell", "settings", "put", "secure", "enabled_accessibility_services",
       `${PACKAGE}/${PACKAGE}.AgentAccessibilityService`]);
  adb(["-s", serial, "shell", "settings", "put", "secure", "accessibility_enabled", "1"]);

  const imeOk = await enableIme(serial);

  if (imeOk) {
    lockAgentImeAsDefault(serial);
    // One retry if the OEM IME service races us back to default.
    if (!verifyAgentImeActive(serial)) {
      await sleep(800);
      lockAgentImeAsDefault(serial);
    }
  }

  for (const perm of ["android.permission.WRITE_EXTERNAL_STORAGE", "android.permission.READ_EXTERNAL_STORAGE"]) {
    try { adb(["-s", serial, "shell", "pm", "grant", PACKAGE, perm]); } catch {}
  }
  return { imeOk: imeOk && verifyAgentImeActive(serial) };
}

/**
 * After a WS timeout, look at what the phone is actually doing — saves the
 * user from having to grep `adb logcat` themselves.
 *
 * We check three layers, top → bottom:
 *   1. Is the APK process running at all?
 *   2. What relay URL did the APK try to connect to, and what was the error?
 *   3. Can the phone itself reach the relay host (DNS + TCP)?
 */
function diagnoseConnection(serial: string, configuredRelay: string): void {
  console.log("");
  info("Diagnostics:");

  // 1. Is the APK running?
  let pid = "";
  try {
    pid = adb(["-s", serial, "shell", "pidof", PACKAGE]).trim();
  } catch {}
  if (!pid) {
    warn(`  · APK ${PACKAGE} is NOT running on the phone.`);
    info("    Fix: open the SCE Agent app on the phone once (tap the icon).");
    info("    Or: Settings → Accessibility → Auten Agent → toggle off+on.");
    return;
  }
  ok(`  · APK process running (pid ${pid}).`);

  // 2. Pull the last minute of APK logs and look for relay/ws lines.
  let logs = "";
  try {
    logs = adb(
      ["-s", serial, "logcat", "-d", "-t", "300", `--pid=${pid}`],
      30_000,
    );
  } catch {}

  const wsLines = logs
    .split("\n")
    .filter((l) => /relay|wss?:\/\/|websocket|connect|onFailure|SSLHandshake|UnknownHost|Connection|onClosed|onOpen/i.test(l))
    .slice(-8);

  if (wsLines.length) {
    info("  · Last APK WS log lines:");
    for (const l of wsLines) console.log(`      ${C.dim}${l.slice(0, 180)}${C.reset}`);
  } else {
    warn("  · No WS-related log lines in the last 300 messages from the APK.");
    info("    The APK may not be attempting to connect — check that the Accessibility");
    info("    service is enabled (Settings → Accessibility → Auten Agent).");
  }

  // 3. Can the phone itself reach the relay host?
  try {
    const host = new URL(configuredRelay).hostname;
    const ping = adb(["-s", serial, "shell", "ping", "-c", "1", "-W", "3", host], 6000);
    if (/0% packet loss|1 received/i.test(ping)) {
      ok(`  · Phone can reach ${host} (ICMP).`);
    } else {
      warn(`  · Phone cannot reach ${host}:`);
      console.log(`      ${C.dim}${ping.slice(0, 200)}${C.reset}`);
      info("    Fix: make sure phone WiFi is on and the network isn't behind a captive portal.");
    }
  } catch (e) {
    warn(`  · Could not test phone → relay reachability: ${(e as Error).message.slice(0, 120)}`);
  }

  // 4. Hint about Accessibility — most common silent failure
  try {
    const a11y = adb([
      "-s", serial, "shell", "settings", "get", "secure", "enabled_accessibility_services",
    ]).trim();
    if (!a11y.includes(PACKAGE)) {
      warn("  · Auten Agent accessibility service is NOT enabled.");
      info("    Fix: Settings → Accessibility → Auten Agent → toggle ON.");
    } else {
      ok("  · Accessibility service is enabled.");
    }
  } catch {}

  console.log("");
}

function forceRestartApk(serial: string) {
  // Toggle accessibility off then on so Android rebinds the service after force-stop.
  try { adb(["-s", serial, "shell", "am", "force-stop", PACKAGE]); } catch {}
  adb(["-s", serial, "shell", "settings", "put", "secure", "accessibility_enabled", "0"]);
  adb(["-s", serial, "shell", "settings", "put", "secure", "enabled_accessibility_services",
       `${PACKAGE}/${PACKAGE}.AgentAccessibilityService`]);
  adb(["-s", serial, "shell", "settings", "put", "secure", "accessibility_enabled", "1"]);

  // Android 10+ keeps freshly-installed packages in a "stopped" state until
  // the user opens them once — services/broadcasts can't start until then.
  // We need to "open" the app, but without leaving the Setup wizard visible
  // on the user's screen.
  //
  // Trick: launch the Activity with --include-stopped-packages + NO_ANIMATION
  // (lifts the stopped flag), then immediately press HOME so the wizard goes
  // straight to the background. Brief flash on screen (~100 ms) is the price.
  try {
    adb([
      "-s", serial, "shell", "am", "start", "--user", "0",
      "--include-stopped-packages",
      "-f", "0x10000000", // FLAG_ACTIVITY_NEW_TASK
      "-a", "android.intent.action.MAIN",
      "-n", `${PACKAGE}/.SetupActivity`,
    ]);
    // Tiny sleep so Android actually has time to register the Activity start
    // before we shove it to the back.
    execFileSync("sh", ["-c", "sleep 0.4"], { timeout: 1000 });
    adb(["-s", serial, "shell", "input", "keyevent", "KEYCODE_HOME"]);
  } catch {}

  // Battery optimisation kills long-lived foreground services on Samsung —
  // whitelist us so the WS stays up. Requires REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
  // permission in the manifest; falls back silently if denied.
  try {
    adb(["-s", serial, "shell", "dumpsys", "deviceidle", "whitelist", `+${PACKAGE}`]);
  } catch {}
}

/**
 * Wait until the WS-bearing process (AgentAccessibilityService) is up. On
 * fresh installs Android takes 2–10 s after our accessibility-toggle dance
 * before the service is actually re-bound. Polling here gives the user a
 * sharper error if the service refuses to start at all.
 */
async function waitForApkRunning(serial: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = adb(["-s", serial, "shell", "pidof", PACKAGE]).trim();
      if (pid) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function waitForDevice(): Promise<AdbDevice> {
  let prompted = false;
  while (true) {
    const devs = adbDevices();
    if (devs.length === 0) {
      if (!prompted) {
        warn("No phone detected.");
        info("Plug in the phone via USB.");
        info("Settings → About phone → tap 'Build number' 7 times to unlock Developer options.");
        info("Settings → Developer options → enable 'USB debugging'.");
        info("Waiting...");
        prompted = true;
      }
    } else if (devs.length > 1) {
      fail(`Multiple phones detected: ${devs.map(d => d.serial).join(", ")}`);
      fail("Connect only one phone at a time.");
      process.exit(1);
    } else {
      return devs[0];
    }
    await sleep(2000);
  }
}

async function waitForAuthorization(serial: string) {
  let prompted = false;
  while (true) {
    const d = adbDevices().find(x => x.serial === serial);
    if (!d) throw new Error(`Phone ${serial} disconnected.`);
    if (d.status === "device") return;
    if (d.status === "unauthorized" && !prompted) {
      warn("Authorization required.");
      info("Unlock the phone, accept the 'Allow USB debugging' dialog, check 'Always allow'.");
      info("Waiting...");
      prompted = true;
    } else if (d.status !== "unauthorized" && d.status !== "device") {
      fail(`Phone state '${d.status}' — try replugging USB.`);
      process.exit(1);
    }
    await sleep(2000);
  }
}

export async function addPhoneCommand(): Promise<void> {
  const cfg = loadConfig();
  banner("═════════════════════════════════════");
  banner("  auten — Add Phone");
  banner("═════════════════════════════════════");

  try { execFileSync("adb", ["version"], { encoding: "utf-8", timeout: 3000 }); }
  catch { fail("`adb` not found. Install Android platform-tools."); process.exit(1); }

  const apkPath = await resolveApk(cfg.baseUrl);
  if (!apkPath) {
    fail("APK not available.");
    info("The relay's /apk/latest endpoint is unreachable and no cached APK exists.");
    info("Check your internet connection, then try again. Override with APK_PATH=/path/to/app-debug.apk for offline use.");
    process.exit(1);
  }
  const apkAge = (Date.now() - statSync(apkPath).mtimeMs) / 1000 / 86400;
  if (apkAge > 90) warn(`Cached APK is ${apkAge.toFixed(0)} days old — re-download might bring fixes.`);

  step(1, 6, "Detect connected phone");
  const dev = await waitForDevice();
  ok(`Phone detected: ${dev.serial}`);

  step(2, 6, "Authorize USB debugging");
  if (dev.status === "device") ok("Already authorized.");
  else { await waitForAuthorization(dev.serial); ok("Authorized."); }

  step(3, 6, "Read device info");
  const dInfo = getDeviceInfo(dev.serial);
  ok(`Model: ${dInfo.model} (Android ${dInfo.androidVersion})`);
  ok(`Screen: ${dInfo.screenWidth}x${dInfo.screenHeight}`);
  if (dInfo.wifiIp) ok(`WiFi IP: ${dInfo.wifiIp}`);
  else warn("No WiFi IP detected — connect the phone to WiFi for the agent to reach the relay.");

  step(4, 6, "Install APK");
  let installResult = installApk(dev.serial, apkPath);
  if (!installResult.ok && installResult.reinstallNeeded) {
    warn("Existing install was signed with a different key — uninstalling and reinstalling.");
    warn("Any data inside the SCE Agent app will be wiped.");
    try { adb(["-s", dev.serial, "uninstall", PACKAGE]); } catch {}
    installResult = installApk(dev.serial, apkPath);
  }
  if (!installResult.ok) {
    fail(`Install failed: ${installResult.error?.slice(0, 300)}`);
    process.exit(1);
  }
  ok("APK installed.");

  step(5, 6, "Enable accessibility, IME, permissions");
  const svc = await configureServices(dev.serial);
  forceRestartApk(dev.serial);
  const apkUp = await waitForApkRunning(dev.serial);
  if (!apkUp) {
    warn("APK process didn't come up in 15 s after restart.");
    info("Trying one more nudge…");
    try {
      adb(["-s", dev.serial, "shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"]);
    } catch {}
    await sleep(2500);
  }
  if (svc.imeOk) {
    ok("Services configured. APK restarted.");
  } else {
    warn("Accessibility OK, IME enable failed (PackageManager lag — common on Samsung).");
    info("Enable later: Settings → Languages → Manage keyboards → Auten Agent.");
    info("APK still works for taps/scrolls/launches; only typed-text input falls back to slower paths.");
  }

  step(6, 6, "Verify WS connection to relay");
  info(`Polling the relay for an online device matching '${dInfo.model}'... (up to 20s)`);
  const agent = new Auten(cfg);
  const deadline = Date.now() + 20_000;
  let online: { serial: string } | null = null;
  let lastError: Error | null = null;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const list = await agent.devices.list();
      const candidate = list.find(d => d.online && d.model === dInfo.model);
      if (candidate) { online = { serial: candidate.serial }; break; }
      // Show heartbeat every 5s so the user knows we're still trying.
      if (attempt % 3 === 0) {
        info(`Still polling... (${Math.round((Date.now() - (deadline - 20_000)) / 1000)}s elapsed)`);
      }
    } catch (err) {
      lastError = err as Error;
      info(`Relay query failed: ${lastError.message} — retrying...`);
    }
    await sleep(2000);
  }
  if (!online) {
    fail("Phone did not appear online via WS within 20s.");
    diagnoseConnection(dev.serial, cfg.baseUrl);
    // Network errors here usually mean the saved relay URL is stale.
    const networkSmell = lastError && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|getaddrinfo/i.test(lastError.message);
    if (networkSmell) {
      warn("The relay is unreachable from your laptop.");
      info("Your ~/.autenrc may point to an old relay (delete it, then run `auten login`).");
    }
    process.exit(1);
  }
  ok(`Phone online: ${online.serial}`);

  info("Round-tripping /look to confirm end-to-end flow...");
  try {
    const phone = agent.phone(online.serial);
    const look = await phone.look();
    ok(`/look returned ${look.elements.length} elements, ~${Math.round(look.annotated.length * 0.75 / 1024)} KB JPEG. End-to-end working.`);
  } catch (err) {
    warn(`/look round-trip failed: ${(err as Error).message}`);
    warn("WS connection is up but the phone could not return a screenshot. Investigate manually.");
  }

  console.log("");
  banner("═════════════════════════════════════");
  banner("  ✓ Phone ready — disconnect USB now");
  banner("═════════════════════════════════════");
  console.log("");
  console.log(`  Device serial:   ${C.bold}${online.serial}${C.reset}`);
  console.log(`  Model:           ${dInfo.model}`);
  console.log("");
  console.log(`  ${C.dim}The phone keeps its connection over WiFi as long as the Auten Agent app is alive.${C.reset}`);
  console.log("");
}
