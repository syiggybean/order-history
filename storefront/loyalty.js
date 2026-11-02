/* Rewards (MonkeyBean loyalty)
 * Loaded by the "Rewards" app embed, only for logged-in customers. Members
 * (invite-only) get a Yiggybeans button next to the account icon that opens a
 * rewards flyout (balance, tier progress, rewards to redeem, link to the
 * Rewards page) and an "Earn X Yiggybeans" line under product prices.
 * For members, Smile.io's floating button and panel are hidden and links to
 * Smile's panel open the Yiggybeans flyout instead. Nobody else sees anything,
 * and Smile works as usual for them.
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
  // Classic accounts link to /account; new customer accounts to shopify.com/…/account
  // or /customer_authentication/…
  var ACCOUNT =
    "a.header__icon--account,.site-nav__link--icon[href*='account'],.site-nav__link--icon[href*='customer_authentication'],header a[href*='/account'],.site-header a[href*='/account'],header a[href*='customer_authentication'],.site-header a[href*='customer_authentication'],a[href*='customer_authentication'],a[href$='/account']";
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
    if (!acct && cfg.accountUrl) {
      var all = document.querySelectorAll("a[href]");
      for (var i = 0; i < all.length && !acct; i++) if (all[i].getAttribute("href") === cfg.accountUrl) acct = all[i];
    }
    // Last resort: next to the wishlist heart or the cart
    if (!acct) acct = first(".ohwl-hdr") || first("header a[href$='/cart'],.site-header a[href$='/cart'],a[href$='/cart']");
    if (!acct) return;
    var a = document.createElement("button");
    a.type = "button";
    a.className = "ohlp-badge";
    a.title = fmt(me.points) + " " + unit(me.points);
    a.setAttribute("aria-label", me.programName + ": " + fmt(me.points) + " " + unit(me.points) + ". Open rewards");
    a.setAttribute("aria-haspopup", "dialog");
    a.innerHTML = STAR + "<span>" + fmt(me.points) + "</span>";
    a.addEventListener("click", function () {
      openPanel(a);
    });
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

  // Members: Smile's floating button and panel are hidden (CSS keyed on this class)
  function memberMode(on) {
    if (cfg.replaceSmile) document.documentElement.classList.toggle("ohlp-member", Boolean(on));
  }

  function show() {
    if (!me || !me.member) return;
    memberMode(true);
    badge();
    earnLine();
  }

  // ---------------------------------------------------------------------------
  // Rewards flyout
  // ---------------------------------------------------------------------------

  var panel = null;
  var opener = null;
  var data = null;

  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "on") for (var ev in attrs.on) n.addEventListener(ev, attrs.on[ev]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) {
      if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }
  var money = function (n) {
    return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
  };

  function onKey(e) {
    if (e.key === "Escape") closePanel();
    if (e.key === "Tab" && panel) {
      // Keep focus inside the flyout
      var f = panel.querySelectorAll("button, a[href], input");
      if (!f.length) return;
      var firstF = f[0];
      var lastF = f[f.length - 1];
      if (e.shiftKey && document.activeElement === firstF) {
        e.preventDefault();
        lastF.focus();
      } else if (!e.shiftKey && document.activeElement === lastF) {
        e.preventDefault();
        firstF.focus();
      }
    }
  }

  function openPanel(from) {
    if (panel) return;
    opener = from || document.activeElement;
    var body = h("div", { class: "ohlp-fly__body" }, [h("p", { class: "ohlp-fly__muted", text: "Loading…" })]);
    var close = h("button", { type: "button", class: "ohlp-fly__close", "aria-label": "Close", on: { click: closePanel } }, ["×"]);
    var box = h("div", { class: "ohlp-fly", role: "dialog", "aria-modal": "true", "aria-label": (me && me.programName) || "Rewards" }, [
      h("div", { class: "ohlp-fly__head" }, [h("strong", { text: (me && me.programName) || "Rewards" }), close]),
      body,
    ]);
    panel = h("div", { class: "ohlp-fly-wrap", on: { click: function (e) { if (e.target === panel) closePanel(); } } }, [box]);
    document.body.appendChild(panel);
    document.documentElement.classList.add("ohlp-fly-open");
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(function () {
      if (panel) panel.classList.add("is-open");
    });
    close.focus();
    load(body);
  }

  function closePanel() {
    if (!panel) return;
    var p = panel;
    panel = null;
    p.classList.remove("is-open");
    document.documentElement.classList.remove("ohlp-fly-open");
    document.removeEventListener("keydown", onKey);
    setTimeout(function () {
      p.remove();
    }, 220);
    if (opener && opener.focus) opener.focus();
  }

  function load(body) {
    fetch(cfg.base + "/rewards/panel", { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.member) {
          body.replaceChildren(h("p", { class: "ohlp-fly__muted", text: "Rewards aren't available right now." }), pageLink());
          return;
        }
        data = j;
        render(body);
      })
      .catch(function () {
        body.replaceChildren(h("p", { class: "ohlp-fly__muted", text: "Couldn't load your rewards. Please try again." }), pageLink());
      });
  }

  function pageLink() {
    return h("a", { class: "ohlp-fly__page", href: page }, ["See all rewards, history and ways to earn →"]);
  }

  function setPoints(n) {
    data.points = n;
    if (me) me.points = n;
    var b = document.querySelector(".ohlp-badge span");
    if (b) b.textContent = fmt(n);
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), me: me }));
    } catch (e) {
      // storage blocked
    }
  }

  // result: a "here's your code" box to show at the top (that code isn't listed again below)
  function render(body, result, justCode) {
    var d = data;
    var u = function (n) {
      return Number(n) === 1 ? d.pointName || "point" : d.pointsName || "points";
    };
    var kids = [];
    // Balance
    kids.push(
      h("div", { class: "ohlp-fly__balance" }, [
        h("span", { class: "ohlp-fly__muted", text: d.firstName ? "Hi " + d.firstName + ", you have" : "You have" }),
        h("span", { class: "ohlp-fly__points" }, [fmt(d.points)]),
        h("span", { text: u(d.points) }),
        d.pending ? h("span", { class: "ohlp-fly__muted", text: fmt(d.pending) + " more on the way (from recent orders)" }) : null,
      ]),
    );
    // A code just made
    if (result) kids.push(result);
    // Tier progress
    kids.push(
      h("div", { class: "ohlp-fly__tier" }, [
        h("div", { class: "ohlp-fly__row" }, [h("strong", { text: d.tier.name + " member" }), d.next ? h("span", { class: "ohlp-fly__muted", text: d.next.name }) : null]),
        h("div", { class: "ohlp-fly__bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(d.progress * 100)), "aria-label": d.next ? "Progress to " + d.next.name : "Top tier" }, [
          h("span", { style: "width:" + Math.round(d.progress * 100) + "%" }),
        ]),
        h("p", { class: "ohlp-fly__muted", text: d.next ? "Spend " + money(d.next.toGo) + " more to reach " + d.next.name + (d.next.perks ? ": " + d.next.perks : "") : "You're at the top tier" + (d.tier.perks ? ": " + d.tier.perks : "") }),
      ]),
    );
    // Rewards
    kids.push(h("h3", { class: "ohlp-fly__h", text: "Choose a reward" }));
    var list = h("ul", { class: "ohlp-fly__rewards" });
    d.rewards.forEach(function (r) {
      var short = r.points - d.points;
      var btn = h("button", { type: "button", class: "ohlp-fly__redeem", disabled: short > 0 ? "disabled" : null }, [short > 0 ? fmt(short) + " more" : "Redeem"]);
      btn.addEventListener("click", function () {
        redeemReward(r, btn, body);
      });
      list.appendChild(
        h("li", {}, [
          h("span", {}, [h("strong", { text: r.name }), h("span", { class: "ohlp-fly__muted", text: fmt(r.points) + " " + u(r.points) + (r.minSubtotal ? " · orders over " + money(r.minSubtotal) : "") })]),
          btn,
        ]),
      );
    });
    kids.push(list);
    // Unused codes
    var older = (d.codes || []).filter(function (c) {
      return c.code !== justCode;
    });
    if (older.length) {
      kids.push(h("h3", { class: "ohlp-fly__h", text: "Your codes" }));
      older.forEach(function (c) {
        kids.push(codeBox(c.code, c.name));
      });
    }
    kids.push(pageLink());
    body.replaceChildren.apply(body, kids);
  }

  function codeBox(code, name) {
    var copy = h("button", { type: "button", class: "ohlp-fly__copy" }, ["Copy"]);
    copy.addEventListener("click", function () {
      try {
        navigator.clipboard.writeText(code).then(function () {
          copy.textContent = "Copied";
        });
      } catch (e) {
        copy.textContent = code;
      }
    });
    return h("div", { class: "ohlp-fly__code" }, [
      h("span", {}, [h("code", { text: code }), h("span", { class: "ohlp-fly__muted", text: name })]),
      h("span", { class: "ohlp-fly__code-actions" }, [copy, h("a", { href: "/discount/" + encodeURIComponent(code) + "?redirect=/cart" }, ["Apply to cart"])]),
    ]);
  }

  function redeemReward(r, btn, body) {
    btn.disabled = true;
    btn.textContent = "…";
    fetch(cfg.base + "/rewards/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ rewardId: r.id }),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || "Something went wrong. Please try again.");
        setPoints(j.points);
        data.codes = [{ code: j.code, name: j.rewardName }].concat(data.codes || []).slice(0, 5);
        render(
          body,
          h("div", { class: "ohlp-fly__done", role: "status" }, [h("strong", { text: "Here's your code for " + j.rewardName + ":" }), codeBox(j.code, "Use it at checkout. It doesn't expire.")]),
          j.code,
        );
      })
      .catch(function (e) {
        btn.disabled = false;
        btn.textContent = "Redeem";
        var err = body.querySelector(".ohlp-fly__error") || h("p", { class: "ohlp-fly__error", role: "alert" });
        err.textContent = e.message;
        btn.closest("li").after(err);
      });
  }

  // Links meant for Smile's panel (e.g. #smile-home) open the Yiggybeans flyout for members
  document.addEventListener(
    "click",
    function (e) {
      if (!cfg.replaceSmile || !me || !me.member) return;
      var a = e.target.closest && e.target.closest("a[href*='#smile'],[data-smile-open],[data-smile-action]");
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      openPanel(a);
    },
    true,
  );

  // A recent answer shows straight away; the fresh one replaces it
  try {
    var cached = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
      me = cached.me;
      show();
    } else if (cached && cached.me && cached.me.member) {
      // Probably still a member: hide Smile's button now rather than flash it
      memberMode(true);
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
        memberMode(false);
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
