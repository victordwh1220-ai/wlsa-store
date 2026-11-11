'use strict';

(async () => {
  const { categories } = window.storeCatalog;
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    document.querySelector('.store-return-mark').href = 'http://127.0.0.1:3001/';
  }
  const products = [];
  let catalogAvailable = false;
  let catalogLoading = true;
  // Receipt access initializes immediately, independently of catalog availability.
  const catalogRequest = (async () => {
    try {
      const response = await fetch('/api/catalog', { credentials: 'include', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error();
      const current = await response.json();
      const entries = new Map(current.products.map(row => [row.id, row]));
      for (const product of window.storeCatalog.products) {
        const row = entries.get(product.id);
        if (row?.listed) products.push({...product, name: row.name, name_en: row.name_en, price: row.price});
      }
      catalogAvailable = true;
    } catch { /* Existing reservation receipts remain available independently. */ }
    finally { catalogLoading = false; }
  })();
  document.querySelector('.store-tools [data-action=reservations]').disabled = false;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => `¥${n.toFixed(2)}`;
  const assetPath = path => '/' + path;
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
  let placingOrder = false;
  let pendingReservation = null;
  let savedReservations = [];
  let currentReceiptKey = null;
  let reservationDraft = {name: '', contact: '', className: '', note: ''};
  const reservationStorageKey = 'wlsa-reservations-v1';
  const pendingStorageKey = 'wlsa-reservation-pending-v1';
  const validToken = token => typeof token === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(token);
  const cartItems = () => bag.map(({id, size, qty}) => ({productId: id, size, quantity: qty, expectedUnitPrice: byId(id).price}));
  const productPrice = p => p.price;
  const itemCount = () => bag.reduce((total, item) => total + item.qty, 0);
  const statusLabels = {pending: 'Awaiting confirmation · 待确认', confirmed: 'Confirmed · 已确认', ready: 'Ready for pickup · 待自提', collected: 'Collected · 已领取', cancelled: 'Cancelled · 已取消'};
  const pickupNotice = 'Staff will confirm availability, pickup time and location. Confirm the goods and amount on site. No online payment. 预约后由工作人员确认商品、领取时间和地点，现场确认，不在线收款。';
  try {
    const saved = JSON.parse(localStorage.getItem(reservationStorageKey) || '[]');
    if (Array.isArray(saved)) savedReservations = saved.filter(row => row && validToken(row.key)).map(row => ({key: row.key, reference: typeof row.reference === 'string' ? row.reference : ''}));
    const pending = JSON.parse(localStorage.getItem(pendingStorageKey) || 'null');
    if (pending && validToken(pending.key) && Array.isArray(pending.items) && pending.items.length && pending.items.length <= 20 && pending.items.every(item =>
      item && typeof item.productId === 'string' && item.productId.length > 0 && item.productId.length <= 120 && typeof item.size === 'string' && item.size.length > 0 && item.size.length <= 40 && !/[\u0000-\u001f\u007f<>]/u.test(item.productId + item.size) && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 10 && Number.isFinite(item.expectedUnitPrice) && item.expectedUnitPrice >= 0)) pendingReservation = {key: pending.key, items: pending.items.map(({productId, size, quantity, expectedUnitPrice}) => ({productId, size, quantity, expectedUnitPrice}))};
  } catch { /* Browsing remains available with storage disabled. */ }
  try {
    const saved = JSON.parse(localStorage.getItem('wlsa-supply-bag-v1') || '[]');
    if (Array.isArray(saved)) {
      for (const item of saved.slice(0, 50)) {
        if (!item || !window.storeCatalog.products.find(product => product.id === item.id)?.sizes.includes(item.size) || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 10) continue;
        if (itemCount() + item.qty > 50) continue;
        const line = bag.find(line => line.id === item.id && line.size === item.size);
        if (line) line.qty = Math.min(10, line.qty + item.qty);
        else if (bag.length < 20) bag.push({ id: item.id, size: item.size, qty: item.qty });
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
        history.replaceState({},'', '#' + (mainRoute || 'shop/all'));
        renderRoute();
      }
    } else hideDialog(dialog);
  }
  function accordion(id, title, copy) {
    return `<section class="accordion"><h2><button class="accordion-trigger" aria-expanded="false" aria-controls="${id}" id="${id}-trigger" data-action="accordion">${title}<span class="plus-icon" aria-hidden="true"></span></button></h2><div class="accordion-panel" id="${id}" data-open="false" role="region" aria-labelledby="${id}-trigger" aria-hidden="true" inert><div><div class="accordion-copy">${copy}</div></div></div></section>`;
  }
  function card(p,index) {
    return `<a class="product-card" data-product="${p.slug}" href="#product/${p.slug}" aria-label="${esc(p.name_en)}, ${money(productPrice(p))}" style="--delay:${index%3*50}ms;--mobile-delay:${index%2*50}ms"><div class="product-visual"><div class="primary">${image(p,'a',true,index<3)}</div><div class="alternate">${image(p,'b',true,false)}</div></div><div class="product-caption"><h2>${esc(p.name_en.toLowerCase())}</h2><p data-store-price="${esc(p.id)}">${money(productPrice(p))}</p></div></a>`;
  }
  function categoryBar(selected) {
    const links = [{id:'all', en:'Shop all'}, ...categories].map(category => {
      const current = selected === category.id ? 'aria-current="page"' : '';
      return `<a class="category-link" href="#shop/${category.id}" ${current}>${category.en}</a>`;
    });
    return `<nav class="catalog-tabs" aria-label="Product categories">${links.join('')}</nav>`;
  }
  function catalogUnavailable() {
    return catalogLoading
      ? '<p class="empty-results" role="status">Loading products… You can still open My reservations. 正在加载商品，仍可查看我的预约。</p>'
      : '<p class="empty-results" role="alert">The catalog could not be loaded. Existing reservations are still available. 商品暂时无法加载，已提交预约仍可查询。 <button type="button" data-action="reload-catalog">Try again · 重试</button></p>';
  }
  function shop(category) {
    if (!catalogAvailable) return catalogUnavailable();
    const selected = category==='all' || categories.some(c=>c.id===category) ? category : 'tops';
    const list = products.filter(p=>selected==='all'||p.category===selected);
    return `<h1 class="sr-only">${selected==='all'?'All WLSA products':esc(categories.find(c=>c.id===selected).en)}</h1><div class="catalog-layout">${categoryBar(selected)}<div class="product-grid">${list.map(card).join('') || '<p class="empty-results">No listed products.</p>'}</div></div>`;
  }
  const faqs = [
    ['How do campus pickup reservations work?', pickupNotice],
    ['How do I view the other side?', 'Hover over a product to see its second view. Open the product to browse both images. On a phone, swipe the product images from side to side. Select an image to view it full screen.'],
    ['What sizes are available?', 'Select a size on the product page. Availability and final measurements are confirmed by staff before collection.'],
    ['Where can I check my reservation?', 'Open My reservations in the same browser to view the latest status and pickup details. Keep your reference for collection. No automated email or text confirmation is sent.'],
    ['Can I cancel a reservation?', 'Open My reservations and select Cancel reservation before collection. Once marked collected, speak with the staff member who handled pickup.'],
    ['Are the images final production photos?', 'The images are generated visualizations of merchandise concepts. Materials, colors, measurements and availability require staff confirmation.']
  ];
  function editorial(route) {
    if(route==='faq')return `<div class="editorial faq-page"><h1>Frequently asked questions.</h1>${faqs.map(([q,a],i)=>accordion('faq-'+i,q,`<p>${a}</p>`)).join('')}</div>`;
    return `<div class="editorial"><h1>WLSA Store</h1><p class="lede">Campus pickup reservations · 校内自提预约</p><p>${pickupNotice}</p><p class="muted">Product images are design visualizations. Check your reservation for the details confirmed by staff.</p><p><a class="pill white" href="#shop/all">View products ↗</a></p></div>`;
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
    let route=location.hash.slice(1)||'shop/all';
    if(route==='collections'){
      route='shop/all';
      history.replaceState({},'', '#'+route);
    }
    if(route==='shop-main'){main.focus();return;}
    hideDialog(cartDialog,true);
    hideDialog(infoDialog,true);
    if(route.startsWith('product/')) {
      if(!catalogAvailable){hideDialog(productDialog);renderBase('shop/all');return;}
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
    const background=mainRoute||'shop/all';
    hideDialog(infoDialog,true);
    hideDialog(cartDialog,true);
    if(trigger?.isConnected)trigger.focus({preventScroll:true});
    navigate('product/'+slug,{background,fromStore:true});
  }
  function cartLine(item, i) {
    const p = byId(item.id);
    const sku = esc(p.slug);
    const name = esc(p.name_en);
    const locked = pendingReservation || placingOrder;
    return `<article class="cart-row"><a href="#product/${sku}" data-product="${sku}" aria-label="${name}">${image(p, 'a', true, true)}</a>
      <div><div class="cart-item-heading"><a href="#product/${sku}" data-product="${sku}">${name}</a><span>${money(p.price * item.qty)}</span></div>
      <p class="cart-item-size">${esc(item.size)}</p>
      <div class="quantity-row"><button data-action="quantity" data-index="${i}" data-delta="-1" aria-label="Decrease ${name} quantity" ${locked ? 'disabled' : ''}>−</button>
      <span aria-label="Quantity ${item.qty}">${item.qty}</span><button data-action="quantity" data-index="${i}" data-delta="1" aria-label="Increase ${name} quantity" ${locked || item.qty === 10 || itemCount() >= 50 ? 'disabled' : ''}>+</button>
      <button class="remove-item" data-action="remove" data-index="${i}" ${locked ? 'disabled' : ''}>Remove</button></div></div></article>`;
  }
  function renderCart() {
    if (!catalogAvailable) return;
    const total = bag.reduce((sum, item) => sum + Math.round(byId(item.id).price * 100) * item.qty, 0);
    $('#cart-content').innerHTML = `<h2 id="cart-title">Shopping cart</h2>
      <div class="cart-items">${bag.length ? bag.map(cartLine).join('') : '<p class="empty-cart">Your cart is empty</p>'}</div>
      <div class="cart-bottom"><p class="subtotal"><span>Estimated total · 预计金额</span><span>${money(total / 100)}</span></p>
      <button class="checkout-button" data-action="checkout" ${placingOrder || (!bag.length && !pendingReservation) ? 'disabled' : ''}>${placingOrder ? 'Checking…' : pendingReservation ? 'Resume reservation · 继续预约' : 'Reserve for pickup · 预约自提'}</button>
      <p class="cart-note">${pendingReservation ? 'Check your pending submission before changing this cart. 请先查询上次提交的结果。' : pickupNotice}</p></div>`;
  }
  function showCart() { if (!catalogAvailable) {information('Products · 商品', catalogUnavailable());return;} renderCart(); showDialog(cartDialog); }
  function persistReservations() {
    localStorage.setItem(reservationStorageKey, JSON.stringify(savedReservations));
    if (pendingReservation) localStorage.setItem(pendingStorageKey, JSON.stringify(pendingReservation));
    else localStorage.removeItem(pendingStorageKey);
  }
  function newReservationKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function reservationRequest(action, key, extra = {}) {
    const response = await fetch('/api/reservations', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action, key, ...extra}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000)
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || 'The reservation service is unavailable. Please retry.');
      error.status = response.status;
      throw error;
    }
    if (!result.reservation || !statusLabels[result.reservation.status] || !Array.isArray(result.reservation.items)) throw new Error('The reservation could not be verified. Check again.');
    return result.reservation;
  }
  function rememberReservation(key, reservation) {
    reservationDraft = {name: '', contact: '', className: '', note: ''};
    const entry = savedReservations.find(row => row.key === key);
    if (entry) entry.reference = reservation.reference;
    else savedReservations.unshift({key, reference: reservation.reference});
    if (pendingReservation?.key === key) {
      // Only remove the submitted quantities, preserving any later cart additions.
      for (const item of pendingReservation.items) {
        const line = bag.find(row => row.id === item.productId && row.size === item.size);
        if (line) line.qty -= item.quantity;
      }
      bag = bag.filter(row => row.qty > 0);
      pendingReservation = null;
      saveBag();
    }
    try { persistReservations(); } catch { announce('Keep your reservation reference. Browser storage is unavailable.'); }
    if (cartDialog.open) renderCart();
  }
  function itemSummary(items) {
    return `<ul class="reservation-items">${items.map(item => `<li><span>${esc(item.name_en || byId(item.productId)?.name_en || item.productId)}<small>${esc(item.size)} × ${item.quantity}</small></span><span>${money((item.unitPrice ?? item.expectedUnitPrice) * item.quantity)}</span></li>`).join('')}</ul>`;
  }
  function showReservationForm(message = '') {
    if (!catalogAvailable) {information('Reservation · 预约', `<p>${esc(message)}</p>${catalogUnavailable()}<button class="checkout-button" data-action="reservations">My reservations · 我的预约</button>`);return;}
    const items = pendingReservation?.items || cartItems();
    if (!items.length) { showCart(); return; }
    const total = items.reduce((sum, item) => sum + Math.round(item.expectedUnitPrice * 100) * item.quantity, 0) / 100;
    information('Campus pickup · 校内自提', `<p class="reservation-notice">${pickupNotice}</p>${itemSummary(items)}
      <p class="subtotal"><span>Estimated total</span><span>${money(total)}</span></p>
      <form id="reservation-form" class="reservation-form">
        <label for="reservation-name">Name · 姓名<input id="reservation-name" name="name" autocomplete="name" maxlength="80" required></label>
        <label for="reservation-contact">Phone or email · 手机或邮箱<input id="reservation-contact" name="contact" autocomplete="email" maxlength="120" required aria-describedby="reservation-contact-help"></label>
        <small id="reservation-contact-help">Used by staff to arrange pickup. 仅用于联系确认自提。</small>
        <label for="reservation-class">Class · 班级（选填）<input id="reservation-class" name="className" maxlength="40"></label>
        <label for="reservation-note">Note · 备注（选填）<textarea id="reservation-note" name="note" rows="3" maxlength="300"></textarea></label>
        <p class="reservation-error" id="reservation-error" role="alert">${esc(message)}</p>
        <button type="submit" class="checkout-button">Submit reservation · 提交预约</button>
        <p class="cart-note">Submitting shares these details with Store staff for this reservation. No automated message is sent. You can check its status in My reservations on this browser. 提交信息仅用于本次预约，请在本浏览器“我的预约”查看进度。</p>
      </form>`);
    for (const name of ['name', 'contact', 'className', 'note']) $('#reservation-form').elements.namedItem(name).value = reservationDraft[name];
    $('#reservation-name').focus({preventScroll: true});
  }
  async function startCheckout() {
    if (placingOrder) return;
    if (!pendingReservation) { showReservationForm(); return; }
    placingOrder = true;
    renderCart();
    information('Your reservation · 我的预约', '<p role="status">Checking your previous submission… 正在查询上次提交…</p>');
    try {
      const reservation = await reservationRequest('lookup', pendingReservation.key);
      const key = pendingReservation.key;
      rememberReservation(key, reservation);
      showReceipt(key, reservation);
    } catch (error) {
      if (error.status === 404) showReservationForm('No reservation was found. Re-enter your details to retry the same request. 未查到预约，请重新填写信息后重试。');
      else information('Check reservation · 查询预约', `<p role="alert">${esc(error.message || 'Connection interrupted. Please try again.')}</p><p>Your request is saved. Check this submission before starting another. 上次请求已保留，请先查询结果。</p><button class="checkout-button" data-action="checkout">Check again · 再次查询</button>`);
    } finally {
      placingOrder = false;
      renderCart();
    }
  }
  async function submitReservation(form) {
    if (placingOrder || !form.reportValidity()) return;
    const values = new FormData(form);
    const cleanText = value => value.trim().replace(/\s+/g, ' ');
    const customer = {name: cleanText(values.get('name')), contact: cleanText(values.get('contact')), className: cleanText(values.get('className'))};
    reservationDraft = {...customer, note: cleanText(values.get('note'))};
    const errorNode = $('#reservation-error', form);
    const contactValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.contact) || (/^[+()\d\s-]+$/.test(customer.contact) && customer.contact.replace(/\D/g, '').length >= 7 && customer.contact.replace(/\D/g, '').length <= 20);
    if (!customer.name || !contactValid) { errorNode.textContent = 'Enter your name and a valid phone number or email. 请填写姓名及有效手机号码或邮箱。'; $('#reservation-contact', form).focus(); return; }
    const priorPending = pendingReservation;
    try {
      if (!pendingReservation) pendingReservation = {key: newReservationKey(), items: cartItems()};
      persistReservations();
    } catch {
      pendingReservation = priorPending;
      errorNode.textContent = 'Enable browser storage to save a private receipt before submitting. 请允许浏览器存储，以便安全保存预约凭证。';
      return;
    }
    placingOrder = true;
    const pending = pendingReservation;
    errorNode.textContent = '';
    form.setAttribute('aria-busy', 'true');
    for (const control of form.elements) control.disabled = true;
    const button = $('button[type=submit]', form);
    button.textContent = 'Submitting… 正在提交…';
    renderCart();
    try {
      const reservation = await reservationRequest('create', pending.key, {customer, items: pending.items, note: cleanText(values.get('note'))});
      rememberReservation(pending.key, reservation);
      showReceipt(pending.key, reservation);
      announce('Reservation submitted. Awaiting staff confirmation. 预约已提交，等待工作人员确认。');
    } catch (error) {
      let recovered = null;
      let definitelyAbsent = false;
      if ([400, 409, 422, 429].includes(error.status)) {
        // A previous attempt may have completed while this retry was being filled.
        // Recover the original receipt before allowing a different request key.
        try { recovered = await reservationRequest('lookup', pending.key); }
        catch (lookupError) { definitelyAbsent = lookupError.status === 404; }
      }
      if (recovered) {
        rememberReservation(pending.key, recovered);
        showReceipt(pending.key, recovered);
      } else if (definitelyAbsent) {
        pendingReservation = null;
        try { persistReservations(); } catch { /* The same key remains safe to recover. */ }
        if (error.status === 409) {
          information('Review your selection · 核对商品', `<p role="alert">${esc(error.message)}</p><p>Refresh the catalog to review current prices and availability before submitting again. 请刷新后核对价格及上下架状态。</p><button class="checkout-button" data-action="reload-catalog">Refresh catalog · 刷新商品</button>`);
        } else if (errorNode.isConnected) errorNode.textContent = error.message;
      } else {
        information('Check your submission · 查询提交结果', `<p role="alert">${esc(error.message || 'Connection interrupted. The result has not been confirmed.')}</p><p>Your request is saved. Check again to avoid a duplicate reservation. 请求已保存，再次查询可避免重复预约。</p><button class="checkout-button" data-action="checkout">Check reservation · 查询预约</button>`);
      }
    } finally {
      placingOrder = false;
      form.removeAttribute('aria-busy');
      for (const control of form.elements) control.disabled = false;
      button.textContent = 'Submit reservation · 提交预约';
      renderCart();
    }
  }
  function showReceipt(key, reservation) {
    hideDialog(cartDialog, true);
    hideDialog(productDialog, true);
    if (location.hash.startsWith('#product/')) history.replaceState({}, '', '#' + (mainRoute || 'shop/all'));
    currentReceiptKey = key;
    information('Reservation · 预约凭证', `<p class="reservation-reference">${esc(reservation.reference)}</p><p class="reservation-status">${esc(statusLabels[reservation.status])}</p>
      <p class="cart-note">Keep this reference for staff. 保存此编号，领取时向工作人员出示。</p>
      ${itemSummary(reservation.items)}<p class="subtotal"><span>Estimated total · 预计金额</span><span>${money(reservation.total)}</span></p>
      <dl class="pickup-details"><dt>Pickup time · 时间</dt><dd>${esc(reservation.pickup?.time || 'Awaiting staff confirmation · 待工作人员确认')}</dd><dt>Pickup location · 地点</dt><dd>${esc(reservation.pickup?.place || 'Awaiting staff confirmation · 待工作人员确认')}</dd>${reservation.staffNote ? `<dt>Staff note · 工作人员备注</dt><dd>${esc(reservation.staffNote)}</dd>` : ''}</dl>
      <p class="cart-note">${pickupNotice}</p><p id="receipt-error" class="reservation-error" role="alert"></p>
      <div class="reservation-actions"><button class="checkout-button" data-action="refresh-reservation">Refresh status · 刷新状态</button><button class="reservation-secondary" data-action="save-receipt">Save receipt · 保存凭证</button>${['pending', 'confirmed', 'ready'].includes(reservation.status) ? '<button class="reservation-secondary" data-action="cancel-reservation">Cancel reservation · 取消预约</button>' : ''}<button class="reservation-secondary" data-action="reservations">My reservations · 我的预约</button></div>`);
    focusReturns.set(infoDialog, $('.store-tools [data-action=reservations]'));
    $('#info-content').dataset.receipt = JSON.stringify({reference: reservation.reference, status: statusLabels[reservation.status], items: reservation.items.map(({name_en, size, quantity, unitPrice}) => ({name: name_en, size, quantity, unitPrice})), total: reservation.total, pickup: reservation.pickup, staffNote: reservation.staffNote});
  }
  async function refreshReceipt(key, cancel = false) {
    if (placingOrder) return;
    placingOrder = true;
    const buttons = $$('button', infoDialog);
    buttons.forEach(button => button.disabled = true);
    try {
      const reservation = await reservationRequest(cancel ? 'cancel' : 'lookup', key);
      rememberReservation(key, reservation);
      showReceipt(key, reservation);
    } catch (error) {
      const errorNode = $('#receipt-error');
      if (errorNode) errorNode.textContent = error.message || 'Could not confirm the update. Refresh status before retrying.';
      else information('Reservation unavailable', `<p role="alert">${esc(error.message)}</p><button class="checkout-button" data-action="reservations">My reservations</button>`);
    } finally {
      placingOrder = false;
      buttons.forEach(button => button.disabled = false);
    }
  }
  async function showReservations() {
    information('My reservations · 我的预约', `<p class="cart-note">Saved on this browser. Keep your reservation reference if you clear browser storage. 记录保存在当前浏览器，清理前请保存预约编号。</p>${pendingReservation ? '<button class="checkout-button" data-action="checkout">Check pending submission · 查询上次提交</button>' : ''}<div class="reservation-list">${savedReservations.length ? savedReservations.map((row, index) => `<button class="saved-reservation" data-action="open-reservation" data-index="${index}"><span>${esc(row.reference || 'Reservation')}</span><span>View status ↗</span></button>`).join('') : '<p>No saved reservations. 暂无预约。</p>'}</div>`);
  }
  function saveReceipt() {
    const data = JSON.parse($('#info-content').dataset.receipt || 'null');
    if (!data) return;
    const lines = ['WLSA Store · Campus pickup reservation', data.reference, data.status, '', ...data.items.map(item => `${item.name} / ${item.size} × ${item.quantity} / ${money(item.unitPrice * item.quantity)}`), '', `Estimated total: ${money(data.total)}`, `Pickup time: ${data.pickup?.time || 'Awaiting confirmation'}`, `Pickup location: ${data.pickup?.place || 'Awaiting confirmation'}`, ...(data.staffNote ? ['Staff note / 工作人员备注: ' + data.staffNote] : []), '', pickupNotice];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], {type: 'text/plain;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = 'WLSA-reservation-' + data.reference.replace(/[^A-Za-z0-9-]/g, '') + '.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function information(title,copy){$('#info-content').removeAttribute('data-receipt');$('#info-content').innerHTML=`<h2 id="info-title">${esc(title)}</h2>${copy}`;$('#info-content').scrollTop=0;showDialog(infoDialog);}
  function showImage(index){imageIndex=(index+2)%2;zoomDialog.classList.remove('zoomed');const side=imageIndex===0?'a':'b';$('#zoom-image').src=assetPath(activeProduct.images[side]);$('#zoom-image').alt=`${activeProduct.name_en} · ${side==='a'?'front view':'alternate view'}`;$('#image-counter').textContent=`${imageIndex+1} / 2`;if(!zoomDialog.open)showDialog(zoomDialog);}
  function searchResults(query) {
    const q=query.trim().toLowerCase();
    const results=q?products.filter(p=>`${p.name} ${p.name_en} ${p.category} ${categories.find(c=>c.id===p.category).name}`.toLowerCase().includes(q)):[];
    $('#search-results').innerHTML=q?(results.length?results.map(p=>`<a class="search-result" href="#product/${p.slug}" data-product="${p.slug}">${image(p,'a',true)}<span>${esc(p.name_en)}<small>${money(productPrice(p))}</small></span></a>`).join(''):'<p class="empty-results">No products found. Try another name or category.</p>'):'<p class="empty-results">Search by product name or category.</p>';
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
      if(pendingReservation || placingOrder){startCheckout();return;}
      if(itemCount()>=50){$('#size-error').textContent='A reservation can contain up to 50 items.';return;}
      if(!selectedSize){$('#size-error').textContent='Please select a size.';$('input[name=size]',productDialog)?.focus();return;}
      const existing=bag.find(i=>i.id===activeProduct.id&&i.size===selectedSize);
      if(!existing && bag.length>=20){$('#size-error').textContent='A reservation can contain up to 20 product and size combinations.';return;}
      if(existing?.qty===10){$('#size-error').textContent='You can save up to 10 of each size.';return;}
      if(existing)existing.qty++;else bag.push({id:activeProduct.id,size:selectedSize,qty:1});
      saveBag();announce(`${activeProduct.name_en}, ${selectedSize}, added to cart.`);showCart();
    }
    if(action==='quantity'||action==='remove'){
      if(pendingReservation || placingOrder)return;
      if(action==='quantity' && Number(control.dataset.delta)>0 && itemCount()>=50)return;
      const i=Number(control.dataset.index);if(!bag[i])return;
      if(action==='remove')bag.splice(i,1);else{bag[i].qty=Math.min(10,bag[i].qty+Number(control.dataset.delta));if(bag[i].qty<1)bag.splice(i,1);}
      saveBag();renderCart();
      const next=$(`.cart-row:nth-child(${Math.min(i+1,bag.length)}) [data-action="quantity"]`,cartDialog)||$('[data-close]',cartDialog);next.focus({preventScroll:true});
      announce(`Cart updated. ${bag.reduce((s,i)=>s+i.qty,0)} items.`);
    }
    if (action === 'checkout') startCheckout();
    if (action === 'reservations') showReservations();
    if (action === 'open-reservation') {
      const key = savedReservations[Number(control.dataset.index)]?.key;
      if (key) { information('Reservation · 预约凭证', '<p role="status">Loading reservation… 正在查询…</p>'); refreshReceipt(key); }
    }
    if (action === 'refresh-reservation' && currentReceiptKey) refreshReceipt(currentReceiptKey);
    if (action === 'cancel-reservation') {
      control.outerHTML = '<div class="reservation-cancel"><p>Cancel this pickup reservation? 确认取消本次预约？</p><button class="reservation-secondary" data-action="confirm-cancel">Yes, cancel reservation · 确认取消</button><button class="reservation-secondary" data-action="refresh-reservation">Keep reservation · 保留预约</button></div>';
      $('[data-action="confirm-cancel"]').focus();
    }
    if (action === 'confirm-cancel' && currentReceiptKey) refreshReceipt(currentReceiptKey, true);
    if (action === 'save-receipt') saveReceipt();
    if (action === 'reload-catalog') location.reload();
    if(action==='view-image')showImage(Number(control.dataset.index));
    if(action==='image-prev')showImage(imageIndex-1);
    if(action==='image-next')showImage(imageIndex+1);
    if(action==='zoom')zoomDialog.classList.toggle('zoomed');
    if(action==='search'){
      information('Search the collection','<label class="sr-only" for="product-search">Search products</label><input class="search-input" id="product-search" type="search" placeholder="Search products" autocomplete="off"><div id="search-results" class="search-results"></div>');searchResults('');$('#product-search').focus();
    }
    if(action==='privacy')information('Privacy · 隐私', '<p>Your name, contact details, optional class and note are shared with Store staff to arrange campus pickup. They are stored privately with the selected items and reservation status. No payment details are collected.</p><p>浏览器仅保存购物车和预约查询凭证，不保存姓名、联系方式或备注。请勿分享当前浏览器的访问权限。清理浏览器存储后，请凭预约编号联系工作人员查询。</p><p>For a correction or removal of your reservation details, contact the Store staff handling your pickup.</p>');
    if(action==='terms')information('Pickup reservations · 自提预约', `<p>${pickupNotice}</p><p>Submitting a reservation does not guarantee stock or place a paid order. Product images are design visualizations. Staff confirm the final product and amount with you on site.</p><p>预约不代表库存保证或已付款订单，商品图片为设计效果图，实物和金额请现场确认。</p>`);
  });
  document.addEventListener('submit', event => { if(event.target.id === 'reservation-form') {event.preventDefault(); submitReservation(event.target);} });
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
  await catalogRequest;
  if (catalogAvailable) {
    // Only a successful catalog response may remove unavailable items from the view.
    // An outage must never overwrite the saved bag with an empty fallback.
    bag = bag.filter(item => byId(item.id)?.sizes.includes(item.size));
    updateCount();
  }
  for (const control of document.querySelectorAll('.store-tools button')) control.disabled = !catalogAvailable && control.dataset.action !== 'reservations';
  const background = mainRoute || 'shop/all';
  mainRoute = '';
  if (infoDialog.open || cartDialog.open) renderBase(background);
  else renderRoute();
  document.querySelector('#store-loading-bar')?.remove();
})();
