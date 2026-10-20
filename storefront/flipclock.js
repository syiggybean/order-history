/* Flip clock shared by the two pre-order blocks (order-history app).
 * Source file: edit here, then run `npm run build:storefront`, which writes the
 * minified copies into extensions/preorder-countdown/assets/.
 */
var FLIP_MS = 560;
var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function pad(n) {
  return n < 10 ? "0" + n : String(n);
}
// ---------------------------------------------------------------------------
// Flip clock
// ---------------------------------------------------------------------------

function makeDigit(ch) {
  var d = document.createElement("span");
  d.className = "ohpc-d";
  ["top", "bottom", "flap-top", "flap-bottom"].forEach(function (part) {
    var half = document.createElement("span");
    half.className = "ohpc-d__" + part;
    var i = document.createElement("i");
    i.textContent = ch;
    half.appendChild(i);
    d.appendChild(half);
  });
  d._value = ch;
  return d;
}

function setText(d, part, ch) {
  d.querySelector(".ohpc-d__" + part + " > i").textContent = ch;
}

function flipTo(d, ch) {
  if (d._value === ch) return;
  var old = d._value;
  d._value = ch;
  if (reduceMotion) {
    ["top", "bottom", "flap-top", "flap-bottom"].forEach(function (p) {
      setText(d, p, ch);
    });
    return;
  }
  setText(d, "top", ch); // new top waits behind the falling flap
  setText(d, "bottom", old); // old bottom stays until the new one lands
  setText(d, "flap-top", old);
  setText(d, "flap-bottom", ch);
  d.classList.remove("is-flipping");
  void d.offsetWidth; // restart the animation
  d.classList.add("is-flipping");
  clearTimeout(d._done);
  d._done = setTimeout(function () {
    setText(d, "bottom", ch);
    setText(d, "flap-top", ch);
    d.classList.remove("is-flipping");
  }, FLIP_MS);
}

function setUnit(unitEl, text) {
  if (!unitEl) return;
  var box = unitEl.querySelector(".ohpc__digits");
  var digits = box.children;
  // First draw, or days growing/shrinking a digit: build without flipping
  if (digits.length !== text.length) {
    box.textContent = "";
    for (var j = 0; j < text.length; j++) box.appendChild(makeDigit(text.charAt(j)));
    return;
  }
  for (var i = 0; i < text.length; i++) flipTo(digits[i], text.charAt(i));
}

export function Clock(el, srSuffix) {
  this.units = {};
  var self = this;
  ["days", "hours", "minutes", "seconds"].forEach(function (u) {
    self.units[u] = el.querySelector('[data-unit="' + u + '"]');
  });
  this.sr = el.querySelector("[data-ohpc-sr]");
  this.srSuffix = srSuffix;
}

Clock.prototype.draw = function (ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  var days = Math.floor(s / 86400);
  var hours = Math.floor((s % 86400) / 3600);
  var minutes = Math.floor((s % 3600) / 60);
  var seconds = s % 60;
  setUnit(this.units.days, pad(days));
  setUnit(this.units.hours, pad(hours));
  setUnit(this.units.minutes, pad(minutes));
  setUnit(this.units.seconds, pad(seconds));
  // Screen readers: announce once a minute, not every second
  if (this.sr && (seconds === 59 || !this.sr.textContent)) {
    this.sr.textContent = days + " days, " + hours + " hours and " + minutes + " minutes " + this.srSuffix;
  }
};

export function phaseAt(opens, closes, now) {
  if (closes && now >= closes) return "closed";
  if (opens && now < opens) return "scheduled";
  return "open";
}
