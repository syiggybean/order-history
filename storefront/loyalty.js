/* Rewards (MonkeyBean loyalty)
 * Loaded by the "Rewards" app embed, only for logged-in customers. Members
 * (invite-only) get a Yiggybeans badge next to the account icon and an
 * "Earn X Yiggybeans" line under product prices. Nobody else sees anything.
 * Source file: edit here, then run `npm run build:storefront`.
 */
(function () {
  var el = document.getElementById("ohlp-config");
  if (!el || window.__ohlp) return;
  window.__ohlp = true;
  var cfg;
  try {
    cfg = JSON.parse(el.textContent);
  } catch (e) {
    return;
  }
  var KEY = "ohlp:v1:" + cfg.customer;
  var page = cfg.base + "/rewards";
  var STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z"/></svg>';
  var ACCOUNT = "a.header__icon--account,header a[href$='/account'],header a[href*='/account/login'],.site-header a[href$='/account'],.site-nav a[href$='/account'],a[href$='/account']";
  var PRICE =
    ".product__info-container .price,.product-single__meta .product-single__prices,.product-single__prices,.product__price,.product-block--price,.product-info__price,.price-list,.product .price";
  var me = null;

  var first = function (sel) {
    try {
      return document.querySelector(sel);
    } catch (e) {
      return null;
    }
  };
  var fmt = function (n) {
    return Number(n).toLocaleString("en-US");
  };
  var unit = function (n) {
    return Number(n) === 1 ? me.pointName || "point" : me.pointsName || "points";
  };

  function badge() {
    if (!cfg.header || document.querySelector(".ohlp-badge")) return;
    var acct = first(cfg.accountSel || ACCOUNT);
    if (!acct) return;
    var a = document.createElement("a");
    a.className = "ohlp-badge";
    a.href = page;
    a.title = fmt(me.points) + " " + unit(me.points);
    a.setAttribute("aria-label", me.programName + ": " + fmt(me.points) + " " + unit(me.points));
    a.innerHTML = STAR + "<span>" + fmt(me.points) + "</span>";
    acct.parentNode.insertBefore(a, acct.nextSibling);
  }

  var lastVariant = null;
  function earnLine() {
    if (!cfg.earn || !cfg.product) return;
    var v = new URLSearchParams(location.search).get("variant") || String(cfg.product.variant);
    if (v === lastVariant && document.querySelector(".ohlp-earn")) return;
    lastVariant = v;
    var cents = cfg.product.prices[v];
    if (cents == null) cents = cfg.product.prices[String(cfg.product.variant)];
    if (cents == null) return;
    var pts = Math.floor((cents / 100) * me.rate + 1e-9);
    var line = document.querySelector(".ohlp-earn");
    if (!line) {
      var price = first(cfg.priceSel || PRICE);
      if (!price) return;
      line = document.createElement("p");
      line.className = "ohlp-earn";
      price.parentNode.insertBefore(line, price.nextSibling);
    }
    var esc = function (t) {
      return String(t).replace(/[&<>"]/g, function (c) {
        return "&#" + c.charCodeAt(0) + ";";
      });
    };
    line.innerHTML = pts > 0 ? STAR + "<span>Earn <b>" + fmt(pts) + "</b> " + esc(unit(pts)) + ' · <a href="' + page + '">' + fmt(me.points) + " to spend</a></span>" : "";
  }

  function show() {
    if (!me || !me.member) return;
    badge();
    earnLine();
  }

  // A recent answer shows straight away; the fresh one replaces it
  try {
    var cached = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
      me = cached.me;
      show();
    }
  } catch (e) {
    // nothing cached
  }
  fetch(cfg.base + "/rewards/me", { headers: { Accept: "application/json" }, credentials: "same-origin" })
    .then(function (r) {
      return r.json();
    })
    .then(function (j) {
      me = j;
      try {
        sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), me: j }));
      } catch (e) {
        // storage blocked
      }
      if (!j.member) {
        var b = document.querySelector(".ohlp-badge");
        if (b) b.remove();
        var l = document.querySelector(".ohlp-earn");
        if (l) l.remove();
        return;
      }
      var b2 = document.querySelector(".ohlp-badge span");
      if (b2) b2.textContent = fmt(j.points);
      lastVariant = null;
      show();
    })
    .catch(function () {});
  // Variant picked (themes change ?variant= in the address); header redrawn
  setInterval(function () {
    if (me && me.member) show();
  }, 700);
})();
