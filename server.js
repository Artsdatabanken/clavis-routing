const express = require("express");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // Timeframe
  max: 30, // Max requests per timeframe per ip
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (request, response, next, options) => {
    writeErrorLog(
      `Too many misc API requests`,
      `IP ${request.client._peername.address}`
    );
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
  express.static(path.join(__dirname, "legacy_viewer"))
);

app.use("/viewer", express.static(path.join(__dirname, "viewer/build")));

// for /key/:uuid requests, return the corresponding json file
app.get("/key/:uuid", (req, res) => {
  const uuid = req.params.uuid;

  // get the json file starting with the uuid
  var files = fs
    .readdirSync(path.join(__dirname, "keys"))
    .filter((fn) => fn.startsWith(uuid));
  if (files.length > 0) {
    const path = `keys/${files[0]}`;
    res.sendFile(path, { root: __dirname });
  } else {
    res.status(404).send("Key not found, Reload docker if keys were added");
  }
});

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

app.listen(port, console.log(`Server now running on port ${port}`));
