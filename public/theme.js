(function () {
  var choice = "system";
  try {
    var stored = localStorage.getItem("hm-theme");
    if (stored === "light" || stored === "dark" || stored === "system") choice = stored;
  } catch (err) {
    choice = "system";
  }
  var theme = choice === "light" || choice === "dark"
    ? choice
    : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-theme-choice", choice);
})();
