// The storefront wishlist page. It's returned through the app proxy as Liquid,
// so Shopify renders it inside the store's theme (header, footer, fonts) and
// fills in prices, pictures and stock from the live products.
// all_products[] can look up 20 products per page, so the list pages by 20.

import { safeHandle } from "./wishlist.server";

export const PAGE_SIZE = 20;

export const liquid = (body, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "application/liquid", "Cache-Control": "no-store" } });

// Text from the app (names, titles) goes into Liquid: escape HTML and braces
// so nothing in it can be read as Liquid.
export const escLiquid = (s) =>
  String(s ?? "").replace(/[&<>"'{}%]/g, (c) => `&#${c.charCodeAt(0)};`);

const heart = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 20.5s-7.2-4.4-9.2-8.8C1.4 8.4 3.3 4.6 6.9 4.6c2 0 3.5 1.1 4.3 2.4h1.6c.8-1.3 2.3-2.4 4.3-2.4 3.6 0 5.5 3.8 4.1 7.1-2 4.4-9.2 8.8-9.2 8.8z" fill="currentColor"/></svg>`;

const STYLE = `<style>
.ohwl-page{max-width:var(--page-width,120rem);margin:0 auto;padding:32px 20px 64px;box-sizing:border-box}
.ohwl-page *{box-sizing:border-box}
.ohwl-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px;margin-bottom:20px}
.ohwl-head h1{margin:0;display:flex;align-items:center;gap:10px}
.ohwl-head h1 svg{color:var(--ohwl-color,#e0245e)}
.ohwl-count{opacity:.65;font-size:.6em;font-weight:400}
.ohwl-tools{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.ohwl-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:42px;padding:0 20px;border-radius:999px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;font-size:.95em;cursor:pointer;text-decoration:none;line-height:1.2}
.ohwl-btn--solid{background:rgb(var(--color-button,18,18,18));color:rgb(var(--color-button-text,255,255,255));border-color:transparent}
.ohwl-btn[disabled]{opacity:.45;cursor:not-allowed}
.ohwl-share{display:none;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 20px;padding:14px 16px;border-radius:12px;background:rgba(var(--color-foreground,18,18,18),.05)}
.ohwl-share.is-on{display:flex}
.ohwl-share input{flex:1 1 260px;min-height:40px;padding:0 12px;border:1px solid rgba(var(--color-foreground,18,18,18),.25);border-radius:8px;font:inherit;background:transparent;color:inherit}
.ohwl-emails{display:flex;gap:10px;align-items:flex-start;margin:0 0 24px;font-size:.95em;opacity:.85}
.ohwl-emails input{margin-top:.25em;width:18px;height:18px;accent-color:var(--ohwl-color,#e0245e)}
.ohwl-grid{list-style:none;margin:0;padding:0;display:grid;gap:28px 20px;grid-template-columns:repeat(2,minmax(0,1fr))}
@media(min-width:750px){.ohwl-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(min-width:990px){.ohwl-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.ohwl-card{display:flex;flex-direction:column;gap:8px;transition:opacity .25s}
.ohwl-card.is-gone{opacity:0}
.ohwl-card__img{display:block;aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:rgba(var(--color-foreground,18,18,18),.04)}
.ohwl-card__img img{width:100%;height:100%;object-fit:contain;display:block}
.ohwl-card__title{font-weight:600;text-decoration:none;color:inherit;line-height:1.3}
.ohwl-card__price s{opacity:.6;margin-right:4px}
.ohwl-card__note{font-size:.85em;opacity:.75}
.ohwl-card__note--pre{color:var(--ohwl-color,#e0245e);opacity:1;font-weight:600}
.ohwl-card__actions{display:flex;flex-direction:column;gap:6px;margin-top:auto}
.ohwl-card__actions .ohwl-btn{width:100%}
.ohwl-remove{background:none;border:0;padding:4px 0;font:inherit;font-size:.85em;color:inherit;opacity:.7;text-decoration:underline;cursor:pointer;align-self:flex-start}
.ohwl-msg{font-size:.85em}
.ohwl-share .ohwl-remove{align-self:center}
.ohwl-msg a{color:inherit}
.ohwl-empty{text-align:center;padding:48px 16px}
.ohwl-empty svg{color:var(--ohwl-color,#e0245e);width:44px;height:44px}
.ohwl-empty p{margin:12px auto 20px;max-width:420px}
.ohwl-pages{display:flex;justify-content:center;gap:16px;margin-top:32px}
</style>`;

// One product card. Live details come from all_products in Liquid; the app's
// own copy (title) is only used if the product can't be shown any more.
function card(item, { owner }) {
  const h = safeHandle(item.handle);
  const remove = owner
    ? `<button type="button" class="ohwl-remove" data-ohwl-remove="${escLiquid(item.id)}">Remove</button>`
    : "";
  const gone = `<li class="ohwl-card" data-ohwl-card="${escLiquid(item.id)}"><div class="ohwl-card__img"></div><span class="ohwl-card__title">${escLiquid(
    item.title || "This product",
  )}</span><span class="ohwl-card__note">No longer available</span>${remove}</li>`;
  if (!h || item.missing) return owner ? gone : "";
  return `{%- assign p = all_products['${h}'] -%}
{%- if p.id -%}
{%- liquid
  assign opens = p.metafields.oh_preorder.opens_at.value
  assign closes = p.metafields.oh_preorder.closes_at.value
  assign phase = ''
  if opens != blank or closes != blank
    assign phase = 'open'
    if opens != blank
      assign o = opens | date: '%s' | plus: 0
      if o > now_s
        assign phase = 'soon'
      endif
    endif
    if closes != blank
      assign c = closes | date: '%s' | plus: 0
      if c <= now_s
        assign phase = ''
      endif
    endif
  endif
-%}
<li class="ohwl-card" data-ohwl-card="${escLiquid(item.id)}">
  <a class="ohwl-card__img" href="{{ p.url }}">{%- if p.featured_image -%}{{ p.featured_image | image_url: width: 600 | image_tag: loading: 'lazy', widths: '300,450,600', sizes: '(min-width: 990px) 25vw, (min-width: 750px) 33vw, 50vw', alt: p.featured_image.alt }}{%- endif -%}</a>
  <a class="ohwl-card__title" href="{{ p.url }}">{{ p.title }}</a>
  <div class="ohwl-card__price">{%- if p.compare_at_price > p.price -%}<s>{{ p.compare_at_price | money }}</s>{%- endif -%}{%- if p.price_varies -%}From {% endif -%}{{ p.price | money }}</div>
  {%- if phase == 'soon' -%}<span class="ohwl-card__note ohwl-card__note--pre">Pre-orders open {{ opens | date: '%b %-d' }}</span>
  {%- elsif phase == 'open' and p.available -%}<span class="ohwl-card__note ohwl-card__note--pre">Available to pre-order</span>
  {%- elsif p.available == false -%}<span class="ohwl-card__note">Sold out</span>{%- endif -%}
  <div class="ohwl-card__actions">
  {%- if phase == 'soon' or p.available == false -%}
    <button type="button" class="ohwl-btn" disabled>{% if phase == 'soon' %}Coming soon{% else %}Sold out{% endif %}</button>
  {%- elsif p.has_only_default_variant -%}
    <form method="post" action="{{ routes.cart_add_url }}" class="ohwl-add">
      <input type="hidden" name="id" value="{{ p.selected_or_first_available_variant.id }}">
      <input type="hidden" name="quantity" value="1">
      <button type="submit" class="ohwl-btn ohwl-btn--solid">{% if phase == 'open' %}Pre-order{% else %}Add to cart{% endif %}</button>
      <div class="ohwl-msg" role="status"></div>
    </form>
  {%- else -%}
    <a class="ohwl-btn ohwl-btn--solid" href="{{ p.url }}">Choose options</a>
  {%- endif -%}
  ${remove}
  </div>
</li>
{%- else -%}
${owner ? gone : ""}
{%- endif -%}`;
}

const loginBlock = (wishlistPath) => `<div class="ohwl-empty">${heart}
<h2>Your wishlist</h2>
<p>Log in or create an account to save your favorite products and find them again on any device.</p>
<div class="ohwl-tools" style="justify-content:center">
<a class="ohwl-btn ohwl-btn--solid" href="{{ routes.account_login_url }}?return_url={{ '${wishlistPath}' | url_encode }}">Log in</a>
<a class="ohwl-btn" href="{{ routes.account_register_url }}">Create account</a>
</div></div>`;

// mode: "own" | "shared" | "login" | "notfound"
export function renderWishlistPage({ mode, items = [], page = 1, firstName = null, emailsOn = true, shared = false, color = null }) {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const slice = items.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const owner = mode === "own";
  const vars = color && /^#[0-9a-f]{3,8}$/i.test(color) ? `<style>.ohwl-page{--ohwl-color:${color}}</style>` : "";
  const top = `{%- assign now_s = 'now' | date: '%s' | plus: 0 -%}${STYLE}${vars}`;

  if (mode === "login") return `${top}<div class="ohwl-page">${loginBlock("/apps/purchase-history/wishlist")}</div>`;
  if (mode === "notfound")
    return `${top}<div class="ohwl-page"><div class="ohwl-empty">${heart}<h2>This wishlist isn't available</h2><p>The link may have been turned off by its owner.</p><a class="ohwl-btn ohwl-btn--solid" href="{{ routes.all_products_collection_url }}">Browse products</a></div></div>`;

  const title = owner ? "My wishlist" : firstName ? `${escLiquid(firstName)}'s wishlist` : "A shared wishlist";
  const count = `<span class="ohwl-count" data-ohwl-count>(${items.length})</span>`;
  const tools = owner
    ? `<div class="ohwl-tools">
<button type="button" class="ohwl-btn" data-ohwl-share="${shared ? "on" : "off"}"${items.length ? "" : " disabled"}>Share my wishlist</button>
</div>`
    : "";
  const shareBox = owner
    ? `<div class="ohwl-share" data-ohwl-sharebox>
<input type="text" readonly aria-label="Link to your wishlist" data-ohwl-link>
<button type="button" class="ohwl-btn ohwl-btn--solid" data-ohwl-copy>Copy link</button>
<button type="button" class="ohwl-remove" data-ohwl-unshare>Stop sharing</button>
<span class="ohwl-msg" data-ohwl-sharemsg role="status"></span>
</div>
<label class="ohwl-emails"><input type="checkbox" data-ohwl-emails${emailsOn ? " checked" : ""}><span>Email me when something on my wishlist is back in stock or opens for pre-order.</span></label>`
    : "";
  const empty = owner
    ? `<div class="ohwl-empty">${heart}<h2>Your wishlist is empty</h2><p>Tap the heart next to any product to save it here.</p><a class="ohwl-btn ohwl-btn--solid" href="{{ routes.all_products_collection_url }}">Start shopping</a></div>`
    : `<div class="ohwl-empty"><p>Nothing here yet.</p></div>`;
  const pager =
    pages > 1
      ? `<nav class="ohwl-pages" aria-label="Wishlist pages">${current > 1 ? `<a class="ohwl-btn" href="?page=${current - 1}">Previous</a>` : ""}<span style="align-self:center">Page ${current} of ${pages}</span>${current < pages ? `<a class="ohwl-btn" href="?page=${current + 1}">Next</a>` : ""}</nav>`
      : "";

  return `${top}<div class="ohwl-page" data-ohwl-page="${owner ? "own" : "shared"}"${owner ? " data-ohwl-skip" : ""}>
<div class="ohwl-head"><h1>${heart}<span>${title}</span> ${count}</h1>${tools}</div>
${shareBox}
${items.length ? `<ul class="ohwl-grid">${slice.map((i) => card(i, { owner })).join("\n")}</ul>${pager}` : empty}
${items.length ? `<div data-ohwl-emptynote hidden>${empty}</div>` : ""}
</div>
${SCRIPT}`;
}

// Remove, share, email switch and add-to-cart. {% raw %} keeps Liquid out of it.
const SCRIPT = `{% raw %}<script>
(function(){
var root=document.querySelector('[data-ohwl-page]');if(!root)return;
var base=location.pathname.replace(/\\/wishlist(\\/.*)?$/,'');
function post(path,body){return fetch(base+'/wishlist/'+path,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {ok:false}}).then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||'Something went wrong. Please try again.');return j})})}
var countEl=root.querySelector('[data-ohwl-count]');
root.addEventListener('click',function(e){
  var rm=e.target.closest('[data-ohwl-remove]');
  if(rm){e.preventDefault();var id=rm.getAttribute('data-ohwl-remove');var card=rm.closest('[data-ohwl-card]');rm.disabled=true;
    post('toggle',{productId:id,on:false}).then(function(j){if(countEl)countEl.textContent='('+j.count+')';try{document.dispatchEvent(new CustomEvent('ohwl:changed',{detail:{id:id,on:false,count:j.count}}))}catch(x){}
      if(card){card.classList.add('is-gone');setTimeout(function(){card.remove();if(!root.querySelector('[data-ohwl-card]')){var g=root.querySelector('.ohwl-grid');if(g)g.remove();var n=root.querySelector('[data-ohwl-emptynote]');if(n)n.hidden=false;var s=root.querySelector('[data-ohwl-share]');if(s)s.disabled=true}},260)}
    }).catch(function(err){rm.disabled=false;alertMsg(card,err.message)});return}
  var sh=e.target.closest('[data-ohwl-share]');
  if(sh){e.preventDefault();share(true);return}
  if(e.target.closest('[data-ohwl-unshare]')){e.preventDefault();share(false);return}
  if(e.target.closest('[data-ohwl-copy]')){e.preventDefault();var inp=root.querySelector('[data-ohwl-link]');inp.select();var done=function(){say('Link copied')};if(navigator.clipboard)navigator.clipboard.writeText(inp.value).then(done,function(){document.execCommand('copy');done()});else{document.execCommand('copy');done()}}
});
function say(t){var m=root.querySelector('[data-ohwl-sharemsg]');if(m)m.textContent=t}
function alertMsg(card,t){var m=card&&card.querySelector('.ohwl-msg');if(m)m.textContent=t;else window.alert(t)}
function share(on){var box=root.querySelector('[data-ohwl-sharebox]');say('');post('share',{on:on}).then(function(j){
  if(on&&j.token){var url=location.origin+base+'/wishlist/s/'+j.token;root.querySelector('[data-ohwl-link]').value=url;box.classList.add('is-on');
    if(navigator.share&&/Mobi|Android/i.test(navigator.userAgent)){navigator.share({title:document.title,url:url}).catch(function(){})}}
  else{box.classList.remove('is-on');}
}).catch(function(err){box.classList.add('is-on');say(err.message)})}
var em=root.querySelector('[data-ohwl-emails]');
if(em)em.addEventListener('change',function(){var want=em.checked;em.disabled=true;post('emails',{on:want}).catch(function(){em.checked=!want}).then(function(){em.disabled=false})});
root.addEventListener('submit',function(e){
  var f=e.target.closest('.ohwl-add');if(!f||!window.fetch)return;e.preventDefault();
  var b=f.querySelector('button'),m=f.querySelector('.ohwl-msg'),label=b.textContent;b.disabled=true;m.textContent='';
  fetch(f.action.replace(/\\/?$/,'')+'.js',{method:'POST',headers:{Accept:'application/json'},body:new FormData(f)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.description||j.message||'Could not add to cart.');return j})})
  .then(function(){b.textContent='Added';m.innerHTML='<a href="'+(window.Shopify&&Shopify.routes?Shopify.routes.root:'/')+'cart">View cart</a>';setTimeout(function(){b.textContent=label;b.disabled=false},2500);try{document.dispatchEvent(new CustomEvent('cart:refresh'))}catch(x){}})
  .catch(function(err){b.textContent=label;b.disabled=false;m.textContent=err.message});
});
})();
</script>{% endraw %}`;
