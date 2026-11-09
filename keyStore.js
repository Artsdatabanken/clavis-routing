const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const REPO_URL = "https://github.com/Artsdatabanken/clavis-keys.git";
const KEYS_DIR = path.join(__dirname, "keys");

// A key id becomes a filename, so only allow characters that are safe there.
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

const isValidId = (id) => typeof id === "string" && VALID_ID.test(id);

const keyPath = (id) => (isValidId(id) ? path.join(KEYS_DIR, `${id}.json`) : null);

// Relative path (from the app root) of the local file for this key, or null.
const getKeyFile = (id) => {
  const full = keyPath(id);
  if (!full || !fs.existsSync(full)) return null;
  return path.relative(__dirname, full);
};

const listJsonFiles = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) out.push(full);
  }
  return out;
};

const writeAtomic = (dest, content) => {
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, dest);
};

// Clone the whole clavis-keys repo and mirror it into keys/<identifier>.json.
// The filename in the repo is ignored; the "identifier" inside each file is the name.
// Local keys that are no longer in the repo (and old "<id> - Name.json" files) are removed.
const doRefresh = async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clavis-keys-"));
  const cloneDir = path.join(tmpRoot, "repo");
  try {
    await execFileAsync("git", ["clone", "--depth", "1", "--quiet", REPO_URL, cloneDir], {
      timeout: 120000,
    });

    const chosen = new Map(); // id -> { file, content, lastModified }
    const skipped = [];

    for (const full of listJsonFiles(cloneDir)) {
      const file = path.relative(cloneDir, full);
      const content = fs.readFileSync(full);
      let data;
      try {
        data = JSON.parse(content.toString("utf8"));
      } catch (e) {
        skipped.push({ file, reason: "not valid JSON" });
        continue;
      }
      const id = data && data.identifier;
      if (!isValidId(id)) {
        skipped.push({ file, reason: id ? `unusable identifier "${id}"` : "no identifier" });
        continue;
      }
      const lastModified = Date.parse(data.lastModified) || 0;
      const prev = chosen.get(id);
      if (prev) {
        const keepNew = lastModified > prev.lastModified;
        const loser = keepNew ? prev.file : file;
        skipped.push({ file: loser, reason: `duplicate identifier ${id} (older copy)` });
        if (!keepNew) continue;
      }
      chosen.set(id, { file, content, lastModified });
    }

    if (chosen.size === 0) {
      throw new Error("No usable keys found in the repository; local keys left untouched");
    }

    if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });

    for (const [id, { content }] of chosen) {
      writeAtomic(keyPath(id), content);
    }

    const keep = new Set([...chosen.keys()].map((id) => `${id}.json`));
    const removed = [];
    for (const name of fs.readdirSync(KEYS_DIR)) {
      if (!keep.has(name)) {
        fs.rmSync(path.join(KEYS_DIR, name), { recursive: true, force: true });
        removed.push(name);
      }
    }

    const result = {
      keys: [...chosen.keys()].sort(),
      skipped,
      removed,
      refreshedAt: new Date().toISOString(),
    };
    console.log(
      `[keys] Refreshed ${result.keys.length} key(s) from ${REPO_URL}` +
        (skipped.length ? `, skipped ${skipped.length}` : "") +
        (removed.length ? `, removed ${removed.length} old file(s)` : "")
    );
    skipped.forEach((s) => console.warn(`[keys] Skipped ${s.file}: ${s.reason}`));
    return result;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
};

// Concurrent callers share one refresh instead of cloning in parallel.
let inFlight = null;
let lastRefreshAt = 0;

const refreshKeys = () => {
  if (!inFlight) {
    inFlight = doRefresh()
      .then((result) => {
        lastRefreshAt = Date.now();
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
};

// For lookups of unknown ids: refresh at most once per cooldown,
// so requests for ids that don't exist can't make us clone over and over.
const MISS_COOLDOWN_MS = 60 * 1000;

const refreshOnMiss = async () => {
  if (inFlight) return inFlight;
  if (Date.now() - lastRefreshAt < MISS_COOLDOWN_MS) return null;
  return refreshKeys();
};

module.exports = { KEYS_DIR, isValidId, getKeyFile, refreshKeys, refreshOnMiss };
