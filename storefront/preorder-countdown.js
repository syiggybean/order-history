/* Pre-order countdown (order-history app)
 *
 * The "Pre-order countdown" block [data-ohpc], above the buy buttons.
 * (The closing clock under the buttons is preorder-closing.js.)
 * Source file: edit here, then run `npm run build:storefront`.
 *
 * Phases, from the opening/closing times on the product:
 *   scheduled  flip clock + "email me when it opens"; buy controls hidden
 *   open       button reads "Pre-Order"; closing clock under it
 *              (with a sales limit, a variant at 0 shows "Pre-Orders Closed" + sign-up)
 *   closed     buy controls greyed out, "Pre-Orders Closed" + sign-up
 *
 * The app also switches selling on and off in Shopify at the same moments,
 * so the product can't be bought anywhere outside the window. This script is
 * the product page's side of it.
 */
import { Clock, phaseAt } from "./flipclock.js";

(function () {
  "use strict";

  var BUTTON = 'button[name="add"], [data-add-to-cart], .add-to-cart, .product-form__submit';
  var BUTTON_TEXT = "[data-add-to-cart-text], .add-to-cart__text, .product-form__submit-text";
  var REF_DAYS = 14;
  var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";

  var OOPS = "Something went wrong. Please try again.";

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Main block: countdown, buy buttons, sign-up form
  // ---------------------------------------------------------------------------

  function Countdown(el) {
    this.el = el;
    this.opens = Number(el.getAttribute("data-opens")) * 1000 || null;
    this.closes = Number(el.getAttribute("data-closes")) * 1000 || null;
    this.limited = el.getAttribute("data-limited") === "true";
    this.productId = el.getAttribute("data-product-id");
    this.handle = el.getAttribute("data-handle");
    // Wording comes from the block's settings in the theme editor
    var attr = function (name) {
      return el.getAttribute("data-" + name) || "";
    };
    this.text = {
      open: attr("open-text") || "Pre-Order",
      closed: attr("closed-text") || "Pre-Orders Closed",
      soldOut: attr("sold-out-text") || "Pre-Orders Closed",
      notifyScheduled: attr("notify-scheduled"),
      notifySoldOut: attr("notify-sold-out"),
      notifyClosed: attr("notify-closed"),
      thanks: attr("notify-thanks"),
    };
    // The product section this block sits in (falls back to the whole page)
    this.root =
      el.closest('[data-section-type="product"], [data-product-section], .shopify-section, section') || document.body;
    this.panel = el.querySelector("[data-ohpc-panel]");
    this.notify = el.querySelector("[data-ohpc-notify]");
    this.clock = this.panel ? new Clock(this.panel, "until pre-orders open") : null;
    this.phase = null;
    this.soldOut = false;
    this.available = null; // variant id -> buyable, fetched fresh once open
    this.setupForm();
    this.tick = this.tick.bind(this);
    this.tick();
    this.timer = setInterval(this.tick, 250);
  }

  Countdown.prototype.tick = function () {
    var now = Date.now();
    var phase = phaseAt(this.opens, this.closes, now);
    if (phase !== this.phase) {
      var first = this.phase === null;
      this.phase = phase;
      this.apply(phase, first);
    }
    if (phase === "scheduled" && this.clock) this.clock.draw(this.opens - now);
  };

  Countdown.prototype.buttons = function () {
    return Array.prototype.slice.call(this.root.querySelectorAll(BUTTON));
  };

  Countdown.prototype.setButtonText = function (btn, text) {
    var target = btn.querySelector(BUTTON_TEXT);
    if (!target) {
      // A plain button, or one whose only element is an icon or spinner
      var spans = btn.querySelectorAll("span");
      target = btn.children.length === 0 ? btn : spans.length === 1 ? spans[0] : null;
    }
    if (target && target.textContent.trim() !== text) target.textContent = text;
    else if (!target && btn.textContent.trim() !== text) btn.textContent = text;
  };

  Countdown.prototype.currentVariant = function () {
    var input = this.root.querySelector('form[action*="/cart/add"] [name="id"]');
    return input ? String(input.value) : null;
  };

  // Is the selected variant buyable right now? null = not known yet
  Countdown.prototype.variantBuyable = function () {
    var v = this.currentVariant();
    if (!this.available || !v || !(v in this.available)) return null;
    return this.available[v];
  };

  // Keep the button's text right when the theme redraws it (e.g. on a
  // variant change, the theme resets it to "Add to cart" or "Sold out")
  Countdown.prototype.enforceButtons = function () {
    var self = this;
    var buyable = this.variantBuyable();
    var soldOut = this.phase === "open" && this.limited && buyable === false;
    this.root.classList.toggle("ohpc-soldout", soldOut);
    this.buttons().forEach(function (btn) {
      if (self.phase === "closed" || soldOut) {
        if (!btn.disabled) btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
        self.setButtonText(btn, soldOut ? self.text.soldOut : self.text.closed);
      } else if (self.phase === "open") {
        var ok = buyable === null ? !btn.disabled : buyable;
        if (ok) {
          if (btn.disabled) btn.disabled = false;
          btn.removeAttribute("aria-disabled");
          self.setButtonText(btn, self.text.open);
        }
      }
    });
    this.setSoldOut(soldOut);
  };

  Countdown.prototype.setSoldOut = function (soldOut) {
    if (soldOut === this.soldOut) return;
    this.soldOut = soldOut;
    this.render();
    broadcast(this);
  };

  // Which parts of the block show
  Countdown.prototype.render = function () {
    var showPanel = this.phase === "scheduled";
    var notifyFor = this.phase === "scheduled" ? "scheduled" : this.phase === "closed" ? "closed" : this.soldOut ? "soldOut" : null;
    if (this.panel) this.panel.hidden = !showPanel;
    if (this.notify) {
      this.notify.hidden = !notifyFor || !this.productId;
      var title = this.notify.querySelector("[data-ohpc-notify-title]");
      if (title && notifyFor) {
        title.textContent =
          notifyFor === "scheduled" ? this.text.notifyScheduled : notifyFor === "closed" ? this.text.notifyClosed : this.text.notifySoldOut;
      }
    }
    this.el.hidden = !showPanel && !notifyFor;
  };

  Countdown.prototype.watch = function () {
    if (this.observer || !window.MutationObserver) return;
    var self = this;
    var queued = false;
    this.observer = new MutationObserver(function (records) {
      // Ignore changes inside our own block
      var outside = records.some(function (r) {
        return !self.el.contains(r.target);
      });
      if (!outside || queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        self.enforceButtons();
      });
    });
    this.observer.observe(this.root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["disabled", "value"] });
    this.root.addEventListener("change", function () {
      setTimeout(function () {
        self.enforceButtons();
      }, 0);
    });
  };

  // Fresh availability from the store (the page may be older than the last
  // change: opened, sold out or restocked since it loaded)
  Countdown.prototype.refreshAvailability = function (attempt) {
    var self = this;
    attempt = attempt || 0;
    if (!this.handle || !window.fetch) return;
    fetch(root + "products/" + this.handle + ".js", { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (p) {
        if (!p || !p.variants) return;
        var map = {};
        var any = false;
        p.variants.forEach(function (v) {
          map[String(v.id)] = Boolean(v.available);
          any = any || v.available;
        });
        self.available = map;
        self.enforceButtons();
        // Just opened: selling may take a few seconds to switch on
        if (!any && attempt < 20 && self.phase === "open" && self.justOpened) {
          setTimeout(function () {
            self.refreshAvailability(attempt + 1);
          }, 3000);
        }
      })
      .catch(function () {});
  };

  Countdown.prototype.apply = function (phase, first) {
    var r = this.root;
    r.classList.toggle("ohpc-locked", phase === "scheduled");
    r.classList.toggle("ohpc-closed", phase === "closed");
    if (phase === "open") {
      if (!first) r.classList.add("ohpc-reveal");
      this.justOpened = !first;
      this.refreshAvailability(0);
    }
    if (phase !== "scheduled") {
      clearInterval(this.timer);
      // Still need to notice closing later on
      if (phase === "open" && this.closes) this.timer = setInterval(this.tick, 1000);
    }
    this.render();
    this.enforceButtons();
    if (phase !== "scheduled") this.watch();
    broadcast(this);
  };

  // ---------------------------------------------------------------------------
  // Sign-up form
  // ---------------------------------------------------------------------------

  Countdown.prototype.setupForm = function () {
    var form = this.el.querySelector("[data-ohpc-form]");
    if (!form || !this.productId) return;
    var msg = this.el.querySelector("[data-ohpc-msg]");
    var self = this;
    var key = "ohpc_signed_" + this.productId;
    if (store(key)) {
      form.hidden = true;
      if (msg) msg.textContent = this.text.thanks;
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = form.querySelector('[name="email"]');
      var hp = form.querySelector('[name="website"]');
      var btn = form.querySelector('[type="submit"]');
      if (!email || !email.value || (email.checkValidity && !email.checkValidity())) {
        if (msg) msg.textContent = "Please enter a valid email address.";
        if (email) email.focus();
        return;
      }
      if (btn) btn.disabled = true;
      if (msg) msg.textContent = "";
      fetch(root + "apps/purchase-history/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ productId: self.productId, email: email.value, website: hp ? hp.value : "" }),
      })
        .then(function (r) {
          return r.json().catch(function () {
            return { ok: false };
          });
        })
        .then(function (d) {
          if (d && d.ok) {
            store(key, "1");
            form.hidden = true;
            if (msg) msg.textContent = self.text.thanks;
          } else {
            if (msg) msg.textContent = (d && d.error) || OOPS;
            if (btn) btn.disabled = false;
          }
        })
        .catch(function () {
          if (msg) msg.textContent = OOPS;
          if (btn) btn.disabled = false;
        });
    });
  };

  // ---------------------------------------------------------------------------
  // Tell the closing clock (its own script) what this block knows
  // ---------------------------------------------------------------------------

  function broadcast(cd) {
    if (!cd.productId) return;
    var all = (window.OHPC_STATE = window.OHPC_STATE || {});
    all[cd.productId] = { phase: cd.phase, soldOut: cd.soldOut };
    document.dispatchEvent(new CustomEvent("ohpc:state", { detail: { productId: cd.productId } }));
  }

  // ---------------------------------------------------------------------------
  // Arriving from a notification email: tag the cart so the order can be
  // credited to the email
  // ---------------------------------------------------------------------------

  function rememberRef() {
    var token = null;
    try {
      token = new URL(window.location.href).searchParams.get("oh_ref");
    } catch (e) {
      return;
    }
    var saved = null;
    try {
      saved = JSON.parse(store("ohpc_ref") || "null");
    } catch (e) {
      saved = null;
    }
    if (token) {
      saved = { t: token, at: Date.now() };
      store("ohpc_ref", JSON.stringify(saved));
    }
    if (!saved || Date.now() - saved.at > REF_DAYS * 86400000 || !window.fetch) return;
    if (saved.sent === saved.t) return;
    fetch(root + "cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ attributes: { _oh_ref: saved.t } }),
    })
      .then(function (r) {
        if (r.ok) {
          saved.sent = saved.t;
          store("ohpc_ref", JSON.stringify(saved));
        }
      })
      .catch(function () {});
  }

  // ---------------------------------------------------------------------------
  // Start-up (and the theme editor, which reloads sections in place)
  // ---------------------------------------------------------------------------

  function init(scope) {
    var s = scope || document;
    var els = s.querySelectorAll("[data-ohpc]");
    for (var i = 0; i < els.length; i++) if (!els[i]._ohpc) els[i]._ohpc = new Countdown(els[i]);
  }

  function start() {
    init();
    rememberRef();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  document.addEventListener("shopify:section:load", function (e) {
    init(e.target);
  });
  document.addEventListener("shopify:section:unload", function (e) {
    var els = e.target.querySelectorAll("[data-ohpc]");
    for (var i = 0; i < els.length; i++) {
      var c = els[i]._ohpc;
      if (!c) continue;
      clearInterval(c.timer);
      if (c.observer) c.observer.disconnect();
      if (c.root) c.root.classList.remove("ohpc-locked", "ohpc-closed", "ohpc-reveal", "ohpc-soldout");
    }
  });

  window.OHPreorderCountdown = { init: init };
})();
