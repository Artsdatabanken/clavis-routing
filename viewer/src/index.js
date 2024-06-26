import React from "react";
import App from "./App";
import { createRoot } from "react-dom/client";

var getUrlParameter = function getUrlParameter(sParam) {
  var sPageURL = decodeURIComponent(window.location.search.substring(1)),
    sURLVariables = sPageURL.split("&");

  for (var i = 0; i < sURLVariables.length; i++) {
    var sParameterName = sURLVariables[i].split("=");

    if (sParameterName[0] === sParam) {
      console.log(sParameterName[1]);
      return sParameterName[1] === undefined ? true : sParameterName[1];
    }
  }
};

var height = getUrlParameter("height") || "100%";

var sheet = document.createElement("style");
sheet.innerHTML = "html, body {height: " + height + ";}";
document.body.appendChild(sheet);

const container = document.getElementById("root");
const root = createRoot(container);

root.render(<App />);
