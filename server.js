// server.js
const express = require("express");
const bodyParser = require("body-parser");
const { chromium } = require("playwright");

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

const DEFAULT_BUTTON_CANDIDATES = [
  /deslogar todas as sessões ativas/i,
  /deslogar todas as sessoes ativas/i, // sem acento
  /deslogar/i,
  /sair de todos os dispositivos/i,
  /logout all sessions/i,
  /log out all sessions/i,
  /logout/i
];

async function clickFirstMatch(page, candidates, explicitSelector, timeoutMs = 8000) {
  // 1) Se veio seletor explícito, tenta ele primeiro
  if (explicitSelector) {
    const el = page.locator(explicitSelector);
    if (await el.count()) {
      await el.first().click({ timeout: timeoutMs });
      return { clicked: true, how: "selector", value: explicitSelector };
    }
  }

  // 2) Tenta por role=button e texto
  for (const rx of candidates) {
    const btn = page.getByRole("button", { name: rx });
    if (await btn.count().catch(() => 0)) {
      try {
        await btn.first().click({ timeout: timeoutMs });
        return { clicked: true, how: "role+text", value: rx.toString() };
      } catch {}
    }
  }

  // 3) Tenta via XPath genérica (button ou link com texto)
  for (const rx of candidates) {
    const text = rx.toString().replace(/^\/|\/[gimuy]*$/g, ""); // extrai o conteúdo do regex
    const xpathCandidates = [
      `//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÂÊÔÃÕÇ','abcdefghijklmnopqrstuvwxyzáéíóúâêôãõç'), '${text.toLowerCase()}')]`,
      `//a[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÉÍÓÚÂÊÔÃÕÇ','abcdefghijklmnopqrstuvwxyzáéíóúâêôãõç'), '${text.toLowerCase()}')]`
    ];
    for (const xp of xpathCandidates) {
      const el = page.locator(`xpath=${xp}`);
      if (await el.count().catch(() => 0)) {
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
  const { url, selector, buttonText } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ ok: false, error: "Body deve conter { url }" });
  }

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
    const page = await ctx.newPage();

    // Observa respostas (útil pra debugar se o GET já “desloga” por si só)
    let lastResponseStatus = null;
    page.on("response", (resp) => {
      if (resp.url().startsWith(url)) {
        lastResponseStatus = resp.status();
      }
    });

    // 1) Abre o link
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    // 2) Se foi passado um texto de botão explícito, ele tem prioridade no match
    const candidates = buttonText
      ? [new RegExp(buttonText, "i"), ...DEFAULT_BUTTON_CANDIDATES]
      : DEFAULT_BUTTON_CANDIDATES;

    // 3) Tenta clicar no botão (se existir)
    const clickResult = await clickFirstMatch(page, candidates, selector);

    // 4) Depois do clique (se houve), aguarda alguma estabilização
    if (clickResult.clicked) {
      // tenta esperar um possível redirect/feedback
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    }

    // 5) Retorna alguns sinais úteis
    const title = await page.title().catch(() => null);
    const urlAfter = page.url();

    await ctx.close();
    await browser.close();

    return res.json({
      ok: true,
      navigatedStatus: lastResponseStatus,
      clicked: clickResult.clicked,
      clickHow: clickResult.how || null,
      clickValue: clickResult.value || null,
      pageTitle: title,
      finalUrl: urlAfter
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err)
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Listening on", PORT);
});
