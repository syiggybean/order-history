// The storefront Rewards page, returned through the app proxy as Liquid so it
// sits inside the store's theme. Members only; everyone else gets a short note.

import { escLiquid } from "./wishlist-page.server";
import { money } from "./loyalty.server";

const e = escLiquid;
const n = (x) => Number(x).toLocaleString("en-US");
// In the store's time zone
const date = (iso) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" });
const bday = (mmdd) => {
  const [m, d] = mmdd.split("-").map(Number);
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${d}`;
};

const STAR = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z"/></svg>`;

const STYLE = `<style>
.ohlp{max-width:var(--page-width,110rem);margin:0 auto;padding:32px 20px 64px;box-sizing:border-box}
.ohlp *{box-sizing:border-box}
.ohlp h1{margin:0 0 18px}
.ohlp h2{margin:0 0 12px;font-size:1.25em}
.ohlp-card{border:1px solid rgba(var(--color-foreground,18,18,18),.12);border-radius:14px;padding:20px;margin-bottom:20px;background:rgb(var(--color-background,255,255,255))}
.ohlp-hero{display:grid;gap:16px;grid-template-columns:1fr;margin-bottom:20px}
.ohlp-hero .ohlp-card{margin-bottom:0}
@media(min-width:750px){.ohlp-hero{grid-template-columns:1.2fr 1fr}}
.ohlp-bal{display:flex;align-items:center;gap:14px}
.ohlp-bal svg{color:var(--ohlp-accent,#e0245e);width:40px;height:40px}
.ohlp-big{font-size:2.6em;font-weight:800;line-height:1}
.ohlp-muted{opacity:.7;font-size:.9em}
.ohlp-tier{display:inline-block;padding:3px 12px;border-radius:999px;background:var(--ohlp-accent,#e0245e);color:#fff;font-weight:700;font-size:.85em;letter-spacing:.04em;text-transform:uppercase}
.ohlp-bar{height:10px;border-radius:5px;background:rgba(var(--color-foreground,18,18,18),.1);overflow:hidden;margin:10px 0 6px}
.ohlp-bar>span{display:block;height:100%;background:var(--ohlp-accent,#e0245e)}
.ohlp-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}
.ohlp-reward{border:1px solid rgba(var(--color-foreground,18,18,18),.12);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:6px}
.ohlp-reward strong{font-size:1.15em}
.ohlp-btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 18px;border-radius:999px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;font-size:.95em;cursor:pointer;text-decoration:none}
.ohlp-btn--solid{background:rgb(var(--color-button,18,18,18));color:rgb(var(--color-button-text,255,255,255));border-color:transparent}
.ohlp-btn[disabled]{opacity:.45;cursor:not-allowed}
.ohlp-code{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:12px 0;border-top:1px solid rgba(var(--color-foreground,18,18,18),.1)}
.ohlp-code:first-of-type{border-top:0}
.ohlp-code code{font-size:1.1em;font-weight:700;letter-spacing:.06em;padding:4px 10px;border-radius:8px;background:rgba(var(--color-foreground,18,18,18),.06)}
.ohlp-ways{list-style:none;margin:0;padding:0}
.ohlp-ways li{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid rgba(var(--color-foreground,18,18,18),.1)}
.ohlp-ways li:first-child{border-top:0}
.ohlp-pts{font-weight:700;white-space:nowrap}
.ohlp-done{opacity:.6;font-weight:600}
.ohlp-hist{width:100%;border-collapse:collapse}
.ohlp-hist td{padding:9px 6px;border-top:1px solid rgba(var(--color-foreground,18,18,18),.1);vertical-align:top}
.ohlp-hist td:last-child{text-align:right;font-weight:700;white-space:nowrap}
.ohlp-plus{color:#1a7f37}.ohlp-minus{opacity:.75}
.ohlp-pend{font-size:.75em;font-weight:600;padding:1px 8px;border-radius:999px;background:rgba(var(--color-foreground,18,18,18),.08);margin-left:6px}
.ohlp-msg{font-size:.9em;margin-top:6px}
.ohlp-new{border:2px solid var(--ohlp-accent,#e0245e);border-radius:12px;padding:14px 16px;margin-bottom:20px}
.ohlp-tiers{width:100%;border-collapse:collapse;font-size:.95em}
.ohlp-tiers td,.ohlp-tiers th{padding:8px 6px;text-align:left;border-top:1px solid rgba(var(--color-foreground,18,18,18),.1)}
.ohlp-tiers tr.is-me td{font-weight:700}
.ohlp select{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid rgba(var(--color-foreground,18,18,18),.3);background:transparent;color:inherit}
</style>`;

const login = (path) => `<a class="ohlp-btn ohlp-btn--solid" href="{{ routes.account_login_url }}?return_url={{ '${path}' | url_encode }}">Log in</a>`;

export function renderRewardsPage({ mode, view = null, joined = false, joinError = null, path = "/apps/purchase-history/rewards" }) {
  const top = `${STYLE}`;
  if (mode === "login")
    return `${top}<div class="ohlp"><div class="ohlp-card" style="text-align:center;max-width:520px;margin:20px auto"><h1>Rewards</h1><p>Log in to see your Yiggybeans and rewards.</p>${login(path)}</div></div>`;
  if (mode === "closed")
    return `${top}<div class="ohlp"><div class="ohlp-card" style="text-align:center;max-width:560px;margin:20px auto"><h1>Rewards</h1><p>${
      joinError === "full"
        ? "This invitation has already been used by everyone it was meant for."
        : joinError === "invalid"
          ? "This invitation link isn't active anymore."
          : "Our new rewards program is invite-only for now. Keep an eye on your inbox!"
    }</p><a class="ohlp-btn" href="{{ routes.root_url }}">Keep shopping</a></div></div>`;

  const { program, member, tier, next, history, codes, socials } = view;
  const cur = program.currency;
  const name = e(program.programName);
  const pct = next ? Math.min(100, Math.round((member.tierSpend / next.threshold) * 100)) : 100;
  const perDollar = Math.round(program.rate * 100) / 100;
  const P = e(program.pointsName);
  const one = e(program.pointName);
  const unit = (x) => (Number(x) === 1 ? one : P);

  const rewards = program.rewards
    .map((r) => {
      const short = Math.max(0, r.points - member.points);
      return `<div class="ohlp-reward"><strong>${e(r.name)}</strong><span class="ohlp-muted">${n(r.points)} ${unit(r.points)}${r.minSubtotal ? ` · orders over ${e(money(r.minSubtotal, cur))}` : ""}</span>
<button type="button" class="ohlp-btn ohlp-btn--solid" data-ohlp-redeem="${e(r.id)}" data-ohlp-label="${e(r.name)}"${short ? " disabled" : ""}>${short ? `${n(short)} more ${unit(short)}` : "Redeem"}</button>
<div class="ohlp-msg" role="status"></div></div>`;
    })
    .join("");

  const codeRows = codes.length
    ? codes
        .map((c) => {
          const state =
            c.status === "used"
              ? `<span class="ohlp-done">Used${c.usedOn ? ` on ${e(c.usedOn)}` : ""}</span>`
              : c.status === "expired"
                ? `<span class="ohlp-done">Expired</span>`
                : `<span class="ohlp-muted">Never expires${c.minSubtotal ? ` · orders over ${e(money(c.minSubtotal, cur))}` : ""}</span>
<button type="button" class="ohlp-btn" data-ohlp-copy="${e(c.code)}">Copy</button>
<a class="ohlp-btn ohlp-btn--solid" href="/discount/${encodeURIComponent(c.code)}?redirect=%2Fcart">Use now</a>`;
          return `<div class="ohlp-code"><code>${e(c.code)}</code><span>${e(c.name)}</span>${state}</div>`;
        })
        .join("")
    : `<p class="ohlp-muted">Codes you redeem show up here.</p>`;

  const birthdayRow =
    program.birthdayBonus > 0
      ? member.birthday
        ? `<li><span>Birthday bonus · ${e(bday(member.birthday))}</span><span class="ohlp-pts">${n(program.birthdayBonus)} ${unit(program.birthdayBonus)}</span></li>`
        : `<li><span>Tell us your birthday and get a treat every year</span><form data-ohlp-bday style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
<select name="m" aria-label="Month"><option value="">Month</option>${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((mn, i) => `<option value="${String(i + 1).padStart(2, "0")}">${mn}</option>`).join("")}</select>
<select name="d" aria-label="Day"><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => `<option value="${String(i + 1).padStart(2, "0")}">${i + 1}</option>`).join("")}</select>
<button class="ohlp-btn ohlp-btn--solid" type="submit">Save · ${n(program.birthdayBonus)} ${unit(program.birthdayBonus)}</button><span class="ohlp-msg" role="status"></span></form></li>`
      : "";
  const socialRows = socials
    .map((s) =>
      s.done
        ? `<li><span>${e(s.label)}</span><span class="ohlp-done">✓ ${n(s.points)} ${unit(s.points)} earned</span></li>`
        : `<li><span>${e(s.label)}</span><span style="display:flex;gap:10px;align-items:center"><span class="ohlp-pts">${n(s.points)} ${unit(s.points)}</span><a class="ohlp-btn" href="${e(s.url)}" target="_blank" rel="noopener" data-ohlp-social="${e(s.id)}">Follow</a></span></li>`,
    )
    .join("");

  const hist = history.length
    ? `<table class="ohlp-hist"><tbody>${history
        .map(
          (h) =>
            `<tr><td class="ohlp-muted" style="white-space:nowrap">${date(h.at)}</td><td>${e(h.text)}${h.pending ? `<span class="ohlp-pend">Pending</span>` : ""}</td><td class="${h.points >= 0 ? "ohlp-plus" : "ohlp-minus"}">${h.points >= 0 ? "+" : "−"}${n(Math.abs(h.points))}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="ohlp-muted">Nothing yet.</p>`;

  const tiersTable = `<table class="ohlp-tiers"><thead><tr><th>Tier</th><th>Spend in 12 months</th><th>Perks</th></tr></thead><tbody>${program.tiers
    .map(
      (t) =>
        `<tr class="${t.id === tier.id ? "is-me" : ""}"><td>${e(t.name)}${t.id === tier.id ? " (you)" : ""}</td><td>${t.threshold ? `${e(money(t.threshold, cur))}+` : "Everyone"}</td><td class="ohlp-muted">${e(t.perks || "—")}</td></tr>`,
    )
    .join("")}</tbody></table>`;

  return `${top}<div class="ohlp" data-ohlp data-ohlp-one="${one}" data-ohlp-many="${P}">
<h1>${name}</h1>
${joined ? `<div class="ohlp-new"><strong>Welcome${member.firstName ? `, ${e(member.firstName)}` : ""}!</strong> You're in.${program.joinBonus ? ` We've added ${n(program.joinBonus)} ${unit(program.joinBonus)} to get you started.` : ""}</div>` : ""}
<div class="ohlp-hero">
  <div class="ohlp-card"><div class="ohlp-bal">${STAR}<div><div class="ohlp-big" data-ohlp-points>${n(member.points)}</div><div class="ohlp-muted">${P} to spend${member.pending ? ` · ${n(member.pending)} pending until your orders ship` : ""}</div></div></div></div>
  <div class="ohlp-card"><span class="ohlp-tier">${e(tier.name)}</span>
    <div class="ohlp-muted" style="margin-top:8px">${tier.perks ? e(tier.perks) : "Your VIP tier"}</div>
    ${next ? `<div class="ohlp-bar"><span style="width:${pct}%"></span></div><div class="ohlp-muted">Spend ${e(money(next.toGo, cur))} more in the next 12 months to reach <strong>${e(next.name)}</strong></div>` : `<div class="ohlp-muted" style="margin-top:8px">You're at our top tier. Thank you!</div>`}
  </div>
</div>
<div class="ohlp-card"><h2>Redeem your ${P}</h2>${rewards ? `<div class="ohlp-grid">${rewards}</div>` : `<p class="ohlp-muted">Rewards are coming soon.</p>`}</div>
<div class="ohlp-card" data-ohlp-codes><h2>Your codes</h2>${codeRows}</div>
<div class="ohlp-card"><h2>Ways to earn</h2><ul class="ohlp-ways">
<li><span>Shop with us</span><span class="ohlp-pts">${perDollar} ${unit(perDollar)} per ${e(money(1, cur))}</span></li>
${program.joinBonus ? `<li><span>Join ${name}</span><span class="ohlp-done">✓ ${n(program.joinBonus)} ${unit(program.joinBonus)}</span></li>` : ""}
${birthdayRow}
${socialRows}
</ul><p class="ohlp-muted" style="margin:10px 0 0">${P} for an order arrive ${program.earnOn === "paid" ? "once it's paid" : "when it ships"}, on what you paid for the items (not shipping or tax).</p></div>
<div class="ohlp-card"><h2>VIP tiers</h2>${tiersTable}<p class="ohlp-muted" style="margin:10px 0 0">Your tier is based on what you've spent with us in the last 12 months, and unlocks exclusive sales.</p></div>
<div class="ohlp-card"><h2>History</h2>${hist}</div>
</div>
${SCRIPT}`;
}

const SCRIPT = `{% raw %}<script>
(function(){
var root=document.querySelector('[data-ohlp]');if(!root)return;
var base=location.pathname.replace(/\\/rewards(\\/.*)?$/,'');
function post(p,b){return fetch(base+'/rewards/'+p,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return {ok:false}}).then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||'Something went wrong. Please try again.');return j})})}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return '&#'+c.charCodeAt(0)+';'})}
root.addEventListener('click',function(e){
  var r=e.target.closest('[data-ohlp-redeem]');
  if(r){var label=r.getAttribute('data-ohlp-label');if(!window.confirm('Redeem '+root.getAttribute('data-ohlp-many')+' for '+label+'?'))return;var msg=r.parentNode.querySelector('.ohlp-msg');r.disabled=true;msg.textContent='Creating your code…';
    post('redeem',{rewardId:r.getAttribute('data-ohlp-redeem')}).then(function(j){
      msg.innerHTML='Your code: <strong>'+esc(j.code)+'</strong>';
      var pts=root.querySelector('[data-ohlp-points]');if(pts)pts.textContent=Number(j.points).toLocaleString('en-US');
      setTimeout(function(){location.reload()},1600);
    }).catch(function(err){r.disabled=false;msg.textContent=err.message});return}
  var c=e.target.closest('[data-ohlp-copy]');
  if(c){var code=c.getAttribute('data-ohlp-copy');var done=function(){c.textContent='Copied';setTimeout(function(){c.textContent='Copy'},1500)};if(navigator.clipboard)navigator.clipboard.writeText(code).then(done,done);else done();return}
  var s=e.target.closest('[data-ohlp-social]');
  if(s){post('social',{id:s.getAttribute('data-ohlp-social')}).then(function(j){var li=s.closest('li');if(li&&j.awarded){li.lastElementChild.outerHTML='<span class="ohlp-done">✓ '+Number(j.points).toLocaleString('en-US')+' '+(j.points===1?root.getAttribute('data-ohlp-one'):root.getAttribute('data-ohlp-many'))+' earned</span>'}}).catch(function(){})}
});
var bf=root.querySelector('[data-ohlp-bday]');
if(bf)bf.addEventListener('submit',function(e){e.preventDefault();var m=bf.m.value,d=bf.d.value,msg=bf.querySelector('.ohlp-msg');if(!m||!d){msg.textContent='Choose a month and day.';return}
  if(!window.confirm('Save your birthday as '+bf.m.options[bf.m.selectedIndex].text+' '+Number(d)+'? You can only set it once.'))return;
  post('birthday',{date:m+'-'+d}).then(function(){location.reload()}).catch(function(err){msg.textContent=err.message})});
})();
</script>{% endraw %}`;
