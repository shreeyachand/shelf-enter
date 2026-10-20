// Offscreen document: parses fetched giveaway HTML with DOMParser
// (unavailable in the MV3 service worker) to find how to enter.
//
// Current Goodreads flow: the enter_choose_address page lists saved addresses,
// each with a Rails `data-method=post` "select this address" link:
//   POST /giveaway/enter_choose_address/{id}?address={addressId}
// authenticated by the <meta name="csrf-token"> value. No terms form anymore.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  try {
    if (msg.type === "PARSE_FORM") sendResponse(parseEntry(msg.html, msg.baseUrl));
    else if (msg.type === "PARSE_TERMS") sendResponse(parseTerms(msg.html, msg.baseUrl));
  } catch (e) {
    sendResponse({ found: false, reason: String(e?.message || e) });
  }
  return true;
});

function abs(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

// Climb a few ancestors to grab the address text (for preferred-address matching).
function nearestLabel(a) {
  let el = a;
  for (let i = 0; i < 5 && el; i++) {
    el = el.parentElement;
    if (!el) break;
    let txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    txt = txt.replace(/select this address/gi, "").replace(/edit address/gi, "").replace(/delete/gi, "").trim();
    if (txt.length >= 8) return txt.slice(0, 140);
  }
  return "address " + (a.getAttribute("href")?.match(/address=(\d+)/)?.[1] || "");
}

// Step 2: the print/kindle giveaway terms page returned after choosing an
// address. Find the confirm form, check every agreement box, keep hidden fields.
function parseTerms(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let form =
    doc.querySelector('form[action*="enter_print_giveaway"], form[action*="enter_giveaway"], form[action*="enter_kindle"]') ||
    [...doc.querySelectorAll("form")].find(
      (f) => /terms|agree|rules/i.test(f.textContent || "") && f.querySelector('input[type="checkbox"]')
    );

  if (!form) {
    return { found: false, reason: "No confirm/terms form on step-2 page" };
  }

  const action = abs(form.getAttribute("action") || baseUrl, baseUrl);
  const method = form.getAttribute("method") || "POST";
  const fields = [];
  const agreements = [];
  let token = null;

  for (const el of form.querySelectorAll("input, select, textarea, button")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const tag = el.tagName.toLowerCase();

    if (tag === "select") {
      const opt = el.options[el.selectedIndex] || el.querySelector("option[selected]") || el.options[0];
      fields.push({ name, value: opt ? opt.value : "" });
      continue;
    }
    if (tag === "textarea") {
      fields.push({ name, value: el.value || el.textContent || "" });
      continue;
    }
    if (tag === "button") {
      if (name === "commit" || el.getAttribute("type") === "submit")
        fields.push({ name, value: el.getAttribute("value") || el.textContent.trim() || "" });
      continue;
    }

    const type = (el.getAttribute("type") || "text").toLowerCase();
    const value = el.getAttribute("value") ?? "";
    if (name === "authenticity_token") token = value;

    if (type === "checkbox") {
      // Submit every (enabled) checkbox in the entry form. Goodreads now shows
      // multiple required agreements (terms + Want to Read). Collecting them
      // all matters: only submitting one leaves the terms page re-rendered.
      if (!el.disabled) agreements.push({ name, value: value || "1" });
      continue;
    }
    if (type === "radio") {
      if (el.hasAttribute("checked")) fields.push({ name, value });
      continue;
    }
    if (type === "submit") {
      if (name === "commit") fields.push({ name, value });
      continue;
    }
    if (type === "button" || type === "image" || type === "reset") continue;

    fields.push({ name, value }); // hidden, text, etc.
  }

  return { found: true, action, method, fields, agreements, token };
}

function parseEntry(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const bodyText = (doc.body?.textContent || "").replace(/\s+/g, " ").trim();

  const diag = {
    pageTitle: doc.querySelector("title")?.textContent?.trim() || "",
    signedOut: /Sign up for Goodreads|Already a member\?|Sign in to your account/i.test(bodyText),
    alreadyEntered: /you('|’)ve entered|you('|’)re entered|already entered|entry submitted/i.test(bodyText),
  };

  const csrf = doc.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || null;

  // "select this address" links: enter_choose_address with an address= param.
  const addresses = [];
  for (const a of doc.querySelectorAll('a[href*="enter_choose_address"]')) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/[?&]address=(\d+)/);
    if (!m) continue; // skip the show-page CTA (no address param)
    addresses.push({ id: m[1], url: abs(href, baseUrl), label: nearestLabel(a) });
  }

  if (addresses.length) {
    return { found: true, csrf, addresses, diag };
  }

  // No address links. Maybe this is a show page whose CTA points to the enter
  // page — follow it. Otherwise report why.
  const cta = doc.querySelector('a[href*="enter_choose_address"]');
  if (diag.signedOut) return { found: false, reason: "Background fetch is NOT logged in", diag };
  if (diag.alreadyEntered) return { found: false, reason: "Already entered", diag };
  return {
    found: false,
    enterLink: cta ? abs(cta.getAttribute("href"), baseUrl) : null,
    reason: "No saved-address entry links found (add a shipping address on Goodreads?)",
    diag,
  };
}
