import React from "react";
import ReactDOM from "react-dom/client";
import StartMenu from "./StartMenu";
import "./StartMenu.css";

document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <StartMenu />
  </React.StrictMode>
);
