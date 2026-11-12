// Apply the saved theme and mode before first paint, so the page does not
// flash the default look. Mirrors src/store/theme.ts (keys ww-theme and
// ww-theme-variant).
//
// This is a file and not an inline <script> on purpose: the app's
// Content-Security-Policy allows scripts from its own origin only, and an
// inline block would need 'unsafe-inline', which is the thing the policy
// exists to refuse. Loaded without defer so it runs before the body.
(function () {
  try {
    var root = document.documentElement;
    // Keep in step with DEFAULT_THEME in src/lib/themes.ts.
    var variant = localStorage.getItem("paiso-theme-variant") || "classic";
    root.setAttribute("data-theme", variant);
    var mode = localStorage.getItem("paiso-theme");
    // No choice yet, or an explicit "system": both follow the OS.
    if (!mode || mode === "system") {
      mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    root.classList.toggle("dark", mode === "dark");
    root.classList.toggle("gray", mode === "gray");
  } catch (e) {}
})();
