const fs = require("fs");
const path = require("path");
const https = require("https");

const NORTAXA_BASE_URL =
  "https://nortaxa.artsdatabanken.no/api/v1/TaxonName/ByScientificNameId";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Drupal image styles to expose, smallest to largest, with their scaled width
// in pixels. The viewer picks the smallest variant that covers the requested
// display width, so the browser never downloads the multi-megabyte original.
const IMAGE_STYLES = [
  { name: "thumbnail", width: 100 },
  { name: "mobile", width: 375 },
  { name: "tablet", width: 640 },
  { name: "desktop", width: 940 },
  { name: "wide", width: 1440 },
  { name: "desktop_big", width: 1920 },
];

// A direct CMS file URL that has not already been rewritten to an image style.
const DIRECT_FILE_RE =
  /^https?:\/\/artsdatabanken\.no\/sites\/default\/files\/(?!styles\/)(.+)$/i;

// Translate a direct CMS file URL into its Drupal stream wrapper uri
// (public://…), used to look the file up via jsonapi. Returns null for URLs
// that are not rewritable (already an image style, a media-bank URL, etc.).
function directFileUri(url) {
  if (typeof url !== "string") return null;
  const match = url.match(DIRECT_FILE_RE);
  if (!match) return null;
  return "public://" + decodeURIComponent(match[1]);
}

// Fetch the image_style_uri map (style name -> sized .webp URL with itok token)
// for a file identified by its public:// uri. Returns null if not found.
async function resolveImageStyles(uriValue) {
  const endpoint =
    "https://artsdatabanken.no/jsonapi/file/file" +
    "?filter[uri.value][value]=" +
    encodeURIComponent(uriValue) +
    "&page[limit]=1";
  const data = await fetchJson(endpoint);
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  return entry && entry.attributes ? entry.attributes.image_style_uri : null;
}

// Expand one direct-URL media file into an array of sized media files, one per
// available image style. Preserves any other metadata on the original file.
function buildVariants(file, styleMap) {
  const { url, width, height, ...rest } = file;
  const variants = [];
  for (const style of IMAGE_STYLES) {
    if (styleMap[style.name]) {
      variants.push({ ...rest, url: styleMap[style.name], width: style.width });
    }
  }
  return variants.length ? variants : null;
}

// Recursively collect every object that has a `file` property holding a media
// file (object) or array of media files. The base64 data-URI form of `file`
// is a string and is correctly skipped.
function collectFileContainers(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectFileContainers(item, out);
    return;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (k === "file" && v && typeof v === "object") {
      out.push(node);
    } else if (v && typeof v === "object") {
      collectFileContainers(v, out);
    }
  }
}

// Rewrite every direct full-resolution CMS image URL in the key into an array
// of image-style variants. Idempotent: already-rewritten URLs are left alone,
// so jsonapi is only queried the first time a key is maintained.
async function rewriteKeyMedia(key) {
  const containers = [];
  collectFileContainers(key, containers);

  const cache = new Map();
  let updated = false;

  for (const container of containers) {
    const list = Array.isArray(container.file)
      ? container.file
      : [container.file];
    const rebuilt = [];
    let changed = false;

    for (const mediaFile of list) {
      const uri = mediaFile && directFileUri(mediaFile.url);
      if (!uri) {
        rebuilt.push(mediaFile);
        continue;
      }

      if (!cache.has(uri)) {
        let styleMap = null;
        try {
          styleMap = await resolveImageStyles(uri);
        } catch (e) {
          console.warn(
            `[maintenance] Image style lookup failed for ${uri}: ${e.message}`
          );
        }
        cache.set(uri, styleMap);
        await delay(100);
      }

      const styleMap = cache.get(uri);
      const variants = styleMap ? buildVariants(mediaFile, styleMap) : null;
      if (variants) {
        rebuilt.push(...variants);
        changed = true;
      } else {
        rebuilt.push(mediaFile);
      }
    }

    if (changed) {
      container.file = rebuilt;
      updated = true;
    }
  }

  return updated;
}

async function maintainKey(filePath) {
  const fullPath = path.resolve(__dirname, filePath);
  let key;
  try {
    key = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
  } catch (e) {
    console.warn(`[maintenance] Could not read ${filePath}: ${e.message}`);
    return;
  }

  let updated = false;

  const taxa = Array.isArray(key.taxa) ? key.taxa : [];
  for (const taxon of taxa) {
    const ref = taxon.externalReference;
    if (!ref || ref.serviceId !== "service:nbic_taxa") continue;

    const externalId = ref.externalId;
    if (!externalId) continue;

    try {
      const data = await fetchJson(`${NORTAXA_BASE_URL}/${externalId}`);
      const names = data.scientificNames;
      if (!Array.isArray(names)) continue;

      const current = names.find((n) => String(n.id) === String(externalId));
      if (current && current.taxonomicStatus === "Synonym") {
        const accepted = names.find((n) => n.taxonomicStatus === "Accepted");
        if (!accepted) {
          console.warn(
            `[maintenance] No accepted name found for ${taxon.scientificName} (id ${externalId})`
          );
          continue;
        }

        console.log(
          `[maintenance] Updating synonym: ${taxon.scientificName} -> ${accepted.scientificNamePresentation}`
        );
        taxon.scientificName = accepted.scientificNamePresentation;
        ref.externalId = String(accepted.id);
        updated = true;
      }

      // Update vernacular names from API
      const vernaculars = data.vernacularNames;
      if (Array.isArray(vernaculars) && vernaculars.length > 0) {
        const newVernacular = {};
        for (const v of vernaculars) {
          if (v.languageIsoCode && v.vernacularName && v.vernacularNameStatus === "Recommended") {
            newVernacular[v.languageIsoCode] = v.vernacularName;
          }
        }
        if (Object.keys(newVernacular).length > 0) {
          const oldVernacular = JSON.stringify(taxon.vernacularName || {});
          const newVernacularStr = JSON.stringify(newVernacular);
          if (oldVernacular !== newVernacularStr) {
            console.log(
              `[maintenance] Updating vernacular names for ${taxon.scientificName}`
            );
            taxon.vernacularName = newVernacular;
            updated = true;
          }
        }
      }
    } catch (e) {
      console.warn(
        `[maintenance] API error for taxon ${taxon.scientificName} (id ${externalId}): ${e.message}`
      );
    }

    await delay(100);
  }

  if (await rewriteKeyMedia(key)) {
    updated = true;
  }

  if (updated) {
    fs.writeFileSync(fullPath, JSON.stringify(key, null, 2), "utf-8");
    console.log(`[maintenance] Updated ${filePath}`);
  }
}

async function maintainAllKeys() {
  const keysDir = path.join(__dirname, "keys");
  let files;
  try {
    files = fs.readdirSync(keysDir).filter((f) => f.endsWith(".json"));
  } catch (e) {
    console.warn(`[maintenance] Could not read keys directory: ${e.message}`);
    return;
  }

  console.log(`[maintenance] Running maintenance on ${files.length} key(s)`);
  for (const file of files) {
    await maintainKey(`keys/${file}`);
  }
  console.log(`[maintenance] Maintenance complete`);
}

function startPeriodicMaintenance() {
  const hours = parseFloat(process.env.MAINTENANCE_INTERVAL_HOURS) || 24;
  const ms = hours * 60 * 60 * 1000;
  console.log(
    `[maintenance] Scheduling periodic maintenance every ${hours} hour(s)`
  );
  setInterval(() => {
    maintainAllKeys().catch((e) =>
      console.error(`[maintenance] Periodic maintenance failed: ${e.message}`)
    );
  }, ms);
}

module.exports = { maintainKey, maintainAllKeys, startPeriodicMaintenance };
