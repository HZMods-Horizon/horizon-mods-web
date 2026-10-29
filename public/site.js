(function () {
  function themeChoice() {
    try {
      var stored = localStorage.getItem("hm-theme");
      if (stored === "light" || stored === "dark" || stored === "system") return stored;
    } catch (err) { /* storage can be blocked */ }
    return "system";
  }

  function applyTheme(choice) {
    var theme = choice;
    if (choice !== "light" && choice !== "dark") {
      choice = "system";
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-theme-choice", choice);
    try { localStorage.setItem("hm-theme", choice); } catch (err) { /* storage can be blocked */ }
    document.querySelectorAll("[data-theme-set]").forEach(function (el) {
      var on = el.getAttribute("data-theme-set") === choice;
      el.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  document.querySelectorAll("[data-theme-toggle]").forEach(function (themeButton) {
    themeButton.addEventListener("click", function () {
      applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
    });
  });
  document.querySelectorAll("[data-theme-set]").forEach(function (el) {
    el.addEventListener("click", function () { applyTheme(el.getAttribute("data-theme-set")); });
  });
  applyTheme(themeChoice());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (themeChoice() === "system") applyTheme("system");
  });
})();

(function () {
  var openPick = null;
  var modal = document.querySelector("[data-modal]");
  var modalText = modal && modal.querySelector("[data-modal-text]");
  var pending = null;
  var lastFocus = null;
  var bodyOverflow = "";

  function closePick(pick) {
    if (!pick) return;
    pick.classList.remove("is-open");
    var menu = pick.menuEl;
    var btn = pick.querySelector(".pick-btn");
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (openPick === pick) openPick = null;
  }

  function placeMenu(pick) {
    var menu = pick.menuEl;
    var btn = pick.querySelector(".pick-btn");
    if (!menu || !btn || menu.hidden) return;
    var rect = btn.getBoundingClientRect();
    var gap = 6;
    var edge = 8;
    var width = Math.min(Math.max(rect.width, 160), window.innerWidth - edge * 2);
    var left = rect.left;
    if (left + width > window.innerWidth - edge) left = window.innerWidth - edge - width;
    if (left < edge) left = edge;
    var spaceBelow = window.innerHeight - rect.bottom - gap - edge;
    var spaceAbove = rect.top - gap - edge;
    var openDown = spaceBelow >= 120 || spaceBelow >= spaceAbove;
    var maxH = Math.max(72, Math.min(280, openDown ? spaceBelow : spaceAbove));
    menu.style.left = left + "px";
    menu.style.width = width + "px";
    menu.style.bottom = "auto";
    menu.style.maxHeight = maxH + "px";
    menu.style.top = "0px";
    var height = menu.offsetHeight;
    if (openDown) menu.style.top = (rect.bottom + gap) + "px";
    else menu.style.top = Math.max(edge, rect.top - gap - height) + "px";
  }

  function focusOpt(item) {
    if (!item) return;
    if (item.focus) item.focus({ preventScroll: true });
    var menu = item.parentElement;
    if (!menu) return;
    var top = item.offsetTop;
    var bottom = top + item.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
  }

  function openMenu(pick) {
    document.querySelectorAll(".pick.is-open").forEach(function (other) {
      if (other !== pick) closePick(other);
    });
    var menu = pick.menuEl;
    var btn = pick.querySelector(".pick-btn");
    pick.classList.add("is-open");
    if (menu) {
      menu.hidden = false;
      placeMenu(pick);
    }
    if (btn) btn.setAttribute("aria-expanded", "true");
    openPick = pick;
    var current = menu && (menu.querySelector('[aria-selected="true"]') || menu.querySelector(".pick-opt"));
    focusOpt(current);
  }

  document.querySelectorAll(".pick").forEach(function (pick) {
    var select = pick.querySelector("select");
    if (!select) return;
    select.classList.add("pick-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    var chosen = select.options[select.selectedIndex];
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost pick-btn";
    btn.setAttribute("data-ui", "");
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = chosen ? chosen.textContent : "";
    if (select.id) {
      btn.id = select.id;
      select.id = select.id + "-value";
    }
    var menu = document.createElement("div");
    menu.className = "pick-menu";
    menu.id = (btn.id || select.name || "pick") + "-list";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    btn.setAttribute("aria-controls", menu.id);
    Array.prototype.forEach.call(select.options, function (opt) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "ghost pick-opt";
      item.setAttribute("data-ui", "");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", opt.selected ? "true" : "false");
      item.textContent = opt.textContent;
      item.addEventListener("click", function () {
        select.value = opt.value;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        btn.textContent = opt.textContent;
        menu.querySelectorAll("[aria-selected='true']").forEach(function (el) {
          el.setAttribute("aria-selected", "false");
        });
        item.setAttribute("aria-selected", "true");
        closePick(pick);
        btn.focus();
      });
      menu.appendChild(item);
    });
    btn.addEventListener("click", function () {
      if (pick.classList.contains("is-open")) closePick(pick);
      else openMenu(pick);
    });
    btn.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      if (!pick.classList.contains("is-open")) {
        openMenu(pick);
        return;
      }
      var list = pick.menuEl;
      var current = list && (list.querySelector('[aria-selected="true"]') || list.querySelector(".pick-opt"));
      focusOpt(current);
    });
    select.addEventListener("focus", function () { btn.focus(); });
    select.addEventListener("invalid", function (event) {
      event.preventDefault();
      openMenu(pick);
    });
    pick.menuEl = menu;
    pick.appendChild(btn);
    document.body.appendChild(menu);
    pick.classList.add("is-ready");
  });

  window.addEventListener("resize", function () {
    if (openPick) placeMenu(openPick);
  });
  document.addEventListener("scroll", function (event) {
    if (!openPick || !openPick.menuEl) return;
    if (event.target === openPick.menuEl) return;
    placeMenu(openPick);
  }, true);
  document.addEventListener("focusin", function (event) {
    if (!openPick) return;
    var target = event.target;
    if (openPick.contains(target) || (openPick.menuEl && openPick.menuEl.contains(target))) return;
    closePick(openPick);
  });

  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.style.overflow = bodyOverflow;
    pending = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  function openConfirm(button) {
    if (!modal || !modalText) {
      if (button.form) button.form.requestSubmit(button);
      return;
    }
    closePick(openPick);
    pending = button;
    lastFocus = document.activeElement;
    modalText.textContent = button.getAttribute("data-confirm") || "";
    bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modal.hidden = false;
    var ok = modal.querySelector("[data-modal-ok]");
    if (ok) ok.focus();
  }

  document.addEventListener("click", function (event) {
    var confirmBtn = event.target.closest && event.target.closest("[data-confirm]");
    if (confirmBtn && (!modal || !modal.contains(confirmBtn))) {
      event.preventDefault();
      openConfirm(confirmBtn);
      return;
    }
    var alertClose = event.target.closest && event.target.closest("[data-alert-close]");
    if (alertClose) {
      var box = alertClose.closest(".alert");
      if (box) box.remove();
      return;
    }
    var peek = event.target.closest && event.target.closest("[data-peek]");
    if (peek) {
      var input = peek.parentElement && peek.parentElement.querySelector("input");
      if (input) {
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        peek.textContent = show ? (document.body.dataset.peekHide || "") : (document.body.dataset.peekShow || "");
        peek.setAttribute("aria-pressed", show ? "true" : "false");
      }
      return;
    }
    var copy = event.target.closest && event.target.closest("[data-copy]");
    if (copy) {
      var source = copy.closest(".alert") && copy.closest(".alert").querySelector("[data-copy-text]");
      var text = source ? source.textContent : "";
      var original = copy.textContent;
      var done = function () {
        copy.textContent = document.body.dataset.copied || original;
        setTimeout(function () { copy.textContent = original; }, 1600);
      };
      var fallback = function () {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        try { document.execCommand("copy"); } catch (err) { /* clipboard can be blocked */ }
        area.remove();
        done();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else fallback();
      return;
    }
    if (modal && !modal.hidden && (event.target === modal || (event.target.closest && event.target.closest("[data-modal-cancel]")))) {
      closeModal();
      return;
    }
    if (modal && !modal.hidden && event.target.closest && event.target.closest("[data-modal-ok]")) {
      var button = pending;
      closeModal();
      if (button && button.form && button.form.requestSubmit) button.form.requestSubmit(button);
      return;
    }
    if (openPick && !openPick.contains(event.target) && !(openPick.menuEl && openPick.menuEl.contains(event.target))) closePick(openPick);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      if (openPick) {
        var back = openPick.querySelector(".pick-btn");
        closePick(openPick);
        if (back) back.focus();
        return;
      }
      var openMenu = document.querySelector("[data-account-menu]:not([hidden])");
      if (openMenu) {
        openMenu.hidden = true;
        var menuToggle = openMenu.parentElement && openMenu.parentElement.querySelector("[data-account-toggle]");
        if (menuToggle) {
          menuToggle.setAttribute("aria-expanded", "false");
          menuToggle.focus();
        }
        return;
      }
      closeModal();
      return;
    }
    if (modal && !modal.hidden && event.key === "Tab") {
      var items = modal.querySelectorAll("button");
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    var opt = event.target.closest && event.target.closest(".pick-opt");
    if (!opt) return;
    var items = Array.prototype.slice.call(opt.parentElement.querySelectorAll(".pick-opt"));
    var index = items.indexOf(opt);
    if (event.key === "Home") {
      event.preventDefault();
      focusOpt(items[0]);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusOpt(items[items.length - 1]);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    focusOpt(items[index + (event.key === "ArrowDown" ? 1 : -1)]);
  });

  document.querySelectorAll(".file-input").forEach(function (input) {
    input.addEventListener("change", function () {
      var name = input.parentElement && input.parentElement.querySelector(".file-name");
      if (!name) return;
      var files = input.files;
      if (!files || !files.length) {
        name.textContent = document.body.dataset.fileNone || "";
        return;
      }
      if (input.multiple && files.length > 1) {
        var tmpl = input.getAttribute("data-file-many") || "{n}";
        name.textContent = tmpl.replace("{n}", String(files.length));
        return;
      }
      name.textContent = files[0].name;
    });
  });

  function closeAccountMenus(except) {
    document.querySelectorAll("[data-account-menu]").forEach(function (menu) {
      if (menu === except) return;
      menu.hidden = true;
      var toggle = menu.parentElement && menu.parentElement.querySelector("[data-account-toggle]");
      if (toggle) toggle.setAttribute("aria-expanded", "false");
    });
  }

  document.querySelectorAll("[data-account-toggle]").forEach(function (toggle) {
    var menu = toggle.parentElement && toggle.parentElement.querySelector("[data-account-menu]");
    if (!menu) return;
    toggle.parentElement.classList.add("is-ready");
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", function (event) {
      event.stopPropagation();
      var willOpen = menu.hidden;
      closeAccountMenus(willOpen ? menu : null);
      menu.hidden = !willOpen;
      toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });
  });
  document.addEventListener("click", function () { closeAccountMenus(null); });

  document.querySelectorAll("[data-swatch]").forEach(function (swatch) {
    var input = swatch.parentElement && swatch.parentElement.querySelector("input");
    if (!input) return;
    var paint = function () {
      swatch.style.background = /^#[0-9a-fA-F]{6}$/.test(input.value) ? input.value : "transparent";
    };
    input.addEventListener("input", paint);
  });
})();
