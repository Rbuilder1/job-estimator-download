// Job Estimator on iPhone: the estimator "server" (estimator.py on the PC and Android) runs
// right here in the page, because an iPhone can't run Python. index.html is the very same
// page: it calls fetch("/api/..."), and this answers those calls instead of a server.
//
// The Swift app (JobEstimatorApp.swift) injects this before the page loads, along with
// prompts.js (generated from estimator.py, so Claude gets identical instructions), and
// provides window.webkit.messageHandlers.native for what a page can't do itself: network
// calls without browser limits (Claude, and the PC's image generator on the local network),
// the API key in the iPhone Keychain, saved estimates as files, print, share, and Safari.
(() => {
  "use strict";
  const P = window.JE_PROMPTS;
  // the web app (web/web-native.js) does the native parts with browser features instead
  const WEB = typeof window.JE_NATIVE === "function";
  const native = WEB ? window.JE_NATIVE : (cmd, args = {}) => window.webkit.messageHandlers.native.postMessage({cmd, ...args});
  const NO_PC = "The web app can't reach your PC (browsers block it), so previews and the PC's photo-reading AI need the "
    + "installed Windows, Mac or Android app. Estimates with Claude, 📐 Quick estimate and the 🤖 local agent's note reading all work here.";
  const API = "https://api.anthropic.com";

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  // ---- the API key, kept in the iPhone Keychain -------------------------------
  const plausible = k => (k.startsWith("sk-ant-") && k.length >= 40 ? k : "");
  const apiKey = async () => plausible((await native("getKey")) || "");

  async function http(method, url, {headers = {}, body = null, timeout = 60} = {}) {
    try {
      return await native("http", {method, url, headers, body, timeout});
    } catch (e) {
      throw new HttpError(0, String(e.message || e));
    }
  }

  function apiError(status, body) {
    let msg = "";
    try { msg = JSON.parse(body).error.message; } catch { msg = String(body || "").slice(0, 300); }
    return new HttpError(status, msg);
  }

  async function checkKey(key) {
    let r;
    try {
      r = await http("GET", `${API}/v1/models/${P.MODEL}`, {headers: {"x-api-key": key, "anthropic-version": "2023-06-01"}, timeout: 20});
    } catch { return "Couldn't reach Anthropic - check the internet connection."; }
    if (r.status === 200) return "";
    if (r.status === 401) return "Anthropic rejected that key - check it was copied whole.";
    if (r.status === 403) return "That key isn't allowed to use Claude Opus 5.5.";
    return `Anthropic returned an error (${r.status}).`;
  }

  // ---- Claude, streamed (SSE) and rebuilt into the final message, as anthropic_lite.py does ----
  async function claude(params, betas) {
    const key = await apiKey();
    const headers = {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"};
    if (betas) headers["anthropic-beta"] = betas.join(",");
    const body = JSON.stringify({...params, stream: true});
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await http("POST", `${API}/v1/messages`, {headers, body, timeout: 900});
      } catch (e) {
        if (attempt >= 2) throw new HttpError(0, "Could not reach the Claude API - check the internet connection.");
        await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
        continue;
      }
      if (r.status === 200) return parseStream(r.body);
      if (![408, 409, 429, 500, 502, 503, 504, 529].includes(r.status) || attempt >= 2) throw apiError(r.status, r.body);
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }

  function parseStream(text) {
    let msg = null;
    const blocks = {}, partial = {};
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const d = JSON.parse(line.slice(5));
      switch (d.type) {
        case "message_start": msg = d.message; break;
        case "content_block_start": blocks[d.index] = d.content_block; break;
        case "content_block_delta": {
          const b = blocks[d.index], x = d.delta;
          if (x.type === "text_delta") b.text = (b.text || "") + x.text;
          else if (x.type === "thinking_delta") b.thinking = (b.thinking || "") + x.thinking;
          else if (x.type === "signature_delta") b.signature = x.signature;
          else if (x.type === "input_json_delta") partial[d.index] = (partial[d.index] || "") + x.partial_json;
          else if (x.type === "citations_delta") (b.citations = b.citations || []).push(x.citation);
          break;
        }
        case "content_block_stop":
          if (d.index in partial) { blocks[d.index].input = JSON.parse(partial[d.index] || "{}"); delete partial[d.index]; }
          break;
        case "message_delta":
          for (const [k, v] of Object.entries(d.delta || {})) if (v != null) msg[k] = v;
          Object.assign(msg.usage = msg.usage || {}, d.usage || {});
          break;
        case "error":
          throw new HttpError(d.error?.type === "overloaded_error" ? 529 : 500, d.error?.message || "stream error");
      }
    }
    if (!msg) throw new HttpError(0, "The connection closed before Claude answered.");
    msg.content = Object.keys(blocks).sort((a, b) => a - b).map(i => blocks[i]);
    return msg;
  }

  // ---- the same request-building as estimator.py ------------------------------
  const supplier = s => (s.supplier || "").trim() || P.DEFAULT_SUPPLIER;
  const rules = s => P.SUPPLIERS.find(r => r.match.some(m => supplier(s).toLowerCase().includes(m))) || {};

  function priceTools(s) {
    if (!s.live_prices) return [];
    const search = {type: "web_search_20260209", name: "web_search", max_uses: 25,
                    user_location: {type: "approximate", region: "New York", country: "US"}};
    const fetch_ = {type: "web_fetch_20260209", name: "web_fetch", max_uses: 15};
    if (rules(s).domains?.length) search.allowed_domains = fetch_.allowed_domains = rules(s).domains;
    return [search, fetch_];
  }

  function buildContent(req) {
    const content = [];
    for (const f of req.files || []) {
      if (f.type === "application/pdf")
        content.push({type: "document", title: f.name || "plans.pdf", source: {type: "base64", media_type: f.type, data: f.data}});
      else if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(f.type))
        content.push({type: "image", source: {type: "base64", media_type: f.type, data: f.data}});
    }
    const s = req.settings || {};
    const lines = [
      `Job description from the contractor: ${req.notes || "(none - infer the likely job from the images)"}`,
      `Job type: ${s.job_type || "infer it"}`,
      `Location (for pricing): ${s.location || "Hudson Valley, NY"}`,
      `Contractor's base labor rate: $${s.labor_rate || 75}/hr`,
      `Material grade: ${s.grade || "mid-grade"}`,
      `Supplier: ${supplier(s)}`,
      `There are ${(req.files || []).length} attached file(s).`,
    ];
    if ((s.price_list || "").trim())
      lines.push("The contractor's own price list / supplier quote (use these prices first, matching items by description):\n" + s.price_list.trim());
    if (s.live_prices)
      lines.push(`Look up current ${supplier(s)} prices with web search and web fetch for every material you can find, not just the big items. `
                 + (rules(s).hint || ""));
    content.push({type: "text", text: lines.join("\n")});
    return content;
  }

  async function run(system, schema, firstContent, tools) {
    const messages = [{role: "user", content: firstContent}];
    let msg;
    for (let i = 0; i < 8; i++) {  // a long price lookup can pause the turn; resume it
      msg = await claude({
        model: P.MODEL, max_tokens: 64000, system, messages,
        thinking: {type: "adaptive"},
        output_config: {effort: "high", format: {type: "json_schema", schema}},
        fallbacks: "default",
        ...(tools.length ? {tools} : {}),
      }, ["server-side-fallback-2026-07-01"]);
      if (msg.stop_reason !== "pause_turn") break;
      messages.push({role: "assistant", content: msg.content});
    }
    if (msg.stop_reason === "refusal") throw new HttpError(500, "Claude declined this request.");
    if (msg.stop_reason === "max_tokens") throw new HttpError(500, "The answer ran out of room - try fewer files or a narrower job.");
    return msg;
  }

  const stamp = () => {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return {human: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
            id: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`};
  };
  const textOf = msg => msg.content.filter(b => b.type === "text").map(b => b.text).join("").trim();

  async function estimate(req) {
    const msg = await run(P.SYSTEM, P.SCHEMA, buildContent(req), priceTools(req.settings || {}));
    const out = JSON.parse(textOf(msg));
    out._meta = {model: msg.model, created: stamp().human,
                 input_tokens: msg.usage?.input_tokens || 0, output_tokens: msg.usage?.output_tokens || 0};
    return out;
  }

  async function reprice(req) {
    const s = {...(req.settings || {}), live_prices: true};
    const lines = (req.materials || []).map((m, i) =>
      `${i}: ${m.item || ""} | ${m.spec || ""} | unit: ${m.unit || ""} | current $${m.unit_cost || 0}`);
    if (!lines.length) throw new HttpError(500, "There are no materials to price.");
    const text = [`Supplier: ${supplier(s)}`, `Location: ${s.location || "Hudson Valley, NY"}`,
      `Look up current ${supplier(s)} prices with web search and web fetch for every line. ` + (rules(s).hint || "")];
    if ((s.price_list || "").trim()) text.push("The contractor's own price list / supplier quote (use these first):\n" + s.price_list.trim());
    text.push("Material lines (index: item | spec | unit | current price):\n" + lines.join("\n"));
    const msg = await run(P.REPRICE_SYSTEM, P.REPRICE_SCHEMA, text.join("\n\n"), priceTools(s));
    const out = JSON.parse(textOf(msg));
    out.priced = stamp().human;
    return out;
  }

  // ---- previews: the PC's image generator, over the phone link (see estimator.py) ----
  const linkInfo = () => { try { return JSON.parse(localStorage.getItem("je_pc_link")) || {}; } catch { return {}; } };

  async function link(path, body, timeout, info = linkInfo()) {
    if (!info.pc || !info.code)
      throw new HttpError(500, "Previews are made by the image generator on your PC. Open ⚙ Settings, and enter the PC address and link code shown in Settings on the PC.");
    const host = info.pc.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const url = `http://${host.includes(":") ? host : `${host}:${P.LINK_PORT}`}${path}`;
    let r;
    try {
      r = await http(body ? "POST" : "GET", url, {headers: {"Content-Type": "application/json", "X-Link-Code": info.code},
                                                   body: body ? JSON.stringify(body) : null, timeout});
    } catch (e) {
      throw new HttpError(500, `Couldn't reach the PC at ${host} (${e.message}). Make sure Job Estimator is open on the PC and the phone is on the same Wi-Fi.`);
    }
    let j = {};
    try { j = JSON.parse(r.body); } catch {}
    if (r.status !== 200) throw new HttpError(500, j.error || `The PC answered ${r.status}.`);
    return j;
  }

  // hand the PC a job (preview or photo reading), then check back every 2 s: a long quiet request gets dropped
  async function linkJob(kind, req) {
    const started = await link(`/link/${kind}`, req, 60);
    if (!started.job) return started;  // a PC from before job tickets
    const deadline = Date.now() + 900000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      let j;
      try { j = await link(`/link/job/${started.job}`, null, 15); } catch { continue; }
      if (j.done) {
        if (j.error) throw new HttpError(500, j.error);
        return j.result || {image: j.image};
      }
    }
    throw new HttpError(500, "The PC took more than 15 minutes.");
  }

  // ---- saved estimates: files in the app's Documents folder -------------------
  const safeId = s => String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);

  async function listSaved() {
    const docs = await native("listEstimates");
    const rows = [];
    for (const raw of docs) {
      try {
        const d = JSON.parse(raw);
        rows.push({id: d.id, title: d.estimate?.project_title || d.id, client: d.client || "", total: d.total || 0, saved: d.saved || ""});
      } catch {}
    }
    return rows.sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  // ---- the routes index.html calls ---------------------------------------------
  async function route(method, path, req) {
    if (method === "GET") {
      if (path === "/api/status") {
        const key = await apiKey();
        if (WEB) return [200, {key: !!key, key_source: key ? "app" : "", model: P.MODEL, mobile: true, web: true, dictation: "web", local_ai: "", pc: ""}];
        return [200, {key: !!key, key_source: key ? "app" : "", model: P.MODEL, mobile: true, dictation: "ios", local_ai: linkInfo().pc ? "PC" : "", pc: linkInfo().pc || ""}];
      }
      if (path === "/api/estimates") return [200, await listSaved()];
      const m = path.match(/^\/api\/estimates\/([A-Za-z0-9_-]+)$/);
      if (m) {
        const raw = await native("getEstimate", {id: m[1]});
        return raw ? [200, JSON.parse(raw)] : [404, {error: "not found"}];
      }
      if (path === "/api/preview/progress" && WEB) return [200, {up: false, step: 0, steps: 0}];
      if (path === "/api/preview/progress") {
        try { return [200, await link("/link/progress", null, 4)]; } catch { return [200, {up: false, step: 0, steps: 0}]; }
      }
      return [404, {error: "not found"}];
    }
    switch (path) {
      case "/api/key": {
        const key = (req.key || "").trim();
        if (key) {
          const problem = await checkKey(key);
          if (problem) return [400, {error: problem}];
        }
        await native("setKey", {key});
        return [200, {ok: true}];
      }
      case "/api/estimate":
      case "/api/reprice": {
        if (path === "/api/estimate" && !(req.files || []).length && !(req.notes || "").trim())
          return [400, {error: "Add at least one photo/plan or a description."}];
        if (!(await apiKey())) return [400, {error: "No Claude API key yet - tap the ⚙ Settings button and paste one in."}];
        try {
          return [200, await (path === "/api/estimate" ? estimate(req) : reprice(req))];
        } catch (e) {
          if (e.status === 401) return [401, {error: "The API key was rejected."}];
          if (e.status === 429) return [429, {error: "Rate limited - wait a minute and try again."}];
          if (e.status >= 400 && e.status !== 500) return [502, {error: `Claude API error ${e.status}: ${e.message}`}];
          return [e.status === 0 ? 502 : 500, {error: e.message}];
        }
      }
      case "/api/preview": if (WEB) return [400, {error: NO_PC}]; return [200, await linkJob("preview", req)];
      case "/api/vision":  // the local agent's photo reading, done by the PC's AI
        if (WEB) return [400, {error: NO_PC}];
        if (!linkInfo().pc) return [500, {error: "No local AI on an iPhone - link it to the PC in ⚙ Settings to have photos read."}];
        return [200, await linkJob("vision", req)];
      case "/api/link": {
        if (WEB) return [400, {error: NO_PC}];
        const info = {pc: (req.pc || "").trim(), code: (req.code || "").trim() || linkInfo().code || ""};
        if (info.pc) await link("/link/progress", null, 6, info);  // throws a readable error if it can't connect
        localStorage.setItem("je_pc_link", JSON.stringify(info));
        return [200, {ok: true}];
      }
      case "/api/save": {
        req.id = safeId(req.id) || stamp().id;
        await native("saveEstimate", {id: req.id, json: JSON.stringify(req)});
        return [200, {id: req.id}];
      }
      case "/api/mobile/listen":
        try {
          return [200, {text: req.stop ? await native("listenStop") : (await native("listenStart"), "")}];
        } catch (e) { return [400, {error: e.message || String(e)}]; }
      case "/api/mobile/busy": await native("busy", {on: !!req.on}); return [200, {ok: true}];
      case "/api/mobile/print": await native("print", {title: req.title || "Estimate"}); return [200, {ok: true}];
      case "/api/mobile/share": await native("share", {name: req.name || "file.txt", text: req.text || "", mime: req.mime || "text/plain"}); return [200, {ok: true}];
      case "/api/mobile/open":
        if (!String(req.url || "").startsWith("https://")) return [400, {error: "only https links"}];
        await native("open", {url: req.url});
        return [200, {ok: true}];
    }
    return [404, {error: "not found"}];
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    let code, obj;
    try {
      [code, obj] = await route((init.method || "GET").toUpperCase(), url.pathname, init.body ? JSON.parse(init.body) : {});
    } catch (e) {
      [code, obj] = [500, {error: e.message || String(e)}];
    }
    return new Response(JSON.stringify(obj), {status: code, headers: {"Content-Type": "application/json"}});
  };
})();
