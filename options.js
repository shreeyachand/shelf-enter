const DEFAULTS = {
  preferredAddress: "",
  concurrency: 2,
  delayMs: 1500,
  maxRetries: 2,
};

const fields = ["preferredAddress", "concurrency", "delayMs", "maxRetries"];

async function load() {
  const { gg_settings } = await chrome.storage.local.get("gg_settings");
  const s = { ...DEFAULTS, ...(gg_settings || {}) };
  for (const f of fields) document.getElementById(f).value = s[f];
}

document.getElementById("save").onclick = async () => {
  const s = {
    preferredAddress: document.getElementById("preferredAddress").value.trim(),
    concurrency: clamp(parseInt(document.getElementById("concurrency").value, 10), 1, 5, 2),
    delayMs: clamp(parseInt(document.getElementById("delayMs").value, 10), 0, 60000, 1500),
    maxRetries: clamp(parseInt(document.getElementById("maxRetries").value, 10), 0, 5, 2),
  };
  await chrome.storage.local.set({ gg_settings: s });
  const saved = document.getElementById("saved");
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
};

function clamp(n, min, max, fallback) {
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

load();
