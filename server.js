const express = require("express");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const { maintainKey, startPeriodicMaintenance } = require("./keyMaintenance");
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
    const pageUrl = alias ? `https://artsdatabanken.no${alias}` : null;
    const langcode = node && node.attributes && node.attributes.langcode;
    const body = {};
    if (ingress) body.ingress = ingress;
    if (pageUrl) body.pageUrl = pageUrl;
    if (langcode) body.langcode = langcode;
    taxonIntroCache.set(externalId, { body, expires: Date.now() + PAGE_INTRO_TTL_MS });
    res.set("Cache-Control", "public, max-age=3600");
    res.json(body);
  } catch (e) {
    console.error(`[taxon-intro] ${externalId}:`, e.message);
    res.json({});
  }
});

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

app.get("/keys", keysOverview);

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

const server = app.listen(port, () => {
  console.log(`Server now running on port ${port}`);
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
