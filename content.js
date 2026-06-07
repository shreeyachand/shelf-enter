// Adds quick-enter to Goodreads' own "Enter Giveaway" links WITHOUT mutating
// the page's (React-managed) DOM — doing so crashes Goodreads' app. The ⚡
// marker is pure CSS (::before) and clicks are caught via one document-level
// capture listener; feedback shows in our own toast.

(function () {
  // The entry page's "select this address" links also point at
  // enter_choose_address; don't interfere there.
  if (/\/giveaway\/enter/.test(location.pathname)) return;

  const SEL = 'a[href*="/giveaway/enter_choose_address/"]';

  // ⚡ marker via injected CSS — no DOM node changes, so React won't choke.
  const style = document.createElement("style");
  style.textContent = `${SEL}::before { content: "⚡ "; }`;
  (document.head || document.documentElement).appendChild(style);

  let toast;
  let toastTimer;
  function showToast(text, kind) {
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "gg-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.className = "gg-toast gg-show" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.className = "gg-toast"), 2600);
  }

  function enterUrl(href) {
    try {
      const u = new URL(href, location.origin);
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch {
      return null;
    }
  }

  function titleFrom(href, el) {
    const m = href.match(/enter_choose_address\/(\d+)(?:-([^/?#]+))?/);
    if (m && m[2]) {
      return decodeURIComponent(m[2]).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return (el?.textContent || "").trim() || href;
  }

  document.addEventListener(
    "click",
    (e) => {
      const a = e.target.closest?.(SEL);
      if (!a) return;
      const url = enterUrl(a.getAttribute("href") || "");
      if (!url) return;

      e.preventDefault();
      e.stopImmediatePropagation(); // beat Goodreads' rails-ujs / React handlers

      const title = titleFrom(a.getAttribute("href"), a);
      showToast("⚡ Queuing…");
      chrome.runtime.sendMessage({ type: "ENQUEUE", url, title }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          showToast("⚠ Couldn't queue — reload the page", "gg-err");
          return;
        }
        showToast(resp.duplicate ? "⚡ Already queued" : "✓ Queued: " + title, "gg-ok");
      });
    },
    true // capture phase
  );
})();
