FROM node:20

EXPOSE 5000

# Create app directory
WORKDIR /app

COPY . .

RUN git clone https://github.com/Artsdatabanken/identification_key.git legacy_viewer

# Reattach the routing checkout to a local `dev` branch when the source
# came in via a detached-HEAD checkout (Azure pipelines does this), so
# downstream setup-viewer.js calls — which detect dev via
# `git rev-parse --abbrev-ref HEAD` — actually see "dev".
RUN if [ "$(git -C /app rev-parse --abbrev-ref HEAD)" != "dev" ] \
       && git -C /app for-each-ref --points-at HEAD --format='%(refname:short)' | grep -qE '^(origin/)?dev$'; then \
         git -C /app checkout -B dev; \
    fi

COPY ./viewer /app/viewer

WORKDIR /app/viewer

RUN ls -hal

RUN npm install
# Bust Docker layer cache from here on so dev pushes to clavis-viewer-web
# or Clavis-editor (both pulled live via setup-dev / git clone below) are
# actually re-fetched, not satisfied from a stale cached layer. CI passes
# a unique BUILD_ID per run.
ARG BUILD_ID=local
# On dev branch, swap in viewer-web's dev build before bundling.
# setup-viewer.js no-ops on any other branch, so main is unaffected.
RUN echo "build_id=$BUILD_ID" && npm run setup-dev --if-present
RUN npm run build

WORKDIR /app

RUN git clone https://github.com/Artsdatabanken/Clavis-editor.git editor
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

