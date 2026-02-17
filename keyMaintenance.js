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

async function maintainKey(filePath) {
  const fullPath = path.resolve(__dirname, filePath);
  let key;
  try {
    key = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
  } catch (e) {
    console.warn(`[maintenance] Could not read ${filePath}: ${e.message}`);
    return;
  }

  const taxa = key.taxa;
  if (!Array.isArray(taxa)) return;

  let updated = false;

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
          if (v.languageIsoCode && v.vernacularName) {
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
