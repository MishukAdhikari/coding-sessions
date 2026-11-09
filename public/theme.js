/* Apply before styles paint, including on the login and terminal pages. */
(() => {
  const key = "xs_theme";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const normalize = (value) => value === "light" || value === "dark" ? value : "system";
  let preference = "system";
  try { preference = normalize(localStorage.getItem(key)); } catch {}

  function apply() {
    const dark = preference === "dark" || (preference === "system" && system.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    // One color per scheme for the browser before this runs; then the chosen one,
    // so a forced theme also colors the status bar and Android's task switcher.
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = dark ? "#141b20" : "#f3f2ed";
    const picker = document.getElementById("theme-preference");
    if (picker) picker.value = preference;
  }
  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.key !== key && event.key !== null) return;
    preference = normalize(event.newValue);
    apply();
  });
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.getElementById("theme-preference")?.addEventListener("change", (event) => {
      preference = normalize(event.target.value);
      try {
        if (preference === "system") localStorage.removeItem(key);
        else localStorage.setItem(key, preference);
      } catch {}
      apply();
    });
  });
})();
