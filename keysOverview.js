const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const KEYS_DIR = path.join(__dirname, "keys");
const CLONE_DIR = path.join(__dirname, "clavis-keys");

const escapeHtml = (str) =>
  String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);

const pickLocalized = (field, preferred) => {
  if (field == null) return null;
  if (typeof field === "string") return field;
  if (typeof field !== "object") return null;
  for (const lang of preferred) {
    if (field[lang]) return field[lang];
  }
  const first = Object.values(field).find((v) => v);
  return first ?? null;
};

const licenseLabel = (url) => {
  if (!url) return null;
  const m = url.match(/creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i);
  if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`;
  const pd = url.match(/creativecommons\.org\/publicdomain\/([a-z-]+)/i);
  if (pd) return `CC ${pd[1].toUpperCase()}`;
  return url;
};

const resolveMediaUrl = (mediaId, mediaElements) => {
  if (!mediaId || !Array.isArray(mediaElements)) return null;
  const el = mediaElements.find((m) => m.id === mediaId);
  const file = el && el.mediaElement && el.mediaElement.file;
  if (!file) return null;
  if (typeof file.file === "string") return file.file;
  const url = file.url;
  if (url && url.serviceId === "service:nbic_media" && url.externalId) {
    return `https://www.artsdatabanken.no/Media/${encodeURIComponent(url.externalId)}?mode=480x480`;
  }
  return null;
};

const findTaxonMedia = (taxa) => {
  if (!Array.isArray(taxa)) return null;
  const queue = [...taxa];
  while (queue.length) {
    const t = queue.shift();
    if (t && t.media) return t.media;
    if (t && Array.isArray(t.children)) queue.push(...t.children);
  }
  return null;
};

const pickImageUrl = (data) => {
  const mediaId = data.media || findTaxonMedia(data.taxa);
  return resolveMediaUrl(mediaId, data.mediaElements);
};

const fetchAllKeys = () => {
  try { execSync(`rm -rf clavis-keys`, { cwd: __dirname }); } catch (e) {}

  execSync(`git clone https://github.com/Artsdatabanken/clavis-keys.git`, {
    cwd: __dirname,
    timeout: 60000,
  });

  if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR);

  fs.readdirSync(CLONE_DIR)
    .filter((f) => f.endsWith(".json"))
    .forEach((file) => {
      const dest = path.join(KEYS_DIR, file);
      if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
      fs.renameSync(path.join(CLONE_DIR, file), dest);
    });

  try { execSync(`rm -rf clavis-keys`, { cwd: __dirname }); } catch (e) {}
};

const readEntry = (file, preferred) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, file), "utf8"));
    const creatorPerson = data.creator
      ? (data.persons || []).find((p) => p.id === data.creator)
      : null;
    return {
      id: data.identifier,
      title: pickLocalized(data.title, preferred) || "Untitled",
      description: pickLocalized(data.description, preferred),
      geography: pickLocalized(data.geography && data.geography.name, preferred),
      creator: creatorPerson ? pickLocalized(creatorPerson.name, preferred) : null,
      license: data.license,
      languages: data.language || [],
      taxaCount: Array.isArray(data.taxa) ? data.taxa.length : null,
      lastModified: data.lastModified,
      image: pickImageUrl(data),
    };
  } catch (e) {
    return null;
  }
};

const renderCard = (k) => {
  const meta = [];
  if (k.geography)
    meta.push(`<span class="badge geo" title="Geographic scope">📍 ${escapeHtml(k.geography)}</span>`);
  if (k.taxaCount != null)
    meta.push(`<span class="badge">${k.taxaCount} taxa</span>`);
  if (k.languages.length)
    meta.push(
      `<span class="badge">${k.languages.map((l) => escapeHtml(l)).join(" · ")}</span>`
    );

  const license = k.license
    ? `<a href="${escapeHtml(k.license)}" target="_blank" rel="noopener">${escapeHtml(licenseLabel(k.license))}</a>`
    : "—";
  const modified = k.lastModified ? escapeHtml(k.lastModified.split(" ")[0]) : "—";

  const footerFields = [
    k.creator ? `<span class="field">Creator<strong>${escapeHtml(k.creator)}</strong></span>` : "",
    `<span class="field">License<strong>${license}</strong></span>`,
    `<span class="field">Updated<strong>${modified}</strong></span>`,
  ].filter(Boolean).join("");

  const thumb = k.image
    ? `<a class="thumb" href="/?id=${encodeURIComponent(k.id)}" aria-hidden="true" tabindex="-1"><img src="${escapeHtml(k.image)}" alt="" loading="lazy"></a>`
    : "";

  return `
        <article class="card${k.image ? " has-thumb" : ""}">
          ${thumb}
          <div class="card-body">
            <div class="card-head">
              <div>
                <h2><a href="/?id=${encodeURIComponent(k.id)}">${escapeHtml(k.title)}</a></h2>
                ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
              </div>
              <a class="open" href="/?id=${encodeURIComponent(k.id)}">Open →</a>
            </div>
            ${k.description ? `<p class="desc">${escapeHtml(k.description)}</p>` : ""}
            <footer class="card-foot">${footerFields}</footer>
          </div>
        </article>`;
};

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --fg: #1a1f2c;
    --muted: #5b6473;
    --card: #ffffff;
    --border: #e3e6ec;
    --accent: #2c6e49;
    --accent-hover: #1f5237;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #11151c;
      --fg: #e8ecf2;
      --muted: #97a0af;
      --card: #1a2029;
      --border: #2a313d;
      --accent: #6ed29c;
      --accent-hover: #94e2b7;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #11151c;
    --fg: #e8ecf2;
    --muted: #97a0af;
    --card: #1a2029;
    --border: #2a313d;
    --accent: #6ed29c;
    --accent-hover: #94e2b7;
  }
  :root[data-theme="light"] {
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.5;
  }
  .page {
    max-width: 820px;
    margin: 0 auto;
    padding: 3rem 1.5rem 4rem;
  }
  .page > header {
    margin-bottom: 2.5rem;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  .page > header h1 {
    margin: 0 0 .5rem;
    font-size: 2rem;
    font-weight: 600;
  }
  .page > header p {
    margin: 0;
    color: var(--muted);
  }
  .theme-toggle {
    flex-shrink: 0;
    background: var(--card);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 999px;
    padding: .5rem .9rem;
    font: inherit;
    font-size: .85rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: .4rem;
    transition: border-color .12s ease, color .12s ease;
  }
  .theme-toggle:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .theme-toggle .icon-light,
  .theme-toggle .icon-dark { display: none; }
  :root:not([data-theme="dark"]) .theme-toggle .icon-light { display: inline; }
  :root[data-theme="dark"] .theme-toggle .icon-dark { display: inline; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .theme-toggle .icon-light { display: none; }
    :root:not([data-theme="light"]) .theme-toggle .icon-dark { display: inline; }
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.25rem 1.5rem;
    display: flex;
    gap: 1.25rem;
    transition: border-color .12s ease, box-shadow .12s ease;
  }
  .card:hover {
    border-color: var(--accent);
    box-shadow: 0 4px 16px rgba(0,0,0,.06);
  }
  .card-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: .75rem;
  }
  .thumb {
    flex-shrink: 0;
    width: 96px;
    height: 96px;
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg);
    display: block;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  @media (max-width: 500px) {
    .card { flex-direction: column; }
    .thumb { width: 100%; height: 160px; }
  }
  .card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  .card-head > div { min-width: 0; flex: 1; }
  .card h2 {
    margin: 0 0 .5rem;
    font-size: 1.15rem;
    font-weight: 600;
    line-height: 1.3;
  }
  .card h2 a {
    color: inherit;
    text-decoration: none;
  }
  .card h2 a:hover { color: var(--accent); }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: .375rem;
  }
  .badge {
    display: inline-block;
    padding: .15rem .55rem;
    font-size: .75rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
  }
  .badge.geo { color: var(--fg); }
  .desc {
    margin: 0;
    color: var(--muted);
    font-size: .92rem;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .card-foot {
    margin: 0;
    padding-top: .75rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    gap: .25rem 1.25rem;
    font-size: .85rem;
    color: var(--muted);
  }
  .card-foot .field strong {
    color: var(--fg);
    font-weight: 500;
    margin-left: .25rem;
  }
  .card-foot a {
    color: var(--accent);
    text-decoration: none;
  }
  .card-foot a:hover { text-decoration: underline; }
  .open {
    flex-shrink: 0;
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
    font-size: .9rem;
    white-space: nowrap;
  }
  .open:hover { color: var(--accent-hover); }
  .empty {
    text-align: center;
    color: var(--muted);
    padding: 4rem 0;
  }
`;

const INIT_SCRIPT = `
  (function () {
    try {
      var saved = localStorage.getItem("clavis-theme");
      if (saved === "dark" || saved === "light") {
        document.documentElement.setAttribute("data-theme", saved);
      }
    } catch (e) {}
  })();
`;

const TOGGLE_SCRIPT = `
  (function () {
    var root = document.documentElement;
    var btn = document.getElementById("theme-toggle");
    btn.addEventListener("click", function () {
      var current = root.getAttribute("data-theme");
      var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      var effective = current || (systemDark ? "dark" : "light");
      var next = effective === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("clavis-theme", next); } catch (e) {}
    });
  })();
`;

const renderPage = (entries) => {
  const cards = entries.map(renderCard).join("\n");
  const count = `${entries.length} identification ${entries.length === 1 ? "key" : "keys"} available.`;
  const body = entries.length
    ? `<div class="list">${cards}</div>`
    : `<p class="empty">No keys found.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="darkreader-lock">
<title>Clavis keys</title>
<style>${STYLES}</style>
</head>
<script>${INIT_SCRIPT}</script>
<body>
  <main class="page">
    <header>
      <div>
        <h1>Clavis keys</h1>
        <p>${count}</p>
      </div>
      <button type="button" class="theme-toggle" id="theme-toggle" aria-label="Toggle colour theme">
        <span class="icon-light" aria-hidden="true">☀️</span><span class="icon-dark" aria-hidden="true">🌙</span>
        <span class="label">Theme</span>
      </button>
    </header>
    ${body}
  </main>
  <script>${TOGGLE_SCRIPT}</script>
</body>
</html>`;
};

const handler = (req, res) => {
  const preferred = (req.query.lang ? [req.query.lang] : []).concat(["en", "nb", "nn"]);

  let files = [];
  try {
    files = fs.readdirSync(KEYS_DIR).filter((f) => f.endsWith(".json"));
  } catch (e) {
    files = [];
  }

  if (files.length === 0) {
    try {
      fetchAllKeys();
      files = fs.readdirSync(KEYS_DIR).filter((f) => f.endsWith(".json"));
    } catch (e) {
      return res.status(500).send(`Failed to fetch keys: ${escapeHtml(e.message)}`);
    }
  }

  const entries = files
    .map((file) => readEntry(file, preferred))
    .filter((k) => k && k.id)
    .sort((a, b) => a.title.localeCompare(b.title));

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderPage(entries));
};

module.exports = handler;
