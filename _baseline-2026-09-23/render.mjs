// Headless-Edge DOM dump: lets the audit see pages that render their content with
// JavaScript instead of shipping it in the initial HTML. Runs Edge with --dump-dom
// and a virtual time budget so it does not hang waiting for network idle forever.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EDGE } from "./lib.mjs";

export function renderAvailable() {
  return !!EDGE && existsSync(EDGE);
}

export async function renderDom(url, { timeoutMs = 30000 } = {}) {
  if (!renderAvailable()) return null;
  let profileDir;
  try {
    profileDir = mkdtempSync(join(tmpdir(), "seo-audit-edge-"));
  } catch {
    return null;
  }
  try {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      "--virtual-time-budget=8000",
      "--run-all-compositor-stages-before-draw",
      `--timeout=${timeoutMs}`,
      "--dump-dom",
      url,
    ];
    const out = execFileSync(EDGE, args, {
      encoding: "utf8",
      maxBuffer: 60e6,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // A connection failure does not make Edge exit nonzero: --dump-dom happily prints
    // Chromium's own interstitial ("can't be reached") as valid, well-formed HTML. That
    // page always carries a net error code (ERR_CONNECTION_REFUSED, ERR_NAME_NOT_RESOLVED,
    // ERR_UNSAFE_PORT, and so on), which real site markup does not, so it is the tell.
    if (out && out.length > 200 && /<html/i.test(out) && !/\bERR_[A-Z_]{6,}\b/.test(out)) return out;
    return null;
  } catch {
    return null;
  } finally {
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------- self-test ----------
// The test server has to live in its own process: renderDom shells out with execFileSync,
// which blocks this process's event loop for the duration of the Edge run, so an in-process
// server here could never answer Edge's request while the test itself is waiting on it.
if (process.argv.includes("--selftest")) {
  const { spawn } = await import("node:child_process");
  const { writeFileSync, mkdtempSync: mkdtemp, rmSync: rm } = await import("node:fs");

  // Padded with a comment past 200 chars: that is renderDom's own floor for a page it trusts,
  // so a shorter fixture would be rejected as noise regardless of whether Edge rendered it.
  const PAGE = "<html><!-- " + "padding ".repeat(30) + "--><body><div id=\"app\"></div><script>document.getElementById(\"app\").textContent=\"RENDERED OK \" + (2+2)</script></body></html>";
  const SERVER_SRC = `import { createServer } from "node:http";
const PAGE = ${JSON.stringify(PAGE)};
const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
server.listen(0, "localhost", () => console.log("PORT " + server.address().port));`;

  const results = [];
  const check = (name, pass) => {
    results.push({ name, pass });
    console.log((pass ? "PASS" : "FAIL") + " " + name);
  };

  const workDir = mkdtemp(join(tmpdir(), "seo-audit-selftest-"));
  const serverFile = join(workDir, "srv.mjs");
  writeFileSync(serverFile, SERVER_SRC);
  const child = spawn(process.execPath, [serverFile], { stdio: ["ignore", "pipe", "ignore"] });

  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const onData = d => {
      buf += d.toString();
      const m = buf.match(/PORT (\d+)/);
      if (m) { child.stdout.off("data", onData); resolve(+m[1]); }
    };
    child.stdout.on("data", onData);
    child.on("exit", () => reject(new Error("test server exited early")));
    setTimeout(() => reject(new Error("test server did not report a port in time")), 5000);
  });

  try {
    check("renderAvailable() is true", renderAvailable());

    const html = await renderDom(`http://localhost:${port}/`);
    check("renderDom returns rendered content", !!html && html.includes("RENDERED OK 4"));

    const t0 = Date.now();
    const dead = await renderDom("http://localhost:1/", { timeoutMs: 10000 });
    const elapsedMs = Date.now() - t0;
    check("renderDom on unreachable url returns null", dead === null);
    check("unreachable url resolved within its timeout", elapsedMs < 15000);
  } finally {
    child.kill();
    try { rm(workDir, { recursive: true, force: true }); } catch {}
  }

  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
