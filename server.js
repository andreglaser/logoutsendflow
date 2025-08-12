// server.js — com logs detalhados por etapa
const express = require("express");
const { chromium } = require("playwright");

const app = express();

// ---------- Config ----------
const BUTTON_CANDIDATES = [/deslogar/i, /logout all sessions/i, /logout/i];
const HEADLESS_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu"
];

// Níveis: error < warn < info < debug < trace
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

function now() { return Date.now(); }
function genId() {
  return Math.random().toString(36).slice(2, 8) + "-" + Math.random().toString(36).slice(2, 8);
}
function log(level, obj) {
  if (LEVELS[level] <= LEVELS[LOG_LEVEL]) {
    const line = { level, ts: new Date().toISOString(), ...obj };
    console.log(JSON.stringify(line));
  }
}

function checkAuth(req, res, rid) {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return true;
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (token === expected) return true;
  log("warn", { rid, msg: "unauthorized", got: header ? "[present]" : "[missing]" });
  res.status(401).json({ ok: false, error: "Unauthorized" });
  return false;
}

function pickUrl(req) {
  let raw = req.body?.url ?? req.body?.URL ?? req.query?.url;
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== "string") return null;
  const u = raw.trim();
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

// ---------- Middlewares ----------
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- Health ----------
app.get("/", (_req, res) => {
  res.type("text/plain").send("OK: POST /logout { url, selector?, buttonText? }");
});

// ---------- Core ----------
app.post("/logout", async (req, res) => {
  const rid = req.get("X-Request-Id") || genId();
  const t0 = now();

  log("info", { rid, msg: "request_received" });
  log("trace", { rid, msg: "request_body", body: req.body });

  if (!checkAuth(req, res, rid)) return;

  const url = pickUrl(req);
  const selector = req.body?.selector || null;
  const buttonText = req.body?.buttonText || null;

  if (!url) {
    log("warn", { rid, msg: "invalid_payload_no_url" });
    return res.status(400).json({ ok: false, error: "Body deve conter { url: string http/https }" });
  }

  log("debug", { rid, msg: "validated_payload", url, selector, buttonText });

  let browser, context, page;
  try {
    // --- Launch ---
    const tLaunch0 = now();
    browser = await chromium.launch({ headless: true, args: HEADLESS_ARGS });
    log("debug", { rid, msg: "browser_launched", ms: now() - tLaunch0 });

    // --- Context ---
    const tCtx0 = now();
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
      viewport: { width: 1366, height: 768 }
    });
    log("trace", { rid, msg: "context_created", ms: now() - tCtx0 });

    // Bloqueia recursos pesados
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "font" || t === "media") return route.abort();
      return route.continue();
    });

    // Eventos úteis
    context.on("request", (reqPW) => {
      log("trace", { rid, msg: "net_request", method: reqPW.method(), url: reqPW.url() });
    });
    context.on("response", (resp) => {
      log("trace", { rid, msg: "net_response", status: resp.status(), url: resp.url() });
    });

    page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.setDefaultNavigationTimeout(10000);

    // --- Goto (espera onload) ---
    const tGoto0 = now();
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    log("info", { rid, msg: "page_loaded", ms: now() - tGoto0, url: page.url(), title: await page.title().catch(() => null) });

    // --- Click ---
    const tClick0 = now();
    const candidates = buttonText ? [new RegExp(buttonText, "i"), ...BUTTON_CANDIDATES] : BUTTON_CANDIDATES;
    const clickResult = await clickFirstMatch(page, candidates, selector, rid);
    log("info", { rid, msg: "click_attempted", ms: now() - tClick0, ...clickResult });

    // --- Pós-clique: espera curto ---
    const tAfter0 = now();
    if (clickResult.clicked) {
      await Promise.race([
        page.waitForURL(/login|signed\-out|logout|sucesso/i, { timeout: 7000 }),
        page.waitForLoadState("load", { timeout: 5000 })
      ]).catch(() => {});
    }
    log("debug", { rid, msg: "post_click_wait_done", ms: now() - tAfter0 });

    const resp = {
      ok: true,
      clicked: clickResult.clicked,
      clickHow: clickResult.how || null,
      clickValue: clickResult.value || null,
      pageTitle: await page.title().catch(() => null),
      finalUrl: page.url()
    };

    log("info", { rid, msg: "request_done", total_ms: now() - t0, result: resp });
    return res.json(resp);
  } catch (err) {
    log("error", { rid, msg: "request_failed", error: err?.message, stack: err?.stack, total_ms: now() - t0 });
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    const tClose0 = now();
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    log("trace", { rid, msg: "browser_closed", ms: now() - tClose0 });
  }
});

// ---------- Helpers ----------
async function clickFirstMatch(page, candidates, explicitSelector, rid, timeoutMs = 5000) {
  // 1) seletor explícito
  if (explicitSelector) {
    const el = page.locator(explicitSelector);
    const count = await el.count().catch(() => 0);
    log("trace", { rid, msg: "probe_selector", selector: explicitSelector, count });
    if (count > 0) {
      try { await el.first().click({ timeout: timeoutMs }); return { clicked: true, how: "selector", value: explicitSelector }; }
      catch (e) { log("warn", { rid, msg: "selector_click_failed", selector: explicitSelector, error: e.message }); }
    }
  }

  // 2) role=button + texto
  for (const rx of candidates) {
    const btn = page.getByRole("button", { name: rx });
    const count = await btn.count().catch(() => 0);
    log("trace", { rid, msg: "probe_role_text", regex: rx.toString(), count });
    if (count > 0) {
      try { await btn.first().click({ timeout: timeoutMs }); return { clicked: true, how: "role+text", value: rx.toString() }; }
      catch (e) { log("warn", { rid, msg: "role_text_click_failed", regex: rx.toString(), error: e.message }); }
    }
  }

  // 3) getByText (fallback)
  for (const rx of candidates) {
    const t = page.getByText(rx, { exact: false });
    const count = await t.count().catch(() => 0);
    log("trace", { rid, msg: "probe_text", regex: rx.toString(), count });
    if (count > 0) {
      try { await t.first().click({ timeout: timeoutMs }); return { clicked: true, how: "text", value: rx.toString() }; }
      catch (e) { log("warn", { rid, msg: "text_click_failed", regex: rx.toString(), error: e.message }); }
    }
  }

  // 4) XPath genérico
  for (const rx of candidates) {
    const text = rx.toString().replace(/^\/|\/[gimuy]*$/g, "");
    const xpList = [
      `//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÂÊÔÃÕÇ','abcdefghijklmnopqrstuvwxyzáéíóúâêôãõç'), '${text.toLowerCase()}')]`,
      `//a[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÂÊÔÃÕÇ','abcdefghijklmnopqrstuvwxyzáéíóúâêôãõç'), '${text.toLowerCase()}')]`
    ];
    for (const xp of xpList) {
      const el = page.locator(`xpath=${xp}`);
      const count = await el.count().catch(() => 0);
      log("trace", { rid, msg: "probe_xpath", xpath: xp, count });
      if (count > 0) {
        try { await el.first().click({ timeout: timeoutMs }); return { clicked: true, how: "xpath", value: text }; }
        catch (e) { log("warn", { rid, msg: "xpath_click_failed", xpath: xp, error: e.message }); }
      }
    }
  }

  return { clicked: false };
}

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log("info", { msg: "server_listening", port: PORT, log_level: LOG_LEVEL });
});
