const express = require("express");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const { maintainKey, startPeriodicMaintenance } = require("./keyMaintenance");

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // Timeframe
  max: 10000, // Max requests per timeframe per ip
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (request, response, next, options) => {
    // writeErrorLog(
    //   `Too many misc API requests`,
    //   `IP ${request.client._peername.address}`
    // );
    return response.status(options.statusCode).send(options.message);
  },
});

const app = express();
const port = 5000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

var corsOptions = {
  origin: "*",
};

app.use(cors(corsOptions));
// app.use(apiLimiter);

app.use(function (req, res, next) {
  if (req.secure) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }
  next();
});

app.use(
  "/legacy_viewer",
  express.static(path.join(__dirname, "legacy_viewer")),
);

app.use("/viewer", express.static(path.join(__dirname, "viewer/build")));

app.use("/editor", express.static(path.join(__dirname, "editor/build")));



const getKey = (uuid) => {
  var files = fs
    .readdirSync(path.join(__dirname, "keys"))
    .filter((fn) => fn.startsWith(uuid));
  if (files.length > 0) {
    const path = `keys/${files[0]}`;
    return path;
  }
  return null;
};

// for /key/:uuid requests, return the corresponding json file
app.get("/key/:uuid", async (req, res) => {
  const uuid = req.params.uuid;

  // get the json file starting with the uuid
  var keyfile = getKey(uuid);

  if (keyfile) {
    res.sendFile(keyfile, { root: __dirname });
    maintainKey(keyfile).catch(e => console.error(`[maintenance] Error:`, e.message));
    return;
  } else {
    // if the key is not found, get all keys from the github repo https://github.com/Artsdatabanken/clavis-keys and store them in the keys folder
    const { execSync } = require("child_process");
    execSync(`git clone https://github.com/Artsdatabanken/clavis-keys.git`);

    var files = fs.readdirSync(path.join(__dirname, "clavis-keys"));

    files.forEach((file) => {
      // if the file is a json file and it is not in the keys folder or the file in the keys folder is not the same size as the file in the clavis-keys folder, move the file to the keys folder
      if (
        file.endsWith(".json") &&
        (!fs.existsSync(`keys/${file}`) ||
          fs.statSync(`clavis-keys/${file}`).size !=
            fs.statSync(
              `keys/${fs.readdirSync(path.join(__dirname, "keys"))[0]}`
            ).size)
      ) {
        fs.rmSync(`keys/${file}`, { recursive: true, force: true });
        fs.renameSync(`clavis-keys/${file}`, `keys/${file}`);
      }
      // otherwise, delete the file
      else {
        fs.rmSync(`clavis-keys/${file}`, { recursive: true, force: true });
      }
    });
  }

  // Try again to get the json file starting with the uuid now that it should be in the keys folder
  keyfile = getKey(uuid);
  if (keyfile) {
    await maintainKey(keyfile);
    res.sendFile(keyfile, { root: __dirname });
    return;
  }

  // if the key is still not found, return 404
  res.status(404).send("Key not found");
});

// Force refetch a key from the github repo
app.post("/key/:uuid/refetch", async (req, res) => {
  const uuid = req.params.uuid;
  const { execSync } = require("child_process");

  const cleanup = () => {
    try {
      execSync(`rm -rf clavis-keys`, { cwd: __dirname });
    } catch (e) {
      // Ignore cleanup errors
    }
  };

  try {
    // Remove existing clavis-keys directory if it exists
    cleanup();

    // Clone the repo
    execSync(`git clone https://github.com/Artsdatabanken/clavis-keys.git`, {
      cwd: __dirname,
      timeout: 60000,
    });

    // Find the file matching the uuid in the cloned repo
    var clonedFiles = fs
      .readdirSync(path.join(__dirname, "clavis-keys"))
      .filter((fn) => fn.startsWith(uuid) && fn.endsWith(".json"));

    if (clonedFiles.length === 0) {
      cleanup();
      return res.status(404).send("Key not found in repository");
    }

    // Remove old key file(s) from keys folder
    var existingFiles = fs
      .readdirSync(path.join(__dirname, "keys"))
      .filter((fn) => fn.startsWith(uuid));
    existingFiles.forEach((file) => {
      fs.rmSync(path.join(__dirname, "keys", file), { recursive: true, force: true });
    });

    // Move the new file to keys folder
    const newFile = clonedFiles[0];
    fs.renameSync(
      path.join(__dirname, "clavis-keys", newFile),
      path.join(__dirname, "keys", newFile)
    );

    // Clean up remaining cloned files
    cleanup();

    await maintainKey(`keys/${newFile}`);

    res.status(200).json({ success: true, message: "Key refetched successfully", file: newFile });
  } catch (error) {
    cleanup();
    res.status(500).json({ success: false, message: "Failed to refetch key", error: error.message });
  }
});

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

const fetchAllKeys = () => {
  const { execSync } = require("child_process");
  const keysDir = path.join(__dirname, "keys");
  const cloneDir = path.join(__dirname, "clavis-keys");

  try { execSync(`rm -rf clavis-keys`, { cwd: __dirname }); } catch (e) {}

  execSync(`git clone https://github.com/Artsdatabanken/clavis-keys.git`, {
    cwd: __dirname,
    timeout: 60000,
  });

  if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir);

  fs.readdirSync(cloneDir)
    .filter((f) => f.endsWith(".json"))
    .forEach((file) => {
      const dest = path.join(keysDir, file);
      if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
      fs.renameSync(path.join(cloneDir, file), dest);
    });

  try { execSync(`rm -rf clavis-keys`, { cwd: __dirname }); } catch (e) {}
};

app.get("/keys", (req, res) => {
  const preferred = (req.query.lang ? [req.query.lang] : [])
    .concat(["en", "nb", "nn"]);

  const keysDir = path.join(__dirname, "keys");
  let files = [];
  try {
    files = fs.readdirSync(keysDir).filter((f) => f.endsWith(".json"));
  } catch (e) {
    files = [];
  }

  if (files.length === 0) {
    try {
      fetchAllKeys();
      files = fs.readdirSync(keysDir).filter((f) => f.endsWith(".json"));
    } catch (e) {
      return res
        .status(500)
        .send(`Failed to fetch keys: ${escapeHtml(e.message)}`);
    }
  }

  const entries = files
    .map((file) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(keysDir, file), "utf8"));
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
        };
      } catch (e) {
        return null;
      }
    })
    .filter((k) => k && k.id)
    .sort((a, b) => a.title.localeCompare(b.title));

  const cards = entries
    .map((k) => {
      const meta = [];
      if (k.geography)
        meta.push(`<span class="badge geo" title="Geographic scope">📍 ${escapeHtml(k.geography)}</span>`);
      if (k.taxaCount != null)
        meta.push(`<span class="badge">${k.taxaCount} taxa</span>`);
      if (k.languages.length)
        meta.push(
          `<span class="badge">${k.languages
            .map((l) => escapeHtml(l))
            .join(" · ")}</span>`
        );

      const license = k.license
        ? `<a href="${escapeHtml(k.license)}" target="_blank" rel="noopener">${escapeHtml(licenseLabel(k.license))}</a>`
        : "—";
      const modified = k.lastModified
        ? escapeHtml(k.lastModified.split(" ")[0])
        : "—";

      const footerFields = [
        k.creator ? `<span class="field">Creator<strong>${escapeHtml(k.creator)}</strong></span>` : "",
        `<span class="field">License<strong>${license}</strong></span>`,
        `<span class="field">Updated<strong>${modified}</strong></span>`,
      ].filter(Boolean).join("");

      return `
        <article class="card">
          <div class="card-head">
            <div>
              <h2><a href="/?id=${encodeURIComponent(k.id)}">${escapeHtml(k.title)}</a></h2>
              ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
            </div>
            <a class="open" href="/?id=${encodeURIComponent(k.id)}">Open →</a>
          </div>
          ${k.description ? `<p class="desc">${escapeHtml(k.description)}</p>` : ""}
          <footer class="card-foot">${footerFields}</footer>
        </article>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="darkreader-lock">
<title>Clavis keys</title>
<style>
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
    flex-direction: column;
    gap: .75rem;
    transition: border-color .12s ease, box-shadow .12s ease;
  }
  .card:hover {
    border-color: var(--accent);
    box-shadow: 0 4px 16px rgba(0,0,0,.06);
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
</style>
</head>
<script>
  (function () {
    try {
      var saved = localStorage.getItem("clavis-theme");
      if (saved === "dark" || saved === "light") {
        document.documentElement.setAttribute("data-theme", saved);
      }
    } catch (e) {}
  })();
</script>
<body>
  <main class="page">
    <header>
      <div>
        <h1>Clavis keys</h1>
        <p>${entries.length} identification ${entries.length === 1 ? "key" : "keys"} available.</p>
      </div>
      <button type="button" class="theme-toggle" id="theme-toggle" aria-label="Toggle colour theme">
        <span class="icon-light" aria-hidden="true">☀️</span><span class="icon-dark" aria-hidden="true">🌙</span>
        <span class="label">Theme</span>
      </button>
    </header>
    ${entries.length ? `<div class="list">${cards}</div>` : `<p class="empty">No keys found.</p>`}
  </main>
  <script>
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
  </script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.get("/", (req, res) => {
  // if there is no uuid argument, redirect to the legacy viewer
  if (req.url.includes("csv")) {
    return res.redirect(`/legacy_viewer${req.url}`);
  } else {
    return res.redirect(`/viewer${req.url}`);
  }
});

app.get("/version", (req, res) => {
  let v = "Gitless";
  const gitfile = ".git/FETCH_HEAD";
  if (fs.existsSync(gitfile)) {
    v = fs.readFileSync(gitfile).toString().split("\t")[0];
  }

  fs.stat("./server.js", function (err, stats) {
    res.status(200).send(`<h3>${v}</h3><hr/>${stats.mtime.toUTCString()}`);
  });
});

// app.use('/', express.static('legacy_editor'))

app.listen(port, () => {
  console.log(`Server now running on port ${port}`);
  startPeriodicMaintenance();
});
