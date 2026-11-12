import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { restoreSession } from "./lib/api";
import { watchForNewBuild } from "./lib/staleBuild";
import { useAuthStore } from "./store/auth";
import "./fonts.css";
import "./index.css";

// Before anything draws: a tab that outlived a deploy reloads itself.
watchForNewBuild();

function start() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// The access token lives in memory only, so a reload begins without one. If
// this browser was signed in, get a new token from the refresh cookie before
// drawing, so the first screen's requests go out authorised and the pages
// that fetch images directly have a token to send. If that fails the app
// still starts; its first request is refused and it goes to sign-in.
if (useAuthStore.getState().isAuthenticated) {
  restoreSession().finally(start);
} else {
  start();
}
