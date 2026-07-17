import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./design-system.css";

const storedTheme = (() => {
  try {
    const value = JSON.parse(window.localStorage.getItem("movie-hub.theme") ?? "null") as unknown;
    return value === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
})();

document.documentElement.dataset.theme = storedTheme;
document.documentElement.style.colorScheme = storedTheme;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
