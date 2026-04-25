import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./i18n";
import "./index.css";

const container = document.getElementById("root");

if (!container) throw new Error("root element missing");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
