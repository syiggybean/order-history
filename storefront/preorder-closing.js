/* Pre-order closing clock (order-history app)
 * The "Pre-order closing clock" block [data-ohpc-closing], under the buy
 * buttons: counts down to the closing time while pre-orders are open, and
 * hides when the main block reports the product as sold out.
 * Source file: edit here, then run `npm run build:storefront`.
 */
import { Clock, phaseAt } from "./flipclock.js";

(function () {
  "use strict";

  var blocks = [];

  function Closing(el) {
    this.el = el;
    this.opens = Number(el.getAttribute("data-opens")) * 1000 || null;
    this.closes = Number(el.getAttribute("data-closes")) * 1000 || null;
    this.productId = el.getAttribute("data-product-id");
    this.clock = new Clock(el, "until pre-orders close");
    this.tick = this.tick.bind(this);
    blocks.push(this);
    this.tick();
    this.timer = setInterval(this.tick, 250);
  }

  Closing.prototype.tick = function () {
    var now = Date.now();
    var phase = phaseAt(this.opens, this.closes, now);
    var s = (window.OHPC_STATE || {})[this.productId];
    var show = Boolean(this.closes) && phase === "open" && !(s && s.soldOut);
    if (this.el.hidden === show) this.el.hidden = !show;
    if (show) this.clock.draw(this.closes - now);
    if (phase === "closed") clearInterval(this.timer);
  };

  // The main block says when a product sells out (or comes back)
  document.addEventListener("ohpc:state", function (e) {
    blocks.forEach(function (c) {
      if (c.productId === e.detail.productId) c.tick();
    });
  });

  function init(scope) {
    var els = (scope || document).querySelectorAll("[data-ohpc-closing]");
    for (var i = 0; i < els.length; i++) if (!els[i]._ohpc) els[i]._ohpc = new Closing(els[i]);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { init(); });
  else init();

  document.addEventListener("shopify:section:load", function (e) {
    init(e.target);
  });
  document.addEventListener("shopify:section:unload", function (e) {
    var els = e.target.querySelectorAll("[data-ohpc-closing]");
    for (var i = 0; i < els.length; i++) {
      var c = els[i]._ohpc;
      if (!c) continue;
      clearInterval(c.timer);
      blocks = blocks.filter(function (x) {
        return x !== c;
      });
    }
  });
})();
