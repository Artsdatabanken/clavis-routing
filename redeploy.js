// Redeploy the editor and viewer from GitHub without rebuilding the image.
//
// POST /redeploy checks GitHub for new commits on the branches this server
// was built from, and rebuilds only what changed:
//   - Clavis-editor (dev on the test server, main otherwise) -> /editor
//   - clavis-viewer-web dev (test server only)               -> /editor and /viewer
// It needs no token: it can only deploy what is already on GitHub, and does
// nothing when nothing changed. The check runs at most once per CHECK_INTERVAL,
// and only one rebuild runs at a time. GET /redeploy shows the state.
//
// Builds land in deploy/, next to this file, and are lost when the container
// restarts; the server then serves the image's own builds again.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");

const EDITOR_REPO = "https://github.com/Artsdatabanken/Clavis-editor.git";
const VIEWER_WEB_REPO = "https://github.com/Artsdatabanken/clavis-viewer-web.git";
const CHECK_INTERVAL_MS = 60 * 1000;
const STEP_TIMEOUT_MS = 15 * 60 * 1000;
const DEPLOY_DIR = path.join(__dirname, "deploy");

// The image's folders belong to root while the server runs as another user;
// git refuses such folders unless told they are safe (also inside npm scripts).
const GIT_SAFE = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };

const sh = (cmd, args, cwd, timeout = 30 * 1000) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, timeout, encoding: "utf8", env: { ...process.env, ...GIT_SAFE } }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())
    )
  );

const readOrNull = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

// A static handler whose folder can be swapped while the server runs.
const swappableStatic = (dir) => {
  let handler = express.static(dir);
  const middleware = (req, res, next) => handler(req, res, next);
  middleware.swap = (newDir) => {
    handler = express.static(newDir);
  };
  return middleware;
};

function createRedeploy({ editorBuild, viewerBuild }) {
  const editorStatic = swappableStatic(editorBuild);
  const viewerStatic = swappableStatic(viewerBuild);

  const state = {
    branch: null,
    deployed: { editor: null, viewerWeb: null },
    building: null,
    lastCheck: 0,
    lastResult: null,
  };
  const log = [];
  const say = (line) => {
    const entry = `${new Date().toISOString()} ${line}`;
    console.log(`[redeploy] ${line}`);
    log.push(entry);
    if (log.length > 200) log.shift();
  };

  // What the image was built from.
  const ready = (async () => {
    const branch = await readOrNull(() => sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], __dirname));
    state.branch = branch === "dev" ? "dev" : "main";
    state.deployed.editor = await readOrNull(() => sh("git", ["rev-parse", "HEAD"], path.join(__dirname, "editor")));
    state.deployed.viewerWeb = await readOrNull(async () =>
      fs.readFileSync(path.join(__dirname, "viewer-web.sha"), "utf8").trim() || null
    );
  })();

  const remoteHead = async (repo, branch) => {
    const out = await sh("git", ["ls-remote", repo, `refs/heads/${branch}`], undefined, 20 * 1000);
    const sha = out.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`No ${branch} branch found in ${repo}`);
    return sha;
  };

  // Runs one build step, its output going to the log.
  const step = (cmd, args, cwd) =>
    new Promise((resolve, reject) => {
      say(`$ ${cmd} ${args.join(" ")}`);
      // The server's user has no home folder; npm needs one for its cache.
      const env = { ...process.env, ...GIT_SAFE, CI: "true", HOME: DEPLOY_DIR, npm_config_cache: path.join(DEPLOY_DIR, ".npm-cache") };
      const child = spawn(cmd, args, { cwd, env });
      const timer = setTimeout(() => child.kill("SIGKILL"), STEP_TIMEOUT_MS);
      const tail = [];
      const collect = (data) => {
        for (const line of data.toString().split("\n")) {
          if (!line.trim()) continue;
          tail.push(line);
          if (tail.length > 20) tail.shift();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        tail.forEach((l) => say(`  ${l}`));
        reject(new Error(`${cmd} ${args.join(" ")} failed (${code === null ? "timed out" : `exit ${code}`})`));
      });
    });

  // Copy a node_modules folder so npm only has to install what changed.
  const reuseModules = (from, to) => {
    const source = path.join(from, "node_modules");
    if (fs.existsSync(source)) {
      fs.cpSync(source, path.join(to, "node_modules"), { recursive: true, verbatimSymlinks: true });
    }
  };

  // Move a finished build into deploy/ and serve it; remove the build it replaces.
  const publish = (name, buildDir, middleware, stamp) => {
    const target = path.join(DEPLOY_DIR, `${name}-${stamp}`);
    fs.renameSync(buildDir, target);
    middleware.swap(target);
    for (const old of fs.readdirSync(DEPLOY_DIR)) {
      if (old.startsWith(`${name}-`) && old !== path.basename(target)) {
        fs.rmSync(path.join(DEPLOY_DIR, old), { recursive: true, force: true });
      }
    }
    say(`${name} now served from ${target}`);
  };

  const rebuild = async ({ editor, viewer, editorSha, viewerWebSha }) => {
    const stamp = Date.now().toString();
    const work = path.join(DEPLOY_DIR, `work-${stamp}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      if (editor) {
        const dir = path.join(work, "editor");
        await step("git", ["clone", "--depth", "1", "--branch", state.branch, EDITOR_REPO, dir], work);
        const built = await sh("git", ["rev-parse", "HEAD"], dir);
        reuseModules(path.join(__dirname, "editor"), dir);
        await step("npm", ["install"], dir);
        await step("npm", ["run", "setup-dev", "--if-present"], dir);
        await step("npm", ["run", "build"], dir);
        publish("editor", path.join(dir, "build"), editorStatic, stamp);
        state.deployed.editor = built;
      }
      if (viewer) {
        // The viewer's code is part of this repo; only its clavis-viewer-web
        // build changes. setup-dev reads this repo's branch to pick dev.
        const dir = path.join(work, "viewer");
        fs.cpSync(path.join(__dirname, "viewer"), dir, {
          recursive: true,
          verbatimSymlinks: true,
          filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.endsWith(`${path.sep}build`),
        });
        reuseModules(path.join(__dirname, "viewer"), dir);
        await step("npm", ["install"], dir);
        await step("npm", ["run", "setup-dev", "--if-present"], dir);
        await step("npm", ["run", "build"], dir);
        publish("viewer", path.join(dir, "build"), viewerStatic, stamp);
      }
      if (viewerWebSha) state.deployed.viewerWeb = viewerWebSha;
      state.lastResult = { ok: true, at: new Date().toISOString(), rebuilt: [editor && "editor", viewer && "viewer"].filter(Boolean) };
      say(`done: ${state.lastResult.rebuilt.join(", ")}`);
    } catch (e) {
      state.lastResult = { ok: false, at: new Date().toISOString(), error: e.message };
      say(`failed: ${e.message}`);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      state.building = null;
    }
  };

  const router = express.Router();

  router.get("/redeploy", async (req, res) => {
    await ready;
    res.json({ ...state, log: log.slice(-40) });
  });

  router.post("/redeploy", async (req, res) => {
    await ready;
    if (state.building) {
      return res.status(409).json({ message: "A rebuild is already running", building: state.building });
    }
    const wait = state.lastCheck + CHECK_INTERVAL_MS - Date.now();
    if (wait > 0) {
      res.set("Retry-After", Math.ceil(wait / 1000).toString());
      return res.status(429).json({ message: `Checked less than ${CHECK_INTERVAL_MS / 1000} s ago, try again in ${Math.ceil(wait / 1000)} s` });
    }
    state.lastCheck = Date.now();

    let editorSha, viewerWebSha;
    try {
      editorSha = await remoteHead(EDITOR_REPO, state.branch);
      // The viewer-web build only follows GitHub on dev; main uses the npm release.
      if (state.branch === "dev") viewerWebSha = await remoteHead(VIEWER_WEB_REPO, "dev");
    } catch (e) {
      return res.status(502).json({ message: "Could not check GitHub", error: e.message });
    }

    const viewerWebChanged = !!viewerWebSha && viewerWebSha !== state.deployed.viewerWeb;
    const plan = {
      editor: editorSha !== state.deployed.editor || viewerWebChanged,
      viewer: viewerWebChanged,
      editorSha,
      viewerWebSha,
    };
    if (!plan.editor && !plan.viewer) {
      return res.json({ message: "Already up to date", deployed: state.deployed });
    }
    state.building = { started: new Date().toISOString(), editor: plan.editor, viewer: plan.viewer, editorSha, viewerWebSha };
    say(`rebuilding ${[plan.editor && "editor", plan.viewer && "viewer"].filter(Boolean).join(" and ")} (editor ${editorSha.slice(0, 7)}${viewerWebSha ? `, viewer-web ${viewerWebSha.slice(0, 7)}` : ""})`);
    rebuild(plan);
    res.status(202).json({ message: "Rebuild started; see GET /redeploy", building: state.building });
  });

  return { router, editorStatic, viewerStatic };
}

module.exports = { createRedeploy };
