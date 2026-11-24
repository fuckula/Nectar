import React from "react";
import ReactDOM from "react-dom/client";
import TrayBar from "./TrayBar";
import { NectarMotionProvider } from "./components/NectarMotionProvider";
import "./TrayBar.css";

document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <NectarMotionProvider>
      <TrayBar />
    </NectarMotionProvider>
  </React.StrictMode>
);
