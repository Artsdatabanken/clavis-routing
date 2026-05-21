FROM node:20

EXPOSE 5000

# Create app directory
WORKDIR /app

COPY . .

RUN git clone https://github.com/Artsdatabanken/identification_key.git legacy_viewer

# BUILD_ID is set by the CI pipeline to a unique value per run (e.g.
# Azure's $(Build.BuildId)). It does double duty:
#   1. Marks "this is a CI build of the dev branch" (the pipeline only
#      triggers on dev pushes), so we can attach /app to a local dev
#      branch unconditionally — setup-viewer.js gates on
#      `git rev-parse --abbrev-ref HEAD` and Azure's checkout leaves us
#      in detached HEAD.
#   2. Busts Docker layer cache from this RUN onward, so that subsequent
#      live fetches (setup-dev, git clone of the editor) always re-pull
#      the latest dev branches instead of returning a stale cached layer.
# Local builds leave BUILD_ID=local and skip the dev attach.
ARG BUILD_ID=local
RUN echo "=== BUILD_ID=$BUILD_ID ===" \
 && echo "=== /app .git: $(ls /app/.git 2>&1 | head -1) ===" \
 && echo "=== /app HEAD before: $(git -C /app rev-parse --abbrev-ref HEAD 2>&1) ===" \
 && echo "=== /app refs at HEAD: $(git -C /app for-each-ref --points-at HEAD --format='%(refname:short)' 2>&1 | tr '\n' ' ') ===" \
 && if [ "$BUILD_ID" != "local" ] && [ -d /app/.git ]; then \
      git -C /app checkout -B dev 2>&1 || echo "WARNING: checkout -B dev failed"; \
    fi \
 && echo "=== /app HEAD after: $(git -C /app rev-parse --abbrev-ref HEAD 2>&1) ==="

COPY ./viewer /app/viewer

WORKDIR /app/viewer

RUN ls -hal

RUN npm install
# On dev branch, swap in viewer-web's dev build before bundling.
# setup-viewer.js no-ops on any other branch, so main is unaffected.
RUN echo "build_id=$BUILD_ID" && npm run setup-dev --if-present
RUN npm run build

WORKDIR /app

RUN echo "build_id=$BUILD_ID" && git clone https://github.com/Artsdatabanken/Clavis-editor.git editor
WORKDIR /app/editor

RUN if [ "$(git -C /app rev-parse --abbrev-ref HEAD)" = "dev" ]; then git switch dev; fi

RUN ls -hal

RUN npm install
# Same dev/main split as the viewer above — script self-gates on branch.
RUN npm run setup-dev --if-present
RUN npm run build

WORKDIR /app



# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install
# If you are building your code for production
RUN npm ci --only=production

# Bundle app source

RUN groupadd --gid 1007 dockerrunner && useradd -r --uid 1007 -g dockerrunner dockerrunner
RUN mkdir -p log && touch log/log.txt && chown dockerrunner log/log.txt
RUN mkdir -p log/taxa

RUN mkdir -p keys && chown dockerrunner keys
RUN mkdir -p clavis-keys && chown dockerrunner clavis-keys


USER dockerrunner


CMD [ "node", "server.js" ]

