// server.js — API-first + fallback Playwright, com logs step-by-step
const express = require("express");
const { chromium } = require("playwright");

const app = express();

// ---------- Middlewares ----------
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- Config ----------
const CHROME_ARGS = ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu"];
const DEFAULT_BUTTON_CANDIDATES = [/deslogar/i, /sair de todos os dispositivos/i, /logout all sessions/i, /logout/i];
const IDEMP_TTL_MS = 10 * 60 * 1000; // 10min
const seen = new Map(); // url -> timestamp

// ---------- Utils ----------
function ts() { return new Date().toISOString(); }
function log(step, data = {}) { console.log(JSON.stringify({ ts: ts(), step, ...data })); }

function checkAuth(req, res) {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return true;
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (token === expected) return true;
  log("auth_denied");
  res.status(401).json({ ok: false, error: "Unauthorized" });
  return false;
}

function coerceUrl(req) {
  let raw = req.body?.url ?? req.body?.URL ?? req.query?.url;
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== "string") return null;
  const u = raw.trim();
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

function extractAccessId(url) {
  // pega o trecho depois de /logout/
  const m = url.match(/sendflow\.pro\/logout\/([^/?#]+)/i);
  return m ? m[1] : null;
}

function seenRecently(u) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > IDEMP_TTL_MS) seen.delete(k);
  const last = seen.get(u);
  seen.set(u, now);
  return last && (now - last < IDEMP_TTL_MS);
}

// ---------- Playwright helpers ----------
async function clickFirstMatch(page, candidates, explicitSelector, timeoutMs = 5000) {
  log("click_start");

  if (explicitSelector) {
    log("click_try_selector", { selector: explicitSelector });
    const el = page.locator(explicitSelector);
    const count = await el.count().catch(() => 0);
    log("click_probe_selector", { count });
    if (count > 0) {
      await el.first().click({ timeout: timeoutMs });
      log("click_ok_selector");
      return { clicked: true, how: "selector", value: explicitSelector };
    }
  }

  for (const rx of candidates) {
    log("click_try_role_text", { rx: rx.toString() });
    const btn = page.getByRole("button", { name: rx });
    const count = await btn.count().catch(() => 0);
    log("click_probe_role_text", { count });
    if (count > 0) {
      try {
        await btn.first().click({ timeout: timeoutMs });
        log("click_ok_role_text", { rx: rx.toString() });
        return { clicked: true, how: "role+text", value: rx.toString() };
      } catch (e) { log("click_fail_role_text", { err: e.message }); }
    }
  }

  for (const rx of candidates) {
    log("click_try_text", { rx: rx.toString() });
    const t = page.getByText(rx, { exact: false });
    const count = await t.count().catch(() => 0);
    log("click_probe_text", { count });
    if (count > 0) {
      try {
        await t.first().click({ timeout: timeoutMs });
        log("click_ok_text", { rx: rx.toString() });
        return { clicked: true, how: "text", value: rx.toString() };
      } catch (e) { log("click_fail_text", { err: e.message }); }
    }
  }

  try {
    log("click_try_first_visible_button");
    const firstBtn = page.locator("button:visible").first();
    const count = await firstBtn.count().catch(() => 0);
    log("click_probe_first_visible_button", { count });
    if (count > 0) {
      await firstBtn.click({ timeout: 3000 });
      log("click_ok_first_visible_button");
      return { clicked: true, how: "fallback:first-visible-button", value: null };
    }
  } catch (e) {
    log("click_fail_first_visible_button", { err: e.message });
  }

  log("click_none_found");
  return { clicked: false };
}

// ---------- Routes ----------
app.get("/", (_req, res) => {
  res.type("text/plain").send("OK: POST /logout { url, selector?, buttonText? }");
});

app.post("/logout", async (req, res) => {
  const t0 = Date.now();
  log("req_received", { hasAuth: !!req.get("authorization"), ct: req.get("content-type") || null });
  log("req_body", { body: req.body });

  if (!checkAuth(req, res)) return;

  const url = coerceUrl(req);
  log("url_parsed", { url });
  if (!url) {
    log("bad_request_no_url");
    return res.status(400).json({ ok: false, error: "Body deve conter { url: string http/https }" });
  }

  // idempotência simples
  if (seenRecently(url)) {
    log("skip_idempotent", { url });
    return res.json({ ok: true, skipped: true, reason: "recently processed", finalUrl: "https://sendflow.pro/login" });
  }

  const accessId = extractAccessId(url);
  log("access_id", { accessId });

  // 1) Tenta API direta primeiro
  if (accessId) {
    try {
      const apiUrl = `https://southamerica-east1-whatsapp-ultimate.cloudfunctions.net/api/users/logout/${accessId}`;
      log("api_call_start", { apiUrl });
      const r = await fetch(apiUrl, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HeadlessLogout/1.0" }
      });
      const status = r.status;
      let body = null;
      try { body = await r.text(); } catch {}
      log("api_call_done", { status, body: body?.slice?.(0, 200) || null });

      if (status >= 200 && status < 400) {
        log("api_success");
        const total = Date.now() - t0;
        log("done_api_only", { totalMs: total });
        return res.json({
          ok: true,
          via: "api",
          apiStatus: status,
          finalUrl: "https://sendflow.pro/login"
        });
      }
      log("api_non_2xx", { status });
    } catch (e) {
      log("api_call_error", { err: e.message });
    }
  } else {
    log("no_access_id_in_url");
  }

  // 2) Fallback: Playwright (UI)
  const selector = req.body?.selector || null;
  const buttonText = req.body?.buttonText || "Deslogar";
  log("fallback_ui_start", { selector, buttonText });

  let browser, ctx, page;
  const logoutHits = [];
  try {
    // Launch
    log("browser_launching");
    browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
    log("browser_launched");

    // Context
    log("context_creating");
    ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
      viewport: { width: 1366, height: 768 }
    });
    log("context_created");

    await ctx.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "font" || t === "media") return route.abort();
      return route.continue();
    });
    log("route_blockers_set");

    ctx.on("request", (r) => {
      const u = r.url();
      if (/logout|signout|sessions/i.test(u)) log("net_req", { method: r.method(), url: u });
    });
    ctx.on("response", (r) => {
      const u = r.url();
      if (/logout|signout|sessions/i.test(u)) {
        const st = r.status();
        log("net_res", { status: st, url: u });
        logoutHits.push({ url: u, status: st });
      }
    });

    page = await ctx.newPage();
    page.setDefaultTimeout(6000);
    page.setDefaultNavigationTimeout(12000);
    page.on("console", (m) => log("page_console", { type: m.type(), text: m.text() }));

    log("goto_start", { url });
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    log("goto_done", { title: await page.title().catch(() => null), currentUrl: page.url() });

    const candidates = [new RegExp(buttonText, "i"), ...DEFAULT_BUTTON_CANDIDATES];
    log("click_attempt");
    let clickResult = await clickFirstMatch(page, candidates, selector, 5000);
    log("click_result", clickResult);

    if (clickResult.clicked) {
      log("post_click_wait_start");
      await Promise.race([
        (async () => {
          const s = Date.now();
          while (Date.now() - s < 6000) {
            if (logoutHits.some(h => h.status >= 200 && h.status < 400)) break;
            await new Promise(r => setTimeout(r, 200));
          }
        })(),
        page.waitForURL(/login|signed\-out|logout.*(done|success)/i, { timeout: 6000 }).catch(() => {}),
        page.waitForLoadState("load", { timeout: 6000 }).catch(() => {})
      ]);
      log("post_click_wait_done", { logoutHits: logoutHits.length });
    }

    // força /login como acabamento
    if (/sendflow\.pro\/logout\//i.test(page.url())) {
      try {
        log("force_login_nav");
        const u = new URL(page.url());
        u.pathname = "/login";
        u.search = "";
        await page.goto(u.toString(), { waitUntil: "load", timeout: 7000 }).catch(() => {});
        log("force_login_nav_done", { currentUrl: page.url() });
      } catch (e) {
        log("force_login_nav_fail", { err: e.message });
      }
    }

    const title = await page.title().catch(() => null);
    const finalUrl = page.url();
    log("final_state", { title, finalUrl, logoutHits: logoutHits.length });

    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    log("closed_all", { totalMs: Date.now() - t0 });

    return res.json({
      ok: true,
      via: "ui",
      clicked: !!clickResult.clicked,
      clickHow: clickResult.how || null,
      clickValue: clickResult.value || null,
      logoutRequests: logoutHits,
      pageTitle: title,
      finalUrl
    });
  } catch (err) {
    log("error_ui", { err: err?.message });
    try { if (ctx) await ctx.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log("listening", { port: PORT }));

process.on("SIGTERM", () => { log("sigterm"); process.exit(0); });
process.on("SIGINT", () => { log("sigint"); process.exit(0); });
