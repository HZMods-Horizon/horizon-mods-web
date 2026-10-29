(function () {
  var button = document.querySelector("[data-theme-toggle]");
  if (button) {
    button.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("hm-theme", next); } catch (err) { /* storage can be blocked */ }
    });
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var groups = [
    [".desk, .nav-panel", "a, button:not([data-ui])"],
    [".row", "a.btn, a.nav-link, a.who, button:not([data-ui])"],
    [".foot-links, .pager", "a, button:not([data-ui])"],
    [".lang", "a"],
    [".who-row", "a, button:not([data-ui])"],
    [".user-row", "button:not([data-ui])"],
  ];
  var hosts = [];

  function borderBox(el) {
    var style = getComputedStyle(el);
    return {
      left: parseFloat(style.borderLeftWidth) || 0,
      top: parseFloat(style.borderTopWidth) || 0,
    };
  }

  function paint(host, target, instant) {
    var blob = host.blob;
    var hostBox = host.getBoundingClientRect();
    var targetBox = target.getBoundingClientRect();
    var edge = borderBox(host);
    var left = targetBox.left - hostBox.left - edge.left;
    var top = targetBox.top - hostBox.top - edge.top;
    var solid = target.matches("button, .btn, summary") || host.classList.contains("lang");
    blob.classList.toggle("on-solid", solid);
    blob.classList.toggle("on-link", !solid);
    if (instant || !host.ready) {
      blob.style.transition = "none";
      blob.style.left = left + "px";
      blob.style.top = top + "px";
      blob.style.width = targetBox.width + "px";
      blob.style.height = targetBox.height + "px";
      blob.style.borderRadius = getComputedStyle(target).borderRadius;
      blob.offsetWidth;
      blob.style.transition = "";
      host.ready = true;
      return;
    }
    var prevLeft = blob.offsetLeft;
    var prevWidth = blob.offsetWidth;
    var unionLeft = Math.min(prevLeft, left);
    var unionRight = Math.max(prevLeft + prevWidth, left + targetBox.width);
    blob.style.left = unionLeft + "px";
    blob.style.width = (unionRight - unionLeft) + "px";
    blob.style.top = top + "px";
    blob.style.height = targetBox.height + "px";
    blob.style.borderRadius = "999px";
    clearTimeout(host.timer);
    host.timer = setTimeout(function () {
      if (host.current !== target) return;
      blob.style.left = left + "px";
      blob.style.width = targetBox.width + "px";
      blob.style.borderRadius = getComputedStyle(target).borderRadius;
    }, 150);
  }

  function mark(host, target) {
    host.querySelectorAll(".flow-on").forEach(function (el) {
      if (el === target) return;
      el.classList.remove("flow-on");
      el.classList.add("flow-leave");
    });
    target.classList.add("flow-on");
    target.classList.remove("flow-leave");
    clearTimeout(host.leaveTimer);
    host.leaveTimer = setTimeout(function () {
      host.querySelectorAll(".flow-leave").forEach(function (el) { el.classList.remove("flow-leave"); });
    }, 420);
  }

  function clearMark(host) {
    host.querySelectorAll(".flow-on, .flow-leave").forEach(function (el) {
      el.classList.remove("flow-on");
      el.classList.remove("flow-leave");
    });
  }

  document.querySelectorAll(groups.map(function (item) { return item[0]; }).join(",")).forEach(function (host) {
    var selector = "";
    for (var i = 0; i < groups.length; i += 1) {
      if (host.matches(groups[i][0])) selector = groups[i][1];
    }
    var targets = host.querySelectorAll(selector);
    if (targets.length < 2) return;
    host.classList.add("flow-host");
    var blob = document.createElement("span");
    blob.className = "water";
    blob.setAttribute("aria-hidden", "true");
    host.prepend(blob);
    host.blob = blob;
    host.current = null;
    host.ready = false;
    hosts.push(host);

    function aim(target, instant) {
      if (!target || host.current === target) return;
      host.current = target;
      mark(host, target);
      paint(host, target, instant);
      blob.classList.add("is-on");
    }

    function owned(event) {
      var target = event.target.closest(selector);
      if (!target || !host.contains(target)) return null;
      if (target.parentElement && target.parentElement.closest(".flow-host") !== host) return null;
      return target;
    }
    host.addEventListener("mouseover", function (event) {
      var target = owned(event);
      if (!target) return;
      aim(target, !host.ready);
    });
    host.addEventListener("focusin", function (event) {
      var target = owned(event);
      if (!target) return;
      aim(target, !host.ready);
    });
    host.addEventListener("mouseleave", function () {
      clearTimeout(host.timer);
      blob.classList.remove("is-on");
      clearMark(host);
      host.current = null;
    });
  });

  window.addEventListener("resize", function () {
    hosts.forEach(function (host) {
      if (!host.current) return;
      var current = host.current;
      host.current = null;
      host.ready = true;
      paint(host, current, true);
      host.current = current;
    });
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
    var menu = pick.querySelector(".pick-menu");
    var btn = pick.querySelector(".pick-btn");
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (openPick === pick) openPick = null;
  }

  function placeMenu(menu) {
    menu.style.top = "";
    menu.style.bottom = "";
    var rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8 && rect.top > rect.height + 8) {
      menu.style.top = "auto";
      menu.style.bottom = "calc(100% + 6px)";
    }
  }

  function openMenu(pick) {
    document.querySelectorAll(".pick.is-open").forEach(function (other) {
      if (other !== pick) closePick(other);
    });
    var menu = pick.querySelector(".pick-menu");
    var btn = pick.querySelector(".pick-btn");
    pick.classList.add("is-open");
    if (menu) {
      menu.hidden = false;
      placeMenu(menu);
    }
    if (btn) btn.setAttribute("aria-expanded", "true");
    openPick = pick;
    var current = menu && (menu.querySelector('[aria-selected="true"]') || menu.querySelector(".pick-opt"));
    if (current) current.focus();
  }

  document.querySelectorAll(".pick").forEach(function (pick) {
    var select = pick.querySelector("select");
    if (!select) return;
    select.classList.add("pick-native");
    select.tabIndex = -1;
    var chosen = select.options[select.selectedIndex];
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost pick-btn";
    btn.setAttribute("data-ui", "");
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = chosen ? chosen.textContent : "";
    var menu = document.createElement("div");
    menu.className = "pick-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
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
      if (event.key === "ArrowDown" && !pick.classList.contains("is-open")) {
        event.preventDefault();
        openMenu(pick);
      }
    });
    select.addEventListener("focus", function () { btn.focus(); });
    select.addEventListener("invalid", function (event) {
      event.preventDefault();
      openMenu(pick);
    });
    pick.appendChild(btn);
    pick.appendChild(menu);
    pick.classList.add("is-ready");
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
    if (openPick && !openPick.contains(event.target)) closePick(openPick);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      if (openPick) {
        var back = openPick.querySelector(".pick-btn");
        closePick(openPick);
        if (back) back.focus();
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
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    var items = Array.prototype.slice.call(opt.parentElement.querySelectorAll(".pick-opt"));
    var index = items.indexOf(opt);
    var next = items[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) next.focus();
  });

  document.querySelectorAll(".file-input").forEach(function (input) {
    input.addEventListener("change", function () {
      var name = input.parentElement && input.parentElement.querySelector(".file-name");
      if (!name) return;
      var file = input.files && input.files[0];
      name.textContent = file ? file.name : (document.body.dataset.fileNone || "");
    });
  });

  document.querySelectorAll("[data-swatch]").forEach(function (swatch) {
    var input = swatch.parentElement && swatch.parentElement.querySelector("input");
    if (!input) return;
    var paint = function () {
      swatch.style.background = /^#[0-9a-fA-F]{6}$/.test(input.value) ? input.value : "transparent";
    };
    input.addEventListener("input", paint);
  });
})();
