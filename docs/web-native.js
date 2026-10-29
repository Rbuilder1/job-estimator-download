// Job Estimator as a web app (iPhone: Safari → Share → Add to Home Screen). No Apple signing.
// The iPhone app's in-page backend (ios/JobEstimator/web/ios-backend.js) runs unchanged; it asks
// the Swift app for a few things a page "can't" do. This file does those same things with plain
// browser features instead, and ios-backend.js uses it when window.JE_NATIVE is set:
//   key        -> localStorage on this phone (the Swift app uses the Keychain)
//   network    -> fetch(), with Anthropic's browser-access header for Claude
//   estimates  -> IndexedDB on this phone
//   talk       -> Safari's speech recognition (index.html's own "web" path)
//   print/share/open/keep-awake -> window.print, the share sheet, a new tab, the Wake Lock API
// What a web app can't do: reach the PC (https pages can't call http:// on the Wi-Fi), so
// previews and the PC's photo-reading AI need the installed Windows, Mac or Android app.
(() => {
  "use strict";
  const KEY = "je_web_key";

  // ---- saved estimates in IndexedDB (localStorage is only ~5 MB) ----
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((ok, fail) => {
    const r = indexedDB.open("job-estimator", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("estimates");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  }));
  const store = async (mode, fn) => {
    const t = (await db()).transaction("estimates", mode);
    const req = fn(t.objectStore("estimates"));
    return new Promise((ok, fail) => { t.oncomplete = () => ok(req.result); t.onerror = () => fail(t.error); });
  };

  async function http({method, url, headers = {}, body = null, timeout = 60}) {
    if (url.startsWith("http://") && location.protocol === "https:")
      throw new Error("a web app can't reach the PC - use the installed app for that");
    if (url.startsWith("https://api.anthropic.com/")) headers = {...headers, "anthropic-dangerous-direct-browser-access": "true"};
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout * 1000);
    try {
      const r = await fetch(url, {method, headers, body, signal: ctl.signal});
      return {status: r.status, body: await r.text()};
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "timed out" : (e.message || "network error"));
    } finally { clearTimeout(t); }
  }

  // ---- talk: kept for completeness; status says dictation "web" so index.html drives Safari's recognizer itself
  let rec = null, heard = [];
  function listenStart() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error("No speech recognition here - tap the 🎤 on the keyboard instead.");
    heard = []; rec = new SR(); rec.lang = "en-US"; rec.continuous = true;
    rec.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard.push(e.results[i][0].transcript); };
    rec.start();
  }
  const listenStop = () => new Promise(ok => {
    if (!rec) return ok("");
    rec.onend = () => { rec = null; ok(heard.join(" ").trim()); };
    rec.stop();
  });

  let lock = null, busyWanted = false;
  async function busy(on) {
    busyWanted = on;
    try {
      if (on && !lock && navigator.wakeLock) lock = await navigator.wakeLock.request("screen");
      if (!on && lock) { await lock.release(); lock = null; }
    } catch { lock = null; }
  }

  async function share({name, text, mime}) {
    const file = new File([text], name, {type: mime});
    try {
      if (navigator.canShare?.({files: [file]})) return await navigator.share({files: [file], title: name});
      if (navigator.share && mime === "text/plain") return await navigator.share({title: name, text});
    } catch (e) { if (e.name === "AbortError") return; }
    const a = Object.assign(document.createElement("a"), {href: URL.createObjectURL(file), download: name});
    document.body.append(a); a.click(); a.remove();
  }

  const cmds = {
    getKey: () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } },
    setKey: ({key}) => { try { key ? localStorage.setItem(KEY, key) : localStorage.removeItem(KEY); } catch {} },
    http,
    listEstimates: async () => (await store("readonly", s => s.getAll())) || [],
    getEstimate: ({id}) => store("readonly", s => s.get(id)),
    saveEstimate: ({id, json}) => store("readwrite", s => s.put(json, id)),
    listenStart, listenStop,
    busy: ({on}) => busy(on),
    print: () => window.print(),
    share,
    open: ({url}) => { window.open(url, "_blank", "noopener"); },
  };
  window.JE_NATIVE = async (cmd, args = {}) => {
    if (!cmds[cmd]) throw new Error("unknown command " + cmd);
    return cmds[cmd](args);
  };
  // re-take the wake lock when coming back to the app (iOS drops it when the screen turns off)
  document.addEventListener("visibilitychange", () => { if (busyWanted && document.visibilityState === "visible") { lock = null; busy(true); } });

  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
