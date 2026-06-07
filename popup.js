const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

// The queued URL is the enter page; link the title to the giveaway show page.
function showUrl(url) {
  return (url || "").replace("/giveaway/enter_choose_address/", "/giveaway/show/");
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function render(queue) {
  listEl.innerHTML = "";
  if (!queue || queue.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  // Most recent first.
  const sorted = [...queue].sort((a, b) => (b.queuedAt || 0) - (a.queuedAt || 0));
  for (const job of sorted) {
    const li = document.createElement("li");

    const title = document.createElement("a");
    title.className = "title";
    title.textContent = job.title || job.url;
    title.href = showUrl(job.url);
    title.target = "_blank";
    title.rel = "noopener";
    title.title = "Open giveaway on Goodreads";
    li.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "meta";

    const badge = document.createElement("span");
    badge.className = `badge ${job.status}`;
    badge.textContent = job.status;
    meta.appendChild(badge);

    const right = document.createElement("span");
    right.className = "row-actions";
    if (job.address && job.status === "success") {
      right.appendChild(document.createTextNode(`→ ${job.address}  `));
    }
    right.appendChild(document.createTextNode(fmtTime(job.finishedAt || job.startedAt || job.queuedAt)));

    if (job.status === "failed") {
      const retry = document.createElement("a");
      retry.textContent = "retry";
      retry.onclick = async () => render((await send({ type: "RETRY_JOB", id: job.id })).queue);
      right.appendChild(retry);
    }
    const remove = document.createElement("a");
    remove.textContent = "✕";
    remove.onclick = async () => render((await send({ type: "REMOVE_JOB", id: job.id })).queue);
    right.appendChild(remove);

    meta.appendChild(right);
    li.appendChild(meta);

    if (job.error) {
      const err = document.createElement("div");
      err.className = "err";
      err.textContent = job.error;
      li.appendChild(err);
    }

    listEl.appendChild(li);
  }
}

async function refresh() {
  const { queue } = await send({ type: "GET_QUEUE" });
  render(queue);
}

document.getElementById("clear").onclick = async () => {
  const { queue } = await send({ type: "CLEAR_FINISHED" });
  render(queue);
};
document.getElementById("options").onclick = () => chrome.runtime.openOptionsPage();

// Live-update while open.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.gg_queue) render(changes.gg_queue.newValue || []);
});

refresh();
setInterval(refresh, 1500);
