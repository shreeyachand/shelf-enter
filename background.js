// Background service worker: owns the async entry queue.
// Per job: GET the giveaway page (with session cookies) -> parse the entry
// form in an offscreen document -> POST the entry. No Selenium, no creds.

const STORAGE_QUEUE = "gg_queue";
const STORAGE_SETTINGS = "gg_settings";

const DEFAULT_SETTINGS = {
  preferredAddress: "", // substring matched against address label/value; empty = use pre-selected/first
  concurrency: 2,
  delayMs: 1500, // polite minimum gap between starting jobs
  maxRetries: 2,
};

let scheduling = false;
let lastStartedAt = 0;

// ---------- storage helpers ----------

async function getSettings() {
  const { [STORAGE_SETTINGS]: s } = await chrome.storage.local.get(STORAGE_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

async function getQueue() {
  const { [STORAGE_QUEUE]: q } = await chrome.storage.local.get(STORAGE_QUEUE);
  return Array.isArray(q) ? q : [];
}

async function setQueue(q) {
  await chrome.storage.local.set({ [STORAGE_QUEUE]: q });
  updateBadge(q);
}

function updateBadge(q) {
  const active = q.filter((j) => j.status === "pending" || j.status === "running").length;
  chrome.action.setBadgeText({ text: active ? String(active) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#7a5c2e" });
}

// ---------- offscreen document for DOMParser ----------

let creatingOffscreen = null;

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "Parse Goodreads giveaway entry forms (CSRF token + address fields).",
  });
  try {
    await creatingOffscreen;
  } catch (e) {
    // If it already exists due to a race, ignore.
    if (!String(e).includes("Only a single offscreen")) throw e;
  } finally {
    creatingOffscreen = null;
  }
}

async function parseForm(html, baseUrl) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", type: "PARSE_FORM", html, baseUrl });
}

async function parseTerms(html, baseUrl) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", type: "PARSE_TERMS", html, baseUrl });
}

// ---------- core entry logic ----------

function normalizeUrl(u) {
  try {
    const url = new URL(u, "https://www.goodreads.com");
    url.hash = "";
    return url.toString();
  } catch {
    return u;
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "text/html,application/xhtml+xml" },
  });
  const text = await res.text();
  return { res, text };
}

function chooseAddress(addresses, preferred) {
  if (!addresses || addresses.length === 0) return null;
  if (preferred) {
    const p = preferred.toLowerCase();
    const hit = addresses.find(
      (a) =>
        (a.label && a.label.toLowerCase().includes(p)) ||
        (a.id && String(a.id) === preferred.trim())
    );
    if (hit) return hit;
  }
  return addresses[0];
}

// GET a giveaway/entry page and parse it, following one "enter" link hop if the
// enqueued URL was a show page rather than the enter_choose_address page.
async function locateEntry(startUrl) {
  const { text } = await fetchText(startUrl);
  let parsed = await parseForm(text, startUrl);
  if (parsed && parsed.found) return parsed;

  if (parsed && parsed.enterLink) {
    const next = normalizeUrl(parsed.enterLink);
    const { text: text2 } = await fetchText(next);
    parsed = await parseForm(text2, next);
  }
  return parsed; // found or not
}

async function enterGiveaway(job, settings) {
  const parsed = await locateEntry(job.url);
  if (!parsed || !parsed.found) {
    throw new Error(parsed?.reason || "Could not find entry links (already entered, ended, or login required?)");
  }

  const addr = chooseAddress(parsed.addresses, settings.preferredAddress);
  if (!addr) throw new Error("No saved shipping address found on Goodreads.");
  job.address = addr.label || addr.id;

  // Step 1: select the address (Rails data-method=post link). The response is
  // the terms/confirm page.
  const body1 = new URLSearchParams({ utf8: "✓" });
  if (parsed.csrf) body1.append("authenticity_token", parsed.csrf);
  const res1 = await fetch(addr.url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-Token": parsed.csrf },
    body: body1.toString(),
  });
  const html1 = await res1.text();
  if (!res1.ok) throw new Error(`Step 1 responded ${res1.status}`);
  if (/sign up for goodreads|already a member\?/i.test(html1)) throw new Error("Not logged in to Goodreads.");

  // Step 2: agree to terms + submit the confirm form.
  const terms = await parseTerms(html1, res1.url);
  if (!terms || !terms.found) {
    throw new Error(terms?.reason || "Could not find the terms/confirm form.");
  }
  const body2 = new URLSearchParams();
  for (const f of terms.fields) if (f.name) body2.append(f.name, f.value ?? "");
  for (const a of terms.agreements || []) if (a.name) body2.append(a.name, a.value || "1");

  const token2 = terms.token || parsed.csrf;
  const res2 = await fetch(terms.action, {
    method: (terms.method || "POST").toUpperCase(),
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-Token": token2 },
    body: body2.toString(),
  });
  const html2 = await res2.text();
  if (!res2.ok) throw new Error(`Step 2 responded ${res2.status}`);

  const lower = html2.toLowerCase();
  if (/i have read and agree|enter_print_giveaway|enter_kindle/.test(lower) && !/you('|’)re in|you('|’)ve entered|entered you/.test(lower)) {
    throw new Error("Entry didn't register (still on terms page after submit).");
  }
  return true;
}

// ---------- scheduler ----------

async function schedule() {
  if (scheduling) return;
  scheduling = true;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const settings = await getSettings();
      const q = await getQueue();
      const running = q.filter((j) => j.status === "running").length;
      if (running >= settings.concurrency) break;

      const next = q.find((j) => j.status === "pending");
      if (!next) break;

      // Polite throttle between starts.
      const since = Date.now() - lastStartedAt;
      if (since < settings.delayMs) {
        await sleep(settings.delayMs - since);
      }

      next.status = "running";
      next.startedAt = Date.now();
      lastStartedAt = Date.now();
      await setQueue(q);

      runJob(next.id, settings); // fire and forget; updates queue on completion
    }
  } finally {
    scheduling = false;
  }
}

async function runJob(jobId, settings) {
  let success = false;
  let error = null;
  let address = null;
  try {
    const q = await getQueue();
    const job = q.find((j) => j.id === jobId);
    if (!job) return;
    await enterGiveaway(job, settings);
    address = job.address || null;
    success = true;
  } catch (e) {
    error = String(e?.message || e);
  }

  const q = await getQueue();
  const job = q.find((j) => j.id === jobId);
  if (job) {
    if (success) {
      job.status = "success";
      job.address = address;
      job.finishedAt = Date.now();
      job.error = null;
    } else {
      job.attempts = (job.attempts || 0) + 1;
      if (job.attempts <= settings.maxRetries) {
        job.status = "pending"; // retry
        job.error = `${error} (retry ${job.attempts}/${settings.maxRetries})`;
      } else {
        job.status = "failed";
        job.error = error;
        job.finishedAt = Date.now();
      }
    }
    await setQueue(q);
  }
  schedule();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- messaging ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return; // ignore offscreen-targeted msgs

  (async () => {
    switch (msg.type) {
      case "ENQUEUE": {
        const url = normalizeUrl(msg.url);
        const q = await getQueue();
        const existing = q.find(
          (j) => j.url === url && (j.status === "pending" || j.status === "running")
        );
        if (existing) {
          sendResponse({ ok: true, duplicate: true });
          return;
        }
        q.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          url,
          title: msg.title || url,
          status: "pending",
          attempts: 0,
          error: null,
          queuedAt: Date.now(),
        });
        await setQueue(q);
        schedule();
        sendResponse({ ok: true });
        break;
      }
      case "DRY_RUN": {
        // Parse + build the POST body for a giveaway WITHOUT entering.
        // Runs in your authenticated session (background fetch sends cookies).
        const settings = await getSettings();
        try {
          const url = normalizeUrl(msg.url);
          const parsed = await locateEntry(url);
          if (!parsed || !parsed.found) {
            sendResponse({ ok: false, reason: parsed?.reason, parsed });
            break;
          }
          const addr = chooseAddress(parsed.addresses, settings.preferredAddress);
          const body = new URLSearchParams({ utf8: "✓" });
          if (parsed.csrf) body.append("authenticity_token", parsed.csrf);
          sendResponse({
            ok: true,
            wouldPostTo: addr?.url,
            chosenAddress: addr,
            allAddresses: parsed.addresses,
            csrf: parsed.csrf?.slice(0, 8) + "…",
            body: body.toString(),
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
        break;
      }
      case "GET_QUEUE": {
        sendResponse({ queue: await getQueue() });
        break;
      }
      case "CLEAR_FINISHED": {
        const q = (await getQueue()).filter(
          (j) => j.status === "pending" || j.status === "running"
        );
        await setQueue(q);
        sendResponse({ ok: true, queue: q });
        break;
      }
      case "REMOVE_JOB": {
        const q = (await getQueue()).filter((j) => j.id !== msg.id);
        await setQueue(q);
        sendResponse({ ok: true, queue: q });
        break;
      }
      case "RETRY_JOB": {
        const q = await getQueue();
        const job = q.find((j) => j.id === msg.id);
        if (job) {
          job.status = "pending";
          job.attempts = 0;
          job.error = null;
        }
        await setQueue(q);
        schedule();
        sendResponse({ ok: true, queue: q });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();

  return true; // keep the message channel open for async sendResponse
});

// Resume after the service worker wakes: requeue interrupted jobs.
async function resume() {
  const q = await getQueue();
  let changed = false;
  for (const j of q) {
    if (j.status === "running") {
      j.status = "pending";
      changed = true;
    }
  }
  if (changed) await setQueue(q);
  else updateBadge(q);
  schedule();
}

chrome.runtime.onStartup.addListener(resume);
chrome.runtime.onInstalled.addListener(resume);
resume();
