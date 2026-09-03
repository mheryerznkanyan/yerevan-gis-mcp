#!/usr/bin/env node
/**
 * postinstall: make sure the live-transit tools have a browser.
 *
 * The Yandex scrape (`get_live_transit`, `get_active_fleet`) drives a headless
 * Chromium. Downloading it here means a plain `git clone && npm install` leaves
 * the server able to answer "how many trolleybuses are running right now?" with
 * no follow-up commands.
 *
 * We depend on `playwright-core` rather than `playwright` precisely so this stays
 * cheap: playwright's own postinstall pulls Chromium *and* Firefox *and* WebKit
 * (~500 MB). playwright-core downloads nothing on its own, so we ask for the one
 * browser we actually use (~150 MB).
 *
 * This must never fail an install. Someone cloning behind a firewall, in a
 * locked-down CI image, or with no network still gets a working server for the
 * other 26 tools — and the transit tools retry the download at call time, then
 * fall back to a system Chrome/Edge (see src/browser.ts).
 *
 *   YEREVAN_GIS_SKIP_BROWSER_DOWNLOAD=1   skip this entirely
 *   --force                               download even if Chromium looks present
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const say = (m) => console.log(`[yerevan-gis] ${m}`);
const force = process.argv.includes("--force");

if (!force && process.env.YEREVAN_GIS_SKIP_BROWSER_DOWNLOAD === "1") {
  say("YEREVAN_GIS_SKIP_BROWSER_DOWNLOAD=1 — not downloading Chromium.");
  process.exit(0);
}

/**
 * Playwright's CLI entry point. `require.resolve("playwright-core/cli.js")`
 * fails — the package's "exports" map omits cli.js — so resolve package.json,
 * which is exported, and walk to its sibling.
 */
function playwrightCli() {
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

const cli = playwrightCli();
if (!cli) {
  say("Playwright is not installed yet — skipping the browser download.");
  say("Run `npm run install:browser` if the live-transit tools report no browser.");
  process.exit(0);
}

// Already there? `playwright install` is idempotent, but skipping the spawn
// keeps a warm `npm install` genuinely instant.
if (!force) {
  try {
    const { chromium } = await import("playwright-core");
    const exe = chromium.executablePath();
    if (exe && existsSync(exe)) {
      say("Chromium already installed — live transit is ready.");
      process.exit(0);
    }
  } catch {
    /* fall through and let the CLI decide */
  }
}

say("Downloading Chromium for the live-transit tools (~150 MB, one time)…");
const r = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });

if (r.status === 0) {
  say("Chromium installed — live transit is ready.");
} else {
  say("Could not download Chromium (offline or blocked). Everything else still works.");
  say("The transit tools will retry on first use, or run: npm run install:browser");
}
process.exit(0); // never fail the install
