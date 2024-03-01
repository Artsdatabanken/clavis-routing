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

app.use(
  "/clavis_viewer",
  express.static(path.join(__dirname, "clavis_viewer"))
);

app.get("/*", (req, res) => {
  // if there is no uuid argument, redirect to the legacy viewer
  if (!req.url.includes("uuid")) {
    return res.redirect(`/legacy_viewer${req.url}`);
  }

  // just send hello world for now
  res.send("Hello world");

  // req.url = `/legacy_viewer/${req.url}`;
  // app.handle(req, res);
});

// app.use('/', express.static('legacy_editor'))

app.listen(port, console.log(`Server now running on port ${port}`));
