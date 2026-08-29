import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./statistics-guide.css";
import "./runtime-handoff.css";
import "./native-documents.css";
import "./installed.css";
import "./registry.css";
import "./theme.css";
import "./steps.css";
import "./workspace.css";
import "./result-view.css";
import "./export-dialog.css";
import { installNativeBridge } from "./kernel/native-bridge";

installNativeBridge();

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("./sw.js").catch(() => undefined);
