import React, { useState, useEffect } from "react";
import { ClavisViewer } from "@artsdatabanken/clavis-viewer-web";

function App() {
  const [clavis, setClavis] = useState(null);
  const urlParams = new URLSearchParams(window.location.search);
  const uuid = urlParams.get("id");
  const language = urlParams.get("lang") || urlParams.get("language") || undefined;

  useEffect(() => {
    fetch(`/key/${uuid}`)
      .then((response) => response.json())
      .then((data) => {
        setClavis(data);
      })
      .catch((error) => console.log(error));
  }, [uuid]);

  if (!clavis) {
    return <div>Loading...</div>;
  }

  return <ClavisViewer clavis={clavis} language={language} />;
}

export default App;
