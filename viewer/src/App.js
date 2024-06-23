import React, { useState, useEffect } from "react";
import { ClavisViewer } from "@artsdatabanken/clavis-viewer-web";

function App() {
  const [clavis, setClavis] = useState(null);

  useEffect(() => {
    // get the uuid from the url
    const urlParams = new URLSearchParams(window.location.search);
    const uuid = urlParams.get("id");

    fetch(`/key/${uuid}`)
      .then((response) => response.json())
      .then((data) => {
        setClavis(data);
      })
      .catch((error) => console.log(error));
  }, []);

  if (!clavis) {
    return <div>Loading...</div>;
  }
  
  return <ClavisViewer clavis={clavis} />;
}

export default App;
