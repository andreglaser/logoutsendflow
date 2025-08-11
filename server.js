// server.js
const express = require("express");
const { chromium } = require("playwright");

const app = express();

// Aceita JSON e form-url-encoded
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- Config ----
const DEFAULT_BUTTON_CANDIDATES = [
  /deslogar/i,
  /sair de todos os dispositivos/i,
  /logout all sessions/i,
  /logout/i
];

// Opcional: proteger o endpoint com Authorization: Bearer <token>
// Crie AUTH_TOKEN nas Environment Variables da Render para ativar
function checkAuth(req, res) {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return true; // sem token configurado = sem checagem
  const header = req.get("Authorization") || "";
  const got = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (got && got === expected) return true;
  res.status(401).json({ ok: false, error: "Unauthorized" });
  return false;
}

function coerceUrl(req) {
  // Tenta em body.url, body.URL, query.url
  let raw = req.body?.url ?? req.body?.URL ?? req.query?.url;
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== "string") return null;
  const u = raw.trim();
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

async function clickFirstMatch(page, candidates, explicitSelector, timeoutMs = 5000) {
  // 1) Seletor explícito
  if (explicitSelector) {
    const el = page.locator(explicitSelector);
    if (await el.count()) {
      await el.first().click({ timeout: timeoutMs });
      return { clicked: true, how: "selector", value: explicitSelector };
    }
  }

  // 2) getByRole + texto
  for (const rx of candidates) {
    const btn = page.getByRole("button", { name: rx });
    if ((await btn.count().catch(() => 0)) > 0) {
      try {
        await btn.first().click({ timeout: timeoutMs });
        return { clicked: true, how: "role+text", value: rx.toString() };
      } catch {}
    }
  }

  // 3) Fallback: qualquer elemento com texto
  for (const rx of candidates) {
    const t = page.getByText(rx, { exact: false });
    if ((await t.count().catch(() => 0)) > 0) {
      try {
        await t.first().click({ timeout: timeoutMs });
        return { clicked: true, how: "text", value: rx.toString() };
      } catch {}
    }
  }

  // 4) XPath genérico (button/link)
  for (const rx of candidates) {
    const text = rx.toString().replace(/^\/|\/[gimuy]*$/g, "");
    const xpList = [
      `//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÂÊÔÃÕÇ','abcdefghijklmnopqrstuvwxyzáéíóúâêôãõç'), '${text.toLowerCase()}')]`,
      `//a[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÂÊÔÃÕÇ','abcdefghijklmnopqrstuvwxyzáéíóúâêôãõç'), '${text.toLowerCase()}')]`
    ];
    for (const xp of xpList) {
      const el = page.locator(`xpath=${xp}`);
      if ((await el.count().catch(() => 0)) > 0) {
        try {
          await el.first().click({ timeout: timeoutMs });
          return { clicked: true, how: "xpath", value: text };
        } catch {}
      }
    }
  }

  return { clicked: false };
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("OK: use POST /logout { url, selector?, buttonText? }");
});

app.post("/logout", async (req, res) => {
  if (!checkAuth(req, res)) return; // 401 se AUTH_TOKEN estiver configurado e inválido

  const url = coerceUrl(req);
  if (!url) {
    return res.status(400).json({ ok: false, error: "Body deve conter { url: string http/https }" });
  }

  const selector = req.body?.selector;
  const buttonText = req.body?.buttonText; // ex.: "Deslogar"

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
      viewport: { width: 1366, height: 768 }
    });

    // Bloqueia recursos pesados para acelerar
    await ctx.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "font" || t === "media") return route.abort();
      return route.continue();
    });

    const page = await ctx.newPage();
    page.setDefaultTimeout(6000);
    page.setDefaultNavigationTimeout(10000);

    // ---- Navega esperando apenas 'load' (onload)
    await page.goto(url, { waitUntil: "load", timeout: 15000 });

    // Candidatos de botão (prioriza buttonText se vier)
    const candidates = buttonText
      ? [new RegExp(buttonText, "i"), ...DEFAULT_BUTTON_CANDIDATES]
      : DEFAULT_BUTTON_CANDIDATES;

    // Clica no botão
    const clickResult = await clickFirstMatch(page, candidates, selector, 5000);

    // Após o clique, espera um sinal rápido de mudança (load ou URL alvo)
    if (clickResult.clicked) {
      await Promise.race([
        page.waitForURL(/login|signed\-out|logout|sucesso/i, { timeout: 7000 }),
        page.waitForLoadState("load", { timeout: 5000 })
      ]).catch(() => {});
    }

    const title = await page.title().catch(() => null);
    const finalUrl = page.url();

    await ctx.close();
    await browser.close();

    return res.json({
      ok: true,
      clicked: clickResult.clicked,
      clickHow: clickResult.how || null,
      clickValue: clickResult.value || null,
      pageTitle: title,
      finalUrl
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Listening on", PORT);
});
