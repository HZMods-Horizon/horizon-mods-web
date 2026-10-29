(function () {
  var theme = "light";
  try {
    var stored = localStorage.getItem("hm-theme");
    if (stored === "light" || stored === "dark") theme = stored;
    else if (window.matchMedia("(prefers-color-scheme: dark)").matches) theme = "dark";
  } catch (err) {
    theme = "light";
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
