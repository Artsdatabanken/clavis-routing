const express = require("express");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const path = require("path");
const { maintainKey, maintainAllKeys, startPeriodicMaintenance } = require("./keyMaintenance");
const { isValidId, getKeyFile, refreshKeys, refreshOnMiss } = require("./keyStore");
const keysOverview = require("./keysOverview");

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

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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

const devViewerUrl = process.env.NODE_ENV === "development" && process.env.DEV_VIEWER_URL;
const devEditorUrl = process.env.NODE_ENV === "development" && process.env.DEV_EDITOR_URL;

const devProxies = [];

function devProxy(routePath, target) {
  const { createProxyMiddleware } = require("http-proxy-middleware");
  // pathFilter + mounting at root keeps the routePath in the forwarded URL.
  // (Mounting via app.use(routePath, mw) would strip routePath before
  //  reaching the proxy, but CRA dev servers configured with homepage=routePath
  //  serve assets under that same prefix and need the full path.)
  const mw = createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: true,
    pathFilter: (pathname) => pathname === routePath || pathname.startsWith(routePath + "/"),
    on: {
      proxyRes: (proxyRes) => {
        // CRA dev server emits Connection: close, which Firefox + some
        // extensions handle badly on long-running localhost dev sessions
        // (speculative preloads get cancelled, real requests don't recover).
        proxyRes.headers["connection"] = "keep-alive";
      }
    }
  });
  devProxies.push({ routePath, mw });
  console.log(`[dev] Proxying ${routePath} → ${target}`);
  app.use(mw);
}

if (devViewerUrl) {
  devProxy("/viewer", devViewerUrl);
} else {
  app.use("/viewer", express.static(path.join(__dirname, "viewer/build")));
}

if (devEditorUrl) {
  devProxy("/editor", devEditorUrl);
} else {
  app.use("/editor", express.static(path.join(__dirname, "editor/build")));
}



const pageIntroCache = new Map();
const PAGE_INTRO_TTL_MS = 60 * 60 * 1000;

const stripHtml = (s) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const fetchSpeciesNode = async (filterField, filterValue) => {
  const types = ["species_description", "page", "species_guide", "species_guide_subpage"];
  for (const t of types) {
    const url = `https://artsdatabanken.no/jsonapi/node/${t}?filter[${filterField}]=${filterValue}&fields[node--${t}]=field_ingress,path,langcode`;
    const resp = await fetch(url, { headers: { Accept: "application/vnd.api+json" } });
    if (!resp.ok) continue;
    const data = await resp.json();
    if (data.data && data.data.length) return data.data[0];
  }
  return null;
};

const extractIngress = (node) => {
  const ingress = node && node.attributes && node.attributes.field_ingress;
  if (ingress && ingress.value) {
    const text = stripHtml(ingress.value);
    return text || null;
  }
  return null;
};

app.get("/api/page-intro/:externalId", async (req, res) => {
  const externalId = req.params.externalId;
  if (!/^\d+$/.test(externalId)) return res.status(400).json({});

  const cached = pageIntroCache.get(externalId);
  if (cached && cached.expires > Date.now()) {
    return res.json(cached.body);
  }

  try {
    const pagesResp = await fetch(`https://artsdatabanken.no/Pages/${externalId}`, {
      redirect: "manual",
    });
    const loc = pagesResp.headers.get("location") || "";
    const m = loc.match(/\/node\/(\d+)/);
    if (!m) {
      const body = {};
      pageIntroCache.set(externalId, { body, expires: Date.now() + PAGE_INTRO_TTL_MS });
      return res.json(body);
    }
    const nid = m[1];
    const node = await fetchSpeciesNode("drupal_internal__nid", nid);
    const ingress = extractIngress(node);
    const langcode = node && node.attributes && node.attributes.langcode;
    const body = {};
    if (ingress) body.ingress = ingress;
    if (langcode) body.langcode = langcode;
    pageIntroCache.set(externalId, { body, expires: Date.now() + PAGE_INTRO_TTL_MS });
    res.set("Cache-Control", "public, max-age=3600");
    res.json(body);
  } catch (e) {
    console.error(`[page-intro] ${externalId}:`, e.message);
    res.json({});
  }
});

const taxonIntroCache = new Map();

const fetchTaxonOverviewUrl = async (scientificNameId) => {
  const resp = await fetch(
    `https://artsdatabanken.no/api/Taxon/ByScientificNameId/${scientificNameId}`
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  const record = Array.isArray(data) ? data[0] : data;
  const taxonId = record && record.taxonID;
  return taxonId ? `https://artsdatabanken.no/arter/takson/${taxonId}` : null;
};

app.get("/api/taxon-intro/:externalId", async (req, res) => {
  const externalId = req.params.externalId;
  if (!/^\d+$/.test(externalId)) return res.status(400).json({});

  const cached = taxonIntroCache.get(externalId);
  if (cached && cached.expires > Date.now()) {
    return res.json(cached.body);
  }

  try {
    const node = await fetchSpeciesNode("field_scientific_name_id", externalId);
    const ingress = extractIngress(node);
    const alias = node && node.attributes && node.attributes.path && node.attributes.path.alias;
    const langcode = node && node.attributes && node.attributes.langcode;
    const body = {};
    if (ingress) body.ingress = ingress;
    if (alias) {
      body.pageUrl = `https://artsdatabanken.no${alias}`;
    } else {
      const overviewUrl = await fetchTaxonOverviewUrl(externalId);
      if (overviewUrl) body.pageUrl = overviewUrl;
    }
    if (langcode) body.langcode = langcode;
    taxonIntroCache.set(externalId, { body, expires: Date.now() + PAGE_INTRO_TTL_MS });
    res.set("Cache-Control", "public, max-age=3600");
    res.json(body);
  } catch (e) {
    console.error(`[taxon-intro] ${externalId}:`, e.message);
    res.json({});
  }
});

const sendKey = (res, keyfile) => {
  res.sendFile(keyfile, { root: __dirname });
  maintainKey(keyfile).catch((e) => console.error(`[maintenance] Error:`, e.message));
};

// for /key/:uuid requests, return keys/<uuid without dashes>.json (named after the identifier inside the key)
app.get("/key/:uuid", async (req, res) => {
  const uuid = req.params.uuid;
  if (!isValidId(uuid)) return res.status(404).send("Key not found");

  let keyfile = getKeyFile(uuid);
  if (keyfile) return sendKey(res, keyfile);

  // Unknown id: pull the whole clavis-keys repo once and try again
  try {
    await refreshOnMiss();
  } catch (e) {
    console.error(`[keys] Refresh failed:`, e.message);
  }

  keyfile = getKeyFile(uuid);
  if (keyfile) return sendKey(res, keyfile);

  res.status(404).send("Key not found");
});

// Refetch the entire clavis-keys repo, then report on this one key
app.post("/key/:uuid/refetch", async (req, res) => {
  const uuid = req.params.uuid;
  try {
    await refreshKeys();
    const keyfile = isValidId(uuid) ? getKeyFile(uuid) : null;
    if (!keyfile) return res.status(404).send("Key not found in repository");
    await maintainKey(keyfile);
    res.status(200).json({ success: true, message: "Key refetched successfully", file: path.basename(keyfile) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to refetch key", error: error.message });
  }
});

// Refetch the entire clavis-keys repo and store every key as keys/<identifier without dashes>.json
app.post("/keys/refetch", async (req, res) => {
  try {
    const result = await refreshKeys();
    res.status(200).json({ success: true, count: result.keys.length, ...result });
    maintainAllKeys().catch((e) => console.error(`[maintenance] Error:`, e.message));
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to refetch keys", error: error.message });
  }
});

app.get("/keys", keysOverview);

// Landing page assets (fonts, logo, demo viewer); index is served by the "/" route below
app.use(express.static(path.join(__dirname, "landing"), { index: false }));

app.get("/", (req, res) => {
  // old links with a query (?id=..., ?csv=...) still go to the viewers
  if (req.url.includes("csv")) {
    return res.redirect(`/legacy_viewer${req.url}`);
  } else if (Object.keys(req.query).length) {
    return res.redirect(`/viewer${req.url}`);
  }
  res.sendFile(path.join(__dirname, "landing", "index.html"));
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

const server = app.listen(port, () => {
  console.log(`Server now running on port ${port}`);
  // Mirror the whole clavis-keys repo at start, so every key is available under its identifier
  refreshKeys().catch((e) => console.error(`[keys] Startup refresh failed:`, e.message));
  startPeriodicMaintenance();
});

if (devProxies.length) {
  server.on("upgrade", (req, socket, head) => {
    const match = devProxies.find((p) => req.url && req.url.startsWith(p.routePath));
    if (match && typeof match.mw.upgrade === "function") {
      match.mw.upgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });
}
