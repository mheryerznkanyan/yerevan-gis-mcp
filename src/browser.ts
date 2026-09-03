/**
 * Browser acquisition for the Yandex live-transit scrape.
 *
 * The scrape needs a real Chromium: Yandex signs the vehicle request from its
 * own JS, so we let the page make it. Getting a browser is the single most
 * common reason `get_live_transit` / `get_active_fleet` fail on a fresh clone,
 * so this module makes that as close to automatic as it can be:
 *
 *   0. An explicit binary, if YEREVAN_GIS_BROWSER_PATH points at one.
 *   1. Playwright's own bundled Chromium (what `npm install` downloads).
 *   2. If that's missing, download it once, in-process, and retry.
 *   3. If that fails too (offline, locked-down CI, corporate proxy), fall back
 *      to a browser the machine already has — system Chrome, Chromium or Edge.
 *
 * Only if all three miss do we surface an error, and then with the exact
 * command to fix it.
 *
 *   YEREVAN_GIS_BROWSER_PATH=/path/to/chrome   use this binary, skip the search
 *   YEREVAN_GIS_NO_AUTO_INSTALL=1              never download (step 2 off)
 *
 * ponytail: the download is serialised behind one promise per process, so a
 *   burst of concurrent tool calls on a cold machine triggers exactly one
 *   `playwright install`, not one per call.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/** No browser could be obtained. Carries a fix-it message for the model to relay. */
export class BrowserUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailable";
  }
}

/** Playwright channels tried, in order, when the bundled Chromium is unusable. */
const FALLBACK_CHANNELS = ["chrome", "chromium", "msedge"] as const;

const autoInstallAllowed = () => process.env.YEREVAN_GIS_NO_AUTO_INSTALL !== "1";

/** Anything we print must go to stderr — stdout is the JSON-RPC channel. */
const note = (msg: string) => process.stderr.write(`[yerevan-gis] ${msg}\n`);

async function chromiumApi(): Promise<any> {
  // playwright-core is the declared dependency; full playwright works too if a
  // developer happens to have it installed.
  for (const id of ["playwright-core", "playwright"]) {
    try {
      // @ts-ignore resolved at runtime; the scrape needs no Playwright types
      return (await import(/* @vite-ignore */ id)).chromium;
    } catch {
      /* try the next one */
    }
  }
  throw new BrowserUnavailable(
    "Playwright is missing. It is a regular dependency of this server — " +
      "run `npm install` in the repo root and try again.",
  );
}

/**
 * Path to Playwright's CLI entry point.
 *
 * `require.resolve("playwright-core/cli.js")` does NOT work: the package's
 * "exports" map deliberately omits cli.js, so Node refuses the subpath. Resolve
 * package.json (which *is* exported) and walk to its sibling instead.
 */
function playwrightCli(): string | null {
  for (const pkg of ["playwright-core", "playwright"]) {
    try {
      const cli = join(dirname(require_.resolve(`${pkg}/package.json`)), "cli.js");
      if (existsSync(cli)) return cli;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

let downloadOnce: Promise<boolean> | null = null;

/** `playwright install chromium`, at most once per process. Resolves to success. */
function downloadChromium(): Promise<boolean> {
  downloadOnce ??= new Promise<boolean>((resolve) => {
    const cli = playwrightCli();
    if (!cli) return resolve(false);
    note("Chromium not found — downloading it once (~150 MB, one time only)…");
    // Both streams captured, never inherited: stdout must never touch our
    // JSON-RPC channel, and playwright dumps multi-line network stack traces to
    // stderr on failure — we keep the last meaningful line and drop the rest.
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errTail = "";
    child.stderr?.on("data", (b: Buffer) => {
      const lines = (errTail + b.toString()).split("\n").filter((l) => l.trim());
      errTail = lines[lines.length - 1] ?? errTail; // keep only the latest non-blank line
    });
    child.on("error", (e) => {
      note(`Chromium download failed: ${e.message.split("\n")[0]}`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code === 0) note("Chromium installed.");
      else note(`Chromium download failed${errTail ? `: ${errTail}` : ""}. Everything else still works.`);
      resolve(code === 0);
    });
  });
  return downloadOnce;
}

/**
 * A launched, headless browser — bundled Chromium, auto-downloaded Chromium, or
 * whatever Chrome-family browser the machine already has.
 * @throws BrowserUnavailable when every route fails.
 */
export async function launchChromium(): Promise<any> {
  const chromium = await chromiumApi();
  const tried: string[] = [];

  const oneLine = (err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.split("\n")[0] ?? msg;
  };

  /**
   * Try one browser candidate, then retry it unsandboxed.
   *
   * Chromium's own sandbox cannot start as root or without the right kernel
   * namespaces, which is exactly the situation inside most Docker images and CI
   * runners — it fails with an opaque "Target page, context or browser has been
   * closed". Since this browser only ever loads one Yandex map page under our
   * control, trading the inner sandbox for actually running is the right call —
   * but only as a fallback, never on a normal desktop.
   */
  const attempt = async (opts: Record<string, unknown>, label: string): Promise<any | null> => {
    let first: string;
    try {
      return await chromium.launch({ headless: true, ...opts });
    } catch (err) {
      first = oneLine(err);
    }
    try {
      const browser = await chromium.launch({
        headless: true,
        ...opts,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      note(`${label}: started with --no-sandbox (containerised environment).`);
      return browser;
    } catch (err) {
      // Usually the identical error — report the retry only when it says something new.
      const second = oneLine(err);
      tried.push(second === first ? `${label} — ${first}` : `${label} — ${first}; --no-sandbox — ${second}`);
      return null;
    }
  };

  const explicit = process.env.YEREVAN_GIS_BROWSER_PATH;
  if (explicit) {
    const pinned = await attempt({ executablePath: explicit }, `YEREVAN_GIS_BROWSER_PATH (${explicit})`);
    if (pinned) return pinned;
  }

  const bundled = await attempt({}, "bundled Chromium");
  if (bundled) return bundled;

  if (autoInstallAllowed() && (await downloadChromium())) {
    const fresh = await attempt({}, "bundled Chromium (after download)");
    if (fresh) return fresh;
  }

  for (const channel of FALLBACK_CHANNELS) {
    const system = await attempt({ channel }, `system ${channel}`);
    if (system) {
      note(`Using the system ${channel} install (bundled Chromium unavailable).`);
      return system;
    }
  }

  throw new BrowserUnavailable(
    "No usable browser for the live-transit scrape. Tried the bundled Chromium, an automatic " +
      "download, and any system Chrome/Chromium/Edge.\n" +
      "Fix it with:  npx playwright install chromium\n" +
      "Attempts:\n  " +
      tried.join("\n  "),
  );
}
