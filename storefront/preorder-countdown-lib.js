// Shared by the pre-order countdown block, as window.OHPCLib: the flip clock, hiding
// other apps' back in stock buttons, and remembering a referral. A separate file
// from preorder-countdown.js to keep each under Shopify's 10 KB app block limit.
import { Clock, phaseAt } from "./flipclock.js";

var REF_DAYS = 14;
var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
var OTHER_NOTIFY =
  '#BIS_trigger, .BIS_trigger, [data-bis-trigger], .klaviyo-bis-trigger, [class*="klaviyo-bis"], .swym-button-bis, [class*="back-in-stock"], [id*="back-in-stock"], [class*="restock-alert"], [class*="notify-me-button"], [id*="notify-me-button"], .product-form__notify, [class*="appikon"]';
var OTHER_NOTIFY_TEXT = /^\s*(e-?mail me when (it'?s )?(available|back( in stock)?)|notify me when (it'?s )?(available|back( in stock)?)|get notified when (it'?s )?(available|back( in stock)?))\s*$/i;

function store(key, value) {
  try {
    if (value === undefined) return window.localStorage.getItem(key);
    window.localStorage.setItem(key, value);
  } catch (e) {
    return null;
  }
}

// Hides other apps' "email me when available" buttons while the countdown's own
// sign-up shows (before opening, after closing, sold out)
function hideOtherNotify(cd) {
  var self = cd;
  var on = cd.phase === "scheduled" || cd.phase === "closed" || cd.soldOut;
  var found = [];
  var add = function (list) {
    for (var i = 0; i < list.length; i++) if (!self.el.contains(list[i]) && found.indexOf(list[i]) < 0) found.push(list[i]);
  };
  try {
    add(document.querySelectorAll(OTHER_NOTIFY + (cd.otherSelector ? ", " + cd.otherSelector : "")));
  } catch (e) {
    add(document.querySelectorAll(OTHER_NOTIFY)); // a bad custom selector
  }
  // By wording, for apps not listed above (only in this product section)
  var buttons = cd.root.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
  for (var i = 0; i < buttons.length; i++) {
    var b = buttons[i];
    var text = b.tagName === "INPUT" ? b.value : b.textContent;
    if (OTHER_NOTIFY_TEXT.test(text || "")) add([b]);
  }
  found.forEach(function (n) {
    n.classList.toggle("ohpc-hidden-notify", on);
  });
  // Put back anything hidden earlier that no longer matches
  if (!on) {
    var hidden = document.querySelectorAll(".ohpc-hidden-notify");
    for (var j = 0; j < hidden.length; j++) hidden[j].classList.remove("ohpc-hidden-notify");
  }
}

// A referral link (?oh_ref=) is remembered for a while and put on the cart
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

window.OHPCLib = window.OHPCLib || { Clock: Clock, phaseAt: phaseAt, hideOtherNotify: hideOtherNotify, rememberRef: rememberRef };
