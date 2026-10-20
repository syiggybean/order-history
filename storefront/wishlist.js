/* Wishlist (order-history app)
 * Loaded by the "Wishlist" app embed. Adds a heart after product names on
 * product pages and in collection/search grids, and a wishlist icon in the
 * header. Saving needs a logged-in customer; anyone else is asked to log in
 * or create an account.
 * Source file: edit here, then run `npm run build:storefront`.
 */
(function () {
  var cfgEl = document.getElementById("ohwl-config");
  if (!cfgEl || window.__ohwl) return;
  window.__ohwl = true;
  var cfg;
  try {
    cfg = JSON.parse(cfgEl.textContent);
  } catch (e) {
    return;
  }
  var base = cfg.base || "/apps/purchase-history";
  var pageUrl = base + "/wishlist";
  var KEY = "ohwl:v1";

  var TITLE =
    ".product__title h1,h1.product__title,h1.product-title,.product-single__title,.product-meta__title,.product-info__title,.product__info-container h1,.product-info h1,h1[itemprop=name]";
  var CARD =
    ".card__heading,.product-card__title,.product-card__name,.product-item__title,.product-item-meta__title,.grid-product__title,.grid-view-item__title,.product-block__title,.ohwl-card__title";
  var HEADER = ".header__icons,.header-icons,.site-header__icons,.header__icon-list,.header-actions";
  var CART = "#cart-icon-bubble,header a[href$='/cart'],.header a[href$='/cart'],a[href$='/cart']";
  // Places hearts don't belong: the header, menus, search suggestions, our own page
  var SKIP =
    "[data-ohwl-skip],.shopify-section-group-header-group,#shopify-section-header,header.header,header[role=banner],.site-header,predictive-search,.predictive-search,#predictive-search,.shopify-section-group-footer-group,#shopify-section-footer,footer.footer,.site-footer,.ohwl-modal";
  var SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 20.5s-7.2-4.4-9.2-8.8C1.4 8.4 3.3 4.6 6.9 4.6c2 0 3.5 1.1 4.3 2.4h1.6c.8-1.3 2.3-2.4 4.3-2.4 3.6 0 5.5 3.8 4.1 7.1-2 4.4-9.2 8.8-9.2 8.8z"/></svg>';

  // What's saved: [{ id, handle }]. Product pages know the id; grid cards
  // only know the handle from their link.
  var saved = [];
  var count = 0;

  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return "&#" + c.charCodeAt(0) + ";";
    });
  };
  var first = function (sel) {
    try {
      var list = document.querySelectorAll(sel);
      for (var i = 0; i < list.length; i++) if (!list[i].closest("[data-ohwl-skip]")) return list[i];
    } catch (e) {
      // a bad custom selector: ignore it
    }
    return null;
  };
  var all = function (sel) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  };
  var handleOf = function (href) {
    var m = /\/products\/([^/?#]+)/.exec(href || "");
    try {
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) {
      return m ? m[1] : null;
    }
  };
  var matches = function (e, id, handle) {
    return (id && e.id === String(id)) || (handle && e.handle === handle);
  };
  var isSaved = function (id, handle) {
    return saved.some(function (e) {
      return matches(e, id, handle);
    });
  };

  function remember() {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ saved: saved, count: count }));
    } catch (e) {
      // storage blocked: fine, the list is fetched on each page anyway
    }
  }

  // ---------------------------------------------------------------- drawing

  function heart(id, handle, extra) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "ohwl-heart" + (extra ? " " + extra : "");
    if (id) b.setAttribute("data-id", String(id));
    if (handle) b.setAttribute("data-handle", handle);
    b.innerHTML = SVG;
    paintHeart(b);
    return b;
  }

  function paintHeart(b) {
    var on = isSaved(b.getAttribute("data-id"), b.getAttribute("data-handle"));
    var want = on ? "true" : "false";
    if (b.getAttribute("aria-pressed") === want) return;
    b.setAttribute("aria-pressed", want);
    b.setAttribute("aria-label", on ? "Remove from wishlist" : "Add to wishlist");
    b.title = on ? "Saved to your wishlist" : "Save to your wishlist";
  }

  function paint() {
    all(".ohwl-heart").forEach(paintHeart);
    all(".ohwl-hdr__n").forEach(function (n) {
      var text = String(count);
      if (n.textContent !== text) n.textContent = text;
      if (n.hidden !== !count) n.hidden = !count;
    });
  }

  function addHeader() {
    if (document.querySelector(".ohwl-hdr")) return;
    var box = first(cfg.headerSel || HEADER);
    var cart = first(CART);
    if (!box && !cart) return;
    var a = document.createElement("a");
    a.href = pageUrl;
    a.className = "ohwl-hdr";
    a.setAttribute("aria-label", "Wishlist");
    a.innerHTML = '<span class="ohwl-hdr__i">' + SVG + '</span><span class="ohwl-hdr__n" hidden>0</span>';
    if (cart && (!box || box.contains(cart))) {
      // Look like the neighbouring icons, without picking up cart behaviour
      Array.prototype.forEach.call(cart.classList, function (c) {
        if (!/cart|bubble|drawer|count|active|open|js-|toggle/i.test(c)) a.classList.add(c);
      });
      cart.parentNode.insertBefore(a, cart);
    } else {
      box.appendChild(a);
    }
  }

  function scan() {
    // Product page: the heart goes in the "Wishlist heart" block if there is
    // one, otherwise after the product name
    if (cfg.product && cfg.onProduct !== false) {
      all("[data-ohwl-slot]:not([data-ohwl-done])").forEach(function (s) {
        s.setAttribute("data-ohwl-done", "");
        s.appendChild(heart(s.getAttribute("data-pid") || cfg.product.id, s.getAttribute("data-handle") || cfg.product.handle, "ohwl-heart--lg"));
      });
      if (!document.querySelector("[data-ohwl-slot],.ohwl-heart--title")) {
        var t = first(cfg.titleSel || TITLE);
        if (t && !t.closest(SKIP)) {
          t.setAttribute("data-ohwl-done", "");
          t.appendChild(heart(cfg.product.id, cfg.product.handle, "ohwl-heart--lg ohwl-heart--title"));
        }
      }
    }
    // Product cards in grids (collections, search, recommendations)
    if (cfg.onCards !== false) {
      all(cfg.cardSel || CARD).forEach(function (t) {
        if (t.hasAttribute("data-ohwl-done") || t.closest(SKIP)) return;
        var a =
          t.tagName === "A"
            ? t
            : t.querySelector("a[href*='/products/']") || t.closest("a[href*='/products/']");
        if (!a) {
          var card = t.closest("li,article,.card,.card-wrapper,.product-card,.product-item,.grid-product,.grid__item");
          a = card && card.querySelector("a[href*='/products/']");
        }
        var h = a && handleOf(a.getAttribute("href"));
        if (!h) return;
        t.setAttribute("data-ohwl-done", "");
        var b = heart(null, h, "ohwl-heart--card");
        if (t.tagName === "A") t.parentNode.insertBefore(b, t.nextSibling);
        else t.appendChild(b);
      });
    }
    if (cfg.header !== false) addHeader();
  }

  // ---------------------------------------------------------------- popups

  function toast(html) {
    var t = document.querySelector(".ohwl-toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "ohwl-toast";
      t.setAttribute("role", "status");
      t.setAttribute("aria-live", "polite");
      document.body.appendChild(t);
    }
    t.innerHTML = html;
    t.classList.add("is-on");
    clearTimeout(t._h);
    t._h = setTimeout(function () {
      t.classList.remove("is-on");
    }, 4200);
  }

  var lastFocus = null;
  function closeModal() {
    var m = document.querySelector(".ohwl-modal");
    if (m && !m.hidden) {
      m.hidden = true;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
  }
  function loginPrompt() {
    lastFocus = document.activeElement;
    var m = document.querySelector(".ohwl-modal");
    if (!m) {
      var back = encodeURIComponent(location.pathname + location.search);
      var login = (cfg.login || "/account/login") + ((cfg.login || "").indexOf("?") < 0 ? "?" : "&") + "return_url=" + back;
      m = document.createElement("div");
      m.className = "ohwl-modal";
      m.setAttribute("role", "dialog");
      m.setAttribute("aria-modal", "true");
      m.setAttribute("aria-labelledby", "ohwl-modal-t");
      m.innerHTML =
        '<div class="ohwl-modal__box"><button type="button" class="ohwl-modal__x" aria-label="Close">&times;</button>' +
        '<span class="ohwl-modal__i">' + SVG + "</span>" +
        '<h2 id="ohwl-modal-t">Save it to your wishlist</h2>' +
        "<p>Log in or create an account to save products and find them again on any device.</p>" +
        '<div class="ohwl-modal__btns"><a class="ohwl-modal__btn ohwl-modal__btn--solid" href="' + esc(login) + '">Log in</a>' +
        '<a class="ohwl-modal__btn" href="' + esc(cfg.register || "/account/register") + '">Create account</a></div></div>';
      document.body.appendChild(m);
      m.addEventListener("click", function (e) {
        if (e.target === m || e.target.closest(".ohwl-modal__x")) closeModal();
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeModal();
      });
    }
    m.hidden = false;
    var link = m.querySelector("a");
    if (link) link.focus();
  }

  // ---------------------------------------------------------------- saving

  function setLocal(id, handle, on) {
    var had = isSaved(id, handle);
    saved = saved.filter(function (e) {
      return !matches(e, id, handle);
    });
    if (on) saved.unshift({ id: id ? String(id) : null, handle: handle || null });
    if (on && !had) count++;
    if (!on && had) count = Math.max(0, count - 1);
  }

  function toggle(b) {
    var id = b.getAttribute("data-id");
    var handle = b.getAttribute("data-handle");
    var on = !isSaved(id, handle);
    setLocal(id, handle, on);
    paint();
    b.classList.remove("is-pop");
    void b.offsetWidth;
    if (on) b.classList.add("is-pop");
    fetch(base + "/wishlist/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ productId: id || undefined, handle: handle || undefined, on: on }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok || !j.ok) throw j;
          return j;
        });
      })
      .then(function (j) {
        // Now we know both the id and the handle
        setLocal(j.id, handle, false);
        if (id && id !== j.id) setLocal(id, null, false);
        if (on) setLocal(j.id, handle, true);
        count = j.count;
        paint();
        remember();
        if (on)
          toast(
            "Saved to your wishlist. <a href=\"" + esc(pageUrl) + '">View wishlist</a>' +
              (j.count === 1 ? "<small>We'll email you if it's back in stock or opens for pre-order. You can turn this off on your wishlist.</small>" : ""),
          );
      })
      .catch(function (j) {
        setLocal(id, handle, !on);
        paint();
        if (j && j.loggedIn === false) {
          cfg.customer = false;
          loginPrompt();
          return;
        }
        toast(esc((j && j.error) || "We couldn't update your wishlist. Please try again."));
      });
  }

  // Capture phase: hearts sit inside clickable product cards
  document.addEventListener(
    "click",
    function (e) {
      var b = e.target && e.target.closest && e.target.closest(".ohwl-heart");
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      if (!cfg.customer) loginPrompt();
      else toggle(b);
    },
    true,
  );

  // The wishlist page removed something
  document.addEventListener("ohwl:changed", function (e) {
    var d = e.detail || {};
    setLocal(d.id, null, d.on);
    if (typeof d.count === "number") count = d.count;
    paint();
    remember();
  });

  // ---------------------------------------------------------------- start

  if (cfg.customer) {
    try {
      var cached = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (cached && Array.isArray(cached.saved)) {
        saved = cached.saved;
        count = cached.count || saved.length;
      }
    } catch (e) {
      // nothing cached
    }
  } else {
    try {
      sessionStorage.removeItem(KEY);
    } catch (e) {
      // storage blocked
    }
  }

  var queued = false;
  function later() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      scan();
      paint();
    });
  }
  scan();
  paint();
  // Grids that load more products, filters, quick views
  if (window.MutationObserver) new MutationObserver(later).observe(document.body, { childList: true, subtree: true });

  if (cfg.customer) {
    fetch(base + "/wishlist/items", { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j || j.ok === false) return;
        if (j.loggedIn === false) {
          cfg.customer = false;
          saved = [];
          count = 0;
        } else {
          saved = (j.items || []).map(function (i) {
            return { id: String(i.id), handle: i.handle || null };
          });
          count = j.count || saved.length;
        }
        paint();
        remember();
      })
      .catch(function () {
        // leave the hearts as they are
      });
  }
})();
