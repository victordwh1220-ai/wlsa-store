'use strict';

(() => {
  const catalog = window.storeCatalog || { products: [], categories: [] };
  const products = catalog.products || [];
  const categories = catalog.categories || [];
  const $ = (selector) => document.querySelector(selector);
  const money = (value) => `¥${Number(value).toFixed(2)}`;
  const imagePath = (product) => product.images?.a_small || product.images?.a || '';
  const bagCount = () => {
    try {
      return JSON.parse(localStorage.getItem('wlsa-supply-bag-v1') || '[]')
        .reduce((sum, line) => sum + (Number(line?.qty) || 0), 0);
    } catch { return 0; }
  };
  const categoryName = (id) => categories.find((category) => category.id === id)?.en || id;

  $('#today').textContent = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  }).format(new Date());
  $('#category-filter').insertAdjacentHTML('beforeend', categories.map((category) => `<option value="${category.id}">${category.en}</option>`).join(''));
  $('#metrics').innerHTML = [
    ['Products', products.length, 'Catalog items'],
    ['Categories', categories.length, 'Collection groups'],
    ['Bag preview', bagCount(), 'Saved in this browser'],
    ['Orders API', '—', 'Backend connection pending'],
  ].map(([label, value, detail]) => `<article class="metric-card"><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`).join('');

  function renderProducts() {
    const query = $('#product-search').value.trim().toLowerCase();
    const selected = $('#category-filter').value;
    const visible = products.filter((product) => {
      const matchesCategory = selected === 'all' || product.category === selected;
      const haystack = `${product.name_en} ${product.name} ${product.category}`.toLowerCase();
      return matchesCategory && (!query || haystack.includes(query));
    });
    $('#result-count').textContent = `${visible.length} items`;
    $('#product-rows').innerHTML = visible.map((product) => `<tr>
      <td><div class="product-cell"><img src="${imagePath(product)}" alt=""><span><strong>${product.name_en}</strong><small>${product.name}</small></span></div></td>
      <td>${categoryName(product.category)}</td>
      <td>${money(product.price)}</td>
      <td>${product.sizes.length} options</td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty-row">No products match this filter.</td></tr>';
  }
  $('#category-list').innerHTML = categories.map((category) => {
    const count = products.filter((product) => product.category === category.id).length;
    return `<div class="category-row"><span>${category.en}</span><strong>${count}</strong></div>`;
  }).join('');
  $('#product-search').addEventListener('input', renderProducts);
  $('#category-filter').addEventListener('change', renderProducts);
  renderProducts();
})();
