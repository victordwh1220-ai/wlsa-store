'use strict';

(() => {
  const { products, categories } = window.storeCatalog;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => `¥${n.toFixed(2)}`;
  const assetPath = path => `${location.pathname.startsWith('/store') ? '/store/' : '/'}${path}`;
  const bySlug = slug => products.find(p => p.slug === slug);
  const byId = id => products.find(p => p.id === id);
  const main = $('#shop-main');
  const productDialog = $('#product-dialog');
  const cartDialog = $('#cart-dialog');
  const infoDialog = $('#info-dialog');
  const zoomDialog = $('#zoom-dialog');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const timers = new WeakMap();
  const focusReturns = new WeakMap();
  let mainRoute = '', activeProduct = null, selectedSize = '', imageIndex = 0;
  let originCard = null;
  let bag = [];
  let offers = new Map();
  let optionsRequest = 0;
  let placingOrder = false;
  let checkout = null;
  let paymentTimer;
  let qrObjectUrl;
  const checkoutKey = 'wlsa-checkout-v1';
  const validOrder = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
  const validToken = token => typeof token === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(token);
  const validAmount = n => Number.isSafeInteger(n) && n > 0;
  const cartItems = () => bag.map(({id, size, qty}) => ({id, size, quantity: qty}));
  const offerFor = item => offers.get(item.id)?.sizes.includes(item.size) ? offers.get(item.id) : null;
  const isPayable = () => bag.length > 0 && bag.every(offerFor);
  const amountFen = () => bag.reduce((sum, item) => sum + offerFor(item).priceFen * item.qty, 0);
  const productPrice = p => offers.has(p.id) ? offers.get(p.id).priceFen / 100 : p.price;
  try {
    const saved = JSON.parse(sessionStorage.getItem(checkoutKey));
    if (saved && /^[a-f0-9-]{36}$/.test(saved.requestId) && Array.isArray(saved.items) &&
        validAmount(saved.expectedAmountFen) && (!saved.orderId || (validOrder(saved.orderId) && validToken(saved.token)))) checkout = saved;
  } catch { /* Browsing remains available with storage disabled. */ }
  try {
    const saved = JSON.parse(localStorage.getItem('wlsa-supply-bag-v1') || '[]');
    if (Array.isArray(saved)) {
      for (const item of saved.slice(0, 200)) {
        if (!item || !byId(item.id)?.sizes.includes(item.size) || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 10) continue;
        const line = bag.find(line => line.id === item.id && line.size === item.size);
        if (line) line.qty = Math.min(10, line.qty + item.qty);
        else bag.push({ id: item.id, size: item.size, qty: item.qty });
      }
    }
  } catch { /* A blocked storage area does not stop browsing. */ }

  const image = (p, side, small = false, eager = false) => `<img src="${assetPath(p.images[small ? side + '_small' : side])}" ${small ? `srcset="${assetPath(p.images[side+'_small'])} 640w, ${assetPath(p.images[side])} 1254w" sizes="(max-width:767px) 45vw, 28vw"` : ''} width="1254" height="1254" alt="${esc(p.name_en)} · ${side === 'a' ? '主视图' : '另一视角'}" decoding="async" ${eager ? 'loading="eager"' : 'loading="lazy"'}>`;
  const announce = text => { $('#store-status').textContent = text; };
  function saveBag() {
    try { localStorage.setItem('wlsa-supply-bag-v1', JSON.stringify(bag)); }
    catch { announce('Your cart is available for this visit. Browser storage is unavailable.'); }
    updateCount();
  }
  function updateCount() {
    const count = bag.reduce((s,i) => s+i.qty,0);
    $('#cart-count').textContent = count ? ` (${count})` : '';
    $('#cart-trigger').setAttribute('aria-label', `Cart, ${count} items`);
  }
  function showDialog(dialog, focusSelector = '[data-close]') {
    clearTimeout(timers.get(dialog));
    if (!dialog.open) {
      focusReturns.set(dialog,document.activeElement);
      dialog.showModal();
      document.body.classList.add('modal-open');
    }
    // Establish the offscreen position before the transition; no animation library needed.
    void dialog.offsetWidth;
    dialog.classList.add('is-open');
    $(focusSelector,dialog)?.focus({preventScroll:true});
  }
  function hideDialog(dialog, immediate = false) {
    if (!dialog.open) return;
    if (dialog === infoDialog) clearPaymentView();
    clearTimeout(timers.get(dialog));
    dialog.classList.remove('is-open');
    const finish = () => {
      dialog.close();
      if (!document.querySelector('dialog[open]')) document.body.classList.remove('modal-open');
      const target = focusReturns.get(dialog);
      const top = $$('dialog[open]').at(-1);
      if (target?.isConnected && (!top || top.contains(target))) target.focus({preventScroll:true});
      else if (dialog === infoDialog && top === cartDialog) $('[data-action="checkout"]', cartDialog)?.focus({preventScroll:true});
      if (dialog === productDialog) originCard?.classList.remove('opening');
    };
    if (immediate || dialog === zoomDialog) finish();
    else timers.set(dialog,setTimeout(finish,reduce.matches ? 110 : 310));
  }
  function navigate(route, extra = {}) {
    if (location.hash === '#' + route) return;
    history.pushState(extra, '', '#' + route);
    renderRoute();
  }
  function dismiss(dialog) {
    if (dialog === productDialog && location.hash.startsWith('#product/')) {
      if (history.state?.fromStore) history.back();
      else {
        history.replaceState({},'', '#' + (mainRoute || 'shop/tops'));
        renderRoute();
      }
    } else hideDialog(dialog);
  }
  function accordion(id, title, copy) {
    return `<section class="accordion"><h2><button class="accordion-trigger" aria-expanded="false" aria-controls="${id}" id="${id}-trigger" data-action="accordion">${title}<span class="plus-icon" aria-hidden="true"></span></button></h2><div class="accordion-panel" id="${id}" data-open="false" role="region" aria-labelledby="${id}-trigger" aria-hidden="true" inert><div><div class="accordion-copy">${copy}</div></div></div></section>`;
  }
  function card(p,index) {
    return `<a class="product-card" data-product="${p.slug}" href="#product/${p.slug}" aria-label="${esc(p.name_en)}, ${money(productPrice(p))}" style="--delay:${index%3*50}ms;--mobile-delay:${index%2*50}ms"><div class="product-visual"><div class="primary">${image(p,'a',true,index<6)}</div><div class="alternate">${image(p,'b',true,index<6)}</div></div><div class="product-caption"><h2>${esc(p.name_en.toLowerCase())}</h2><p data-store-price="${esc(p.id)}">${money(productPrice(p))}</p></div></a>`;
  }
  function categoryBar(selected) {
    const links = [{id:'all', en:'Shop all'}, ...categories].map(category => {
      const current = selected === category.id ? 'aria-current="page"' : '';
      return `<a class="category-link" href="#shop/${category.id}" ${current}>${category.en}</a>`;
    });
    return `<nav class="catalog-tabs" aria-label="Product categories">${links.join('')}</nav>`;
  }
  function shop(category) {
    const selected = category==='all' || categories.some(c=>c.id===category) ? category : 'tops';
    const list = products.filter(p=>selected==='all'||p.category===selected);
    return `<h1 class="sr-only">${selected==='all'?'All WLSA products':esc(categories.find(c=>c.id===selected).en)}</h1><div class="catalog-layout">${categoryBar(selected)}<div class="product-grid">${list.map(card).join('')}</div></div>`;
  }
  const faqs = [
    ['Can I buy these products now?', 'Items open for sale can be purchased with WeChat Pay. Your cart shows which sizes are available and the total before you open a payment code. Other designs are available to preview.'],
    ['How do I view the other side?', 'Hover over a product to see its second view. Open the product to browse both images. On a phone, swipe the product images from side to side. Select an image to view it full screen.'],
    ['What sizes are available?', 'Apparel is shown in XS–XXL, footwear in EU 36–44, and accessories in one size. These are proposed options. Final measurements and availability will be confirmed before release.'],
    ['How does the cart work?', 'Your cart is saved in this browser. Open it to review prices and availability. When checkout is open, scan the code in WeChat and confirm the amount there. Return to this tab to see confirmation.'],
    ['What about shipping, collection and returns?', 'Delivery, campus collection and return arrangements have not been announced. These details will be published before the collection goes on sale.'],
    ['Are the images final production photos?', 'The images are generated visualizations of original WLSA merchandise concepts. Each product includes two views of the same design. Materials, colors, measurements and details remain subject to production approval.']
  ];
  function editorial(route) {
    if(route==='faq')return `<div class="editorial faq-page"><h1>Frequently asked questions.</h1>${faqs.map(([q,a],i)=>accordion('faq-'+i,q,`<p>${a}</p>`)).join('')}</div>`;
    if(route==='archive')return `<div class="editorial"><h1>Every collection<br>starts somewhere.</h1><p class="lede">This is our first chapter. Past releases will live here as the WLSA collection grows.</p><p class="muted">Explore the current 54-piece concept collection.</p><p><a class="pill white" href="#shop/all">Shop the collection ↗</a></p></div>`;
    return `<div class="editorial"><h1>A little of campus,<br>wherever you go.</h1><p class="lede">WLSA Store brings the shared language of school life to the things we wear and carry every day.</p><p class="lede">Navy, ivory and blue. Familiar letters. Useful objects. From an everyday tee to the bag that follows you home, each piece belongs to the same collection.</p><p class="muted">54 original merchandise concepts across 10 categories. Product images are generated visualizations. The cart shows which pieces are available for purchase.</p><p><a class="pill white" href="#shop/all">Explore the collection ↗</a></p></div>`;
  }
  function renderBase(route) {
    const [page,category='tops']=route.split('/');
    document.title = `${page==='shop' ? (categories.find(c=>c.id===category)?.en || 'Shop') : page.charAt(0).toUpperCase()+page.slice(1)} · WLSA Store`;
    if(mainRoute===route)return;
    mainRoute=route;
    main.innerHTML = page==='shop' ? shop(category) : ['about','faq','archive'].includes(page) ? editorial(page) : `<div class="editorial"><h1>Page not found.</h1><p><a class="pill white" href="#shop/all">Return to the shop</a></p></div>`;
    document.title = `${page==='shop' ? (categories.find(c=>c.id===category)?.en || 'Shop') : page.charAt(0).toUpperCase()+page.slice(1)} · WLSA Store`;
    $$('.store-navigation a').forEach(a=>{const current=a.hash.slice(1).split('/')[0]===page;if(current)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    window.scrollTo({top:0,behavior:'instant'});
  }
  function renderRoute() {
    let route=location.hash.slice(1)||'shop/tops';
    if(route==='collections'){
      route='shop/all';
      history.replaceState({},'', '#'+route);
    }
    if(route==='shop-main'){main.focus();return;}
    hideDialog(cartDialog,true);
    hideDialog(infoDialog,true);
    if(route.startsWith('product/')) {
      const p=bySlug(route.slice(8));
      if(!p){hideDialog(productDialog);renderBase('not-found');return;}
      const base=history.state?.background || (mainRoute && !mainRoute.startsWith('not-found') ? mainRoute : 'shop/'+p.category);
      renderBase(base);
      if(activeProduct?.id!==p.id || !productDialog.classList.contains('is-open')) renderProduct(p);
      document.title=`${p.name_en} · WLSA Store`;
      return;
    }
    hideDialog(zoomDialog,true);
    hideDialog(productDialog);
    renderBase(route);
  }
  function detailsCopy(p) {
    const design=p.design.replace(/No (?:additional|third-party|unrelated)[^.]*\./g,'');
    const material=design.split(/Front:|Outer side:|Front-facing barrel:/)[0].trim();
    const care=['tops','outerwear','bottoms','headwear','accessories'].includes(p.category) ? 'Follow the final care label. Garment measurements and washing instructions will be confirmed before release.' : 'Care instructions and final dimensions will be confirmed before release.';
    return {description:material,care:`<p>${esc(material)}</p><p>${care}</p>`,fit:p.sizes.length>1?`<p>Proposed ${p.category==='footwear'?'EU shoe':'unisex'} sizes: ${p.sizes.join(', ')}.</p><p>A measured size guide will be available before launch. Product images show the design, not a guaranteed fit.</p>`:'<p>One size. Final dimensions will be confirmed before release.</p>'};
  }
  function renderProduct(p) {
    activeProduct=p;
    selectedSize=p.sizes.length===1?p.sizes[0]:'';
    const copy=detailsCopy(p);
    $('#product-content').innerHTML=`<div class="product-gallery">${['a','b'].map((side,i)=>`<button class="gallery-image" data-action="view-image" data-index="${i}" aria-label="View ${esc(p.name_en)} ${i===0?'front':'alternate'} image">${image(p,side,false,true)}</button>`).join('')}</div><div class="product-information"><h1 id="product-title">${esc(p.name_en)}</h1><p class="product-price" data-store-price="${esc(p.id)}">${money(productPrice(p))}</p><p class="product-description">${esc(copy.description)}</p><fieldset class="size-picker" aria-describedby="size-error"><legend>Size</legend><div class="size-options">${p.sizes.map(size=>`<label class="size-option"><input type="radio" name="size" value="${size}" ${selectedSize===size?'checked':''}><span>${size}</span></label>`).join('')}</div></fieldset><p class="size-error" id="size-error" role="alert"></p><button class="add-button" data-action="add-cart">Add to cart</button><div class="product-accordions">${accordion('product-materials','Materials &amp; Care',copy.care)}${accordion('product-fit','Size &amp; Fit',copy.fit)}</div></div>`;
    $('#product-content').scrollTop=0;
    originCard=$(`[data-product="${p.slug}"]`,main);
    originCard?.classList.add('opening');
    showDialog(productDialog);
  }
  function openProduct(slug,trigger) {
    const background=mainRoute||'shop/tops';
    hideDialog(infoDialog,true);
    hideDialog(cartDialog,true);
    if(trigger?.isConnected)trigger.focus({preventScroll:true});
    navigate('product/'+slug,{background,fromStore:true});
  }
  async function refreshOffers() {
    const request = ++optionsRequest;
    const next = new Map();
    try {
      const response = await fetch('/api/store/payment-options', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const options = await response.json();
        if (options.enabled === true && Array.isArray(options.items)) {
          for (const item of options.items) {
            if (byId(item.id) && validAmount(item.priceFen) && Array.isArray(item.sizes)) next.set(item.id, item);
          }
        }
      }
    } catch { /* An offline or static Store can still show the collection. */ }
    if (request !== optionsRequest) return;
    const changed = next.size !== offers.size || [...next].some(([id, item]) => {
      const old = offers.get(id);
      return old?.priceFen !== item.priceFen || old.sizes.join('/') !== item.sizes.join('/');
    });
    if (!changed) return;
    offers = next;
    for (const node of $$('[data-store-price]')) {
      const p = byId(node.dataset.storePrice);
      node.textContent = money(productPrice(p));
      node.closest('.product-card')?.setAttribute('aria-label', p.name_en + ', ' + node.textContent);
    }
    if (cartDialog.open) renderCart();
  }
  function cartLine(item, i) {
    const p = byId(item.id);
    const offer = offerFor(item);
    const sku = esc(p.slug);
    const name = esc(p.name_en);
    const lineAmount = (offer ? offer.priceFen / 100 : p.price) * item.qty;
    return `<article class="cart-row"><a href="#product/${sku}" data-product="${sku}" aria-label="${name}">${image(p, 'a', true, true)}</a>
      <div><div class="cart-item-heading"><a href="#product/${sku}" data-product="${sku}">${name}</a><span>${money(lineAmount)}</span></div>
      <p class="cart-item-size">${esc(item.size)}${!offer && offers.size ? ' · Preview only' : ''}</p>
      <div class="quantity-row"><button data-action="quantity" data-index="${i}" data-delta="-1" aria-label="Decrease ${name} quantity">−</button>
      <span aria-label="Quantity ${item.qty}">${item.qty}</span><button data-action="quantity" data-index="${i}" data-delta="1" aria-label="Increase ${name} quantity" ${item.qty === 10 ? 'disabled' : ''}>+</button>
      <button class="remove-item" data-action="remove" data-index="${i}">Remove</button></div></div></article>`;
  }
  function renderCart() {
    const payable = isPayable();
    const total = bag.reduce((sum, item) => sum + (offerFor(item)?.priceFen ?? byId(item.id).price * 100) * item.qty, 0);
    let button = 'Review selection';
    let note = offers.size ? 'Remove preview-only items to pay for the available sizes.' : 'Checkout is closed. Prices shown are illustrative.';
    if (payable) { button = 'Pay with WeChat · ' + money(total / 100); note = 'Confirm the payment in WeChat.'; }
    if (checkout) { button = checkout.orderId ? 'View your order' : 'Resume checkout'; note = 'Return to the order you started in this tab.'; }
    if (placingOrder) button = 'Opening payment…';
    $('#cart-content').innerHTML = `<h2 id="cart-title">Shopping cart</h2>
      <div class="cart-items">${bag.length ? bag.map(cartLine).join('') : '<p class="empty-cart">Your cart is empty</p>'}</div>
      <div class="cart-bottom"><p class="subtotal"><span>${payable ? 'Subtotal' : 'Preview subtotal'}</span><span>${money(total / 100)}</span></p>
      <button class="checkout-button" data-action="checkout" ${placingOrder || (!bag.length && !checkout) ? 'disabled' : ''}>${button}</button>
      ${bag.length || checkout ? '<p class="cart-note">' + note + '</p>' : ''}</div>`;
  }
  function showCart() { renderCart(); showDialog(cartDialog); refreshOffers(); }
  function clearPaymentView() {
    clearTimeout(paymentTimer);
    if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
    qrObjectUrl = null;
  }
  function showPayment(order) {
    information('WeChat Pay', `<p>Order <strong>${esc(order.orderId)}</strong></p>
      <p class="subtotal"><span>Total</span><span>${money(order.expectedAmountFen / 100)}</span></p>
      <p id="payment-status" role="status">Checking payment status…</p><img id="payment-code" alt="Scan this payment code in WeChat" hidden>
      <button class="checkout-button" id="payment-next" hidden></button>`);
    const status = $('#payment-status');
    const image = $('#payment-code');
    const button = $('#payment-next');
    const active = () => status.isConnected && infoDialog.classList.contains('is-open');
    const path = '/api/store/orders/' + order.orderId;
    const options = () => ({ headers: { Authorization: 'Bearer ' + order.token }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
    async function check() {
      clearTimeout(paymentTimer);
      button.hidden = true;
      try {
        const response = await fetch(path, options());
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (!active()) return;
        if (result.amountFen !== order.expectedAmountFen || !['pending', 'paid', 'closed'].includes(result.status)) throw new Error();
        if (result.status === 'pending') {
          if (!image.hasAttribute('src')) {
            const response = await fetch(path + '/qr', options());
            if (!response.ok || !response.headers.get('content-type')?.startsWith('image/svg+xml')) throw new Error();
            const blob = await response.blob();
            if (!active()) return;
            qrObjectUrl = URL.createObjectURL(blob);
            image.src = qrObjectUrl;
          }
          image.hidden = false;
          status.textContent = 'Scan in WeChat. This page updates when your payment is confirmed.';
          paymentTimer = setTimeout(check, 4000);
          return;
        }
        image.hidden = true;
        clearPaymentView();
        const paid = result.status === 'paid';
        status.textContent = paid ? 'Payment confirmed.' : 'This order is closed. Review your cart to start another order.';
        button.textContent = paid ? 'Done' : 'Return to cart';
        button.hidden = false;
        button.onclick = () => {
          if (paid && JSON.stringify(order.items) === JSON.stringify(cartItems())) { bag = []; saveBag(); }
          resetCheckout();
        };
      } catch {
        if (!active()) return;
        image.hidden = true;
        status.textContent = 'Payment status is unavailable. Check this order again before paying.';
        button.textContent = 'Check again';
        button.hidden = false;
        button.onclick = check;
      }
    }
    check();
  }
  function resetCheckout() {
    try { sessionStorage.removeItem(checkoutKey); } catch { /* Session storage may become unavailable. */ }
    checkout = null;
    hideDialog(infoDialog);
    renderCart();
    refreshOffers();
  }
  async function startCheckout() {
    if (placingOrder) return;
    if (checkout?.orderId) { showPayment(checkout); return; }
    if (!checkout && !isPayable()) {
      information('Your selection', '<p>Your cart is saved. Checkout is available only for items and sizes open for sale.</p>');
      return;
    }
    if (!checkout) {
      try {
        const draft = { requestId: crypto.randomUUID(), expectedAmountFen: amountFen(), items: cartItems() };
        sessionStorage.setItem(checkoutKey, JSON.stringify(draft));
        checkout = draft;
      } catch {
        information('Checkout unavailable', '<p>Allow storage in this tab and open the store over HTTPS or localhost to start a payment.</p>');
        return;
      }
    }
    placingOrder = true;
    renderCart();
    try {
      const response = await fetch('/api/store/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(checkout),
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        const definitive = [400, 409, 422].includes(response.status);
        if (cartDialog.classList.contains('is-open')) {
          information('Checkout unavailable', definitive
            ? '<p>This selection or price is no longer available for this request. Review the cart before starting a new order.</p><button class="checkout-button" data-action="reset-checkout">Review cart again</button>'
            : '<p>The store could not confirm this request. Choose Resume checkout to check the same order.</p>');
        }
        return;
      }
      const result = await response.json();
      if (!validOrder(result.orderId) || !validToken(result.token)) throw new Error();
      checkout = { ...checkout, orderId: result.orderId, token: result.token };
      try { sessionStorage.setItem(checkoutKey, JSON.stringify(checkout)); } catch { /* The stored request ID can recover this order. */ }
      if (cartDialog.classList.contains('is-open')) showPayment(checkout);
    } catch {
      if (cartDialog.classList.contains('is-open')) information('Connection interrupted', '<p>Choose Resume checkout to recover this order using the same payment request.</p>');
    } finally {
      placingOrder = false;
      renderCart();
    }
  }
  function information(title,copy){clearPaymentView();$('#info-content').innerHTML=`<h2 id="info-title">${title}</h2>${copy}`;showDialog(infoDialog);}
  function showImage(index){imageIndex=(index+2)%2;zoomDialog.classList.remove('zoomed');const side=imageIndex===0?'a':'b';$('#zoom-image').src=assetPath(activeProduct.images[side]);$('#zoom-image').alt=`${activeProduct.name_en} · ${side==='a'?'front view':'alternate view'}`;$('#image-counter').textContent=`${imageIndex+1} / 2`;if(!zoomDialog.open)showDialog(zoomDialog);}
  function searchResults(query) {
    const q=query.trim().toLowerCase();
    const results=q?products.filter(p=>`${p.name} ${p.name_en} ${p.category} ${categories.find(c=>c.id===p.category).name}`.toLowerCase().includes(q)):[];
    $('#search-results').innerHTML=q?(results.length?results.map(p=>`<a class="search-result" href="#product/${p.slug}" data-product="${p.slug}">${image(p,'a',true)}<span>${p.name_en}<small>${money(productPrice(p))}</small></span></a>`).join(''):'<p class="empty-results">No products found. Try another name or category.</p>'):'<p class="empty-results">Search by product name or category.</p>';
    announce(q?`${results.length} products found`:'Search products');
  }
  document.addEventListener('click',event=>{
    const productLink=event.target.closest('[data-product]');
    if(productLink && !event.metaKey && !event.ctrlKey && !event.shiftKey){event.preventDefault();openProduct(productLink.dataset.product,productLink);return;}
    const localLink=event.target.closest('a[href^="#"]');
    if(localLink && !event.metaKey && !event.ctrlKey && !event.shiftKey){event.preventDefault();const path=localLink.hash.slice(1);if(path==='shop-main'){main.focus();return;}hideDialog(infoDialog);hideDialog(cartDialog);navigate(path);return;}
    const close=event.target.closest('[data-close]');
    if(close){dismiss(close.closest('dialog'));return;}
    const control=event.target.closest('[data-action]');
    if(!control)return;
    const action=control.dataset.action;
    if(action==='cart')showCart();
    if(action==='accordion'){
      const open=control.getAttribute('aria-expanded')!=='true';
      control.setAttribute('aria-expanded',String(open));
      const panel=document.getElementById(control.getAttribute('aria-controls'));
      panel.dataset.open=String(open);panel.inert=!open;panel.setAttribute('aria-hidden',String(!open));
    }
    if(action==='categories'){
      const expanded=control.getAttribute('aria-expanded')!=='true';
      control.setAttribute('aria-expanded',String(expanded));control.closest('aside').classList.toggle('expanded',expanded);
      control.querySelector('span').textContent=expanded?'−':'＋';
    }
    if(action==='add-cart'){
      if(!selectedSize){$('#size-error').textContent='Please select a size.';$('input[name=size]',productDialog)?.focus();return;}
      const existing=bag.find(i=>i.id===activeProduct.id&&i.size===selectedSize);
      if(existing?.qty===10){$('#size-error').textContent='You can save up to 10 of each size.';return;}
      if(existing)existing.qty++;else bag.push({id:activeProduct.id,size:selectedSize,qty:1});
      saveBag();announce(`${activeProduct.name_en}, ${selectedSize}, added to cart.`);showCart();
    }
    if(action==='quantity'||action==='remove'){
      const i=Number(control.dataset.index);if(!bag[i])return;
      if(action==='remove')bag.splice(i,1);else{bag[i].qty=Math.min(10,bag[i].qty+Number(control.dataset.delta));if(bag[i].qty<1)bag.splice(i,1);}
      saveBag();renderCart();
      const next=$(`.cart-row:nth-child(${Math.min(i+1,bag.length)}) [data-action="quantity"]`,cartDialog)||$('[data-close]',cartDialog);next.focus({preventScroll:true});
      announce(`Cart updated. ${bag.reduce((s,i)=>s+i.qty,0)} items.`);
    }
    if (action === 'checkout') startCheckout();
    if (action === 'reset-checkout') resetCheckout();
    if(action==='view-image')showImage(Number(control.dataset.index));
    if(action==='image-prev')showImage(imageIndex-1);
    if(action==='image-next')showImage(imageIndex+1);
    if(action==='zoom')zoomDialog.classList.toggle('zoomed');
    if(action==='search'){
      information('Search the collection','<label class="sr-only" for="product-search">Search products</label><input class="search-input" id="product-search" type="search" placeholder="Search products" autocomplete="off"><div id="search-results" class="search-results"></div>');searchResults('');$('#product-search').focus();
    }
    if(action==='privacy')information('Privacy','<p>Your cart is stored in this browser. During checkout the store records the selected items, total and payment status. WeChat handles the payment, and this tab keeps access to your order status.</p><p>You can remove saved products using the cart. Clearing this site’s browser storage also removes your cart.</p>');
    if(action==='terms')information('Terms of use','<p>Only products and sizes enabled for checkout can be ordered. The cart shows the amount to confirm in WeChat. Other products and prices are design previews.</p><p>Generated product images show design concepts. This preview is not an OpenAI storefront and is not affiliated with OpenAI.</p>');
  });
  document.addEventListener('change',event=>{if(event.target.matches('input[name=size]')){selectedSize=event.target.value;$('#size-error').textContent='';}});
  document.addEventListener('input',event=>{if(event.target.id==='product-search')searchResults(event.target.value);});
  $$('dialog').forEach(dialog=>{
    dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss(dialog);});
    let backdropPress=false;
    dialog.addEventListener('pointerdown',event=>{backdropPress=event.target===dialog;});
    dialog.addEventListener('click',event=>{if(event.target===dialog && backdropPress)dismiss(dialog);backdropPress=false;});
  });
  zoomDialog.addEventListener('keydown',event=>{if(event.key==='ArrowRight'){event.preventDefault();showImage(imageIndex+1);}if(event.key==='ArrowLeft'){event.preventDefault();showImage(imageIndex-1);}});
  window.addEventListener('popstate',renderRoute);
  window.addEventListener('hashchange',renderRoute);
  $('#year').textContent=new Date().getFullYear();
  updateCount();
  renderRoute();
  refreshOffers();
  document.body.classList.add('store-ready');
})();
