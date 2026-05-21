# Developing the Clavis ecosystem

Three repos work together:

| Repo | What it is |
|---|---|
| `clavis-viewer-web` | React component library, published to npm as `@artsdatabanken/clavis-viewer-web`. |
| `Clavis-editor` | React app for authoring keys; embeds `ClavisViewer`. |
| `clavis-routing` | Express server + a thin React wrapper around `ClavisViewer`. Mounts the editor at `/editor` and its own wrapper at `/viewer`. This is the integration point. |

They should live as siblings:

```
<parent>/
├── clavis-viewer-web/
├── Clavis-editor/
└── clavis-routing/
```

## Local development — one command

From `clavis-routing/`:

```
npm install                          # first time only
(cd ../clavis-viewer-web && npm install)
(cd ../Clavis-editor && npm install)
npm run dev
```

`npm run dev` brings up the whole ecosystem:

- `clavis-viewer-web` in watch mode — rebuilds `dist/` on every save.
- A dist watcher copies viewer-web's `dist/` into both consumers' `node_modules/@artsdatabanken/clavis-viewer-web/dist/` whenever it changes.
- `clavis-routing/viewer` runs as a CRA dev server on port 3000.
- `Clavis-editor` runs as a CRA dev server on port 3001.
- The express routing server runs on port 5000 in dev mode, reverse-proxying `/viewer/*` and `/editor/*` (plus their HMR websockets) to the CRA dev servers.

Open <http://localhost:5000/>. `/viewer` and `/editor` are both served via the routing as in production, but any source change in any of the three repos propagates with HMR.

- `http://localhost:5000/viewer/?id=<uuid>&lang=en` — standalone viewer.
- `http://localhost:5000/editor/` — editor (its preview embeds the viewer too).
- `http://localhost:5000/key/<uuid>` — the JSON key API (unchanged).

Ctrl-C in the orchestrator terminates all child processes.

### Why this layout

Viewer-web declares React/ReactDOM as regular dependencies (not peer dependencies). That breaks `npm link`-style symlinking with duplicate React copies. So instead of symlinking, the dev script copies viewer-web's built `dist/` into each consumer's `node_modules`. CRA's webpack-5 dev server watches files inside `node_modules`, so the copy triggers a rebuild and HMR fires.

## Pushing to `dev`

Push each component's changes to its own `dev` branch. The routing's Docker build (Azure pipeline `azure-pipelines-test.yml`, image `artsdatabanken/clavis-routing:test`) is triggered on a `clavis-routing` dev push and assembles a unified image. During the build:

- The routing-viewer's `npm install` is followed by `npm run setup-dev`. The script self-gates on branch: on `dev` it clones `clavis-viewer-web@dev` from GitHub, builds it, and overwrites the npm-installed `dist/`. On any other branch it no-ops.
- `Clavis-editor` is cloned fresh; `git switch dev` if the routing is on dev; same `setup-dev` behavior follows.

So the workflow is just:

1. Push `clavis-viewer-web@dev` (no release needed).
2. Push `Clavis-editor@dev`.
3. Push `clavis-routing@dev` — pipeline rebuilds, both consumers pick up dev viewer-web from GitHub.

No version bumping, no npm publishing, no Dockerfile edits per change.

## Pushing to `main` / cutting a release

`main` builds use the published npm package. To roll dev work to prod:

1. **`clavis-viewer-web`**: bump `version` in `package.json` on `main`, then create a GitHub Release with the matching tag. The `npm-publish.yml` workflow runs `npm publish` to the npm registry.
2. **`Clavis-editor`**: merge to `main`. The next routing main build will clone the latest main of the editor; the editor's own `npm install` resolves viewer-web from npm — picking up the version you just published.
3. **`clavis-routing`**: merge to `main`. The Azure pipeline `azure-pipelines-prod.yml` builds the prod image. `setup-dev` no-ops outside `dev`, so the routing-viewer also uses the npm-published viewer-web.

The only manual step is cutting the viewer-web release. Editor and routing don't need their own releases — they're rebuilt fresh from the latest `main` of their repos on every routing prod build.

## Useful single-repo workflows

You don't always need the whole orchestrator.

- **Editor only**, against the published viewer-web: `cd Clavis-editor && npm start`.
- **Editor against a local viewer-web**, without the orchestrator: in `Clavis-editor`, on `dev`, run `npm run setup-dev` once to swap in the sibling viewer-web's current build. Re-run after each viewer-web change. (The orchestrator automates this loop.)
- **Routing only**, against built consumers: `node server.js` (no `NODE_ENV=development` → static-files mode).
