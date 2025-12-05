FROM node:20

EXPOSE 5000

# Create app directory
WORKDIR /app

COPY . .

RUN git clone https://github.com/Artsdatabanken/identification_key.git legacy_viewer

COPY ./viewer /app/viewer

WORKDIR /app/viewer

RUN ls -hal

RUN npm install
RUN npm run build

WORKDIR /app

RUN git clone https://github.com/Artsdatabanken/Clavis-editor.git editor
WORKDIR /app/editor

RUN if [ "$(git -C /app rev-parse --abbrev-ref HEAD)" = "dev" ]; then git switch dev; fi

RUN ls -hal

RUN npm install
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

