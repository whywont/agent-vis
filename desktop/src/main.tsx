import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "../../public/style.css";
import "./desktop.css";

document.documentElement.classList.add(
  navigator.userAgent.includes("Mac") ? "platform-macos" : "platform-native-titlebar",
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
