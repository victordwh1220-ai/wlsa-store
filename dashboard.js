'use strict';
(() => {
  const { products, categories } = window.storeCatalog;
  const $ = selector => document.querySelector(selector);
  const formatMoney = value => `¥${Number(value).toFixed(2)}`;
  const state = { query: '', category: '' };
  const categoryById = new Map(categories.map(category => [category.id, category]));
  const setStatus = text => { $('#dashboard-status').textContent = text; };
  const filtered = () => products.filter(product => {
    const category = categoryById.get(product.category);
    const haystack = `${product.name_en} ${product.name} ${category?.en || ''}`.toLowerCase();
    return (!state.query || haystack.includes(state.query)) && (!state.category || product.category === state.category);
  });
  function renderStats() {
    $('#stat-products').textContent = products.length;
    $('#stat-categories').textContent = categories.length;
    $('#stat-images').textContent = products.length * 4;
    $('#stat-state').textContent = 'Ready';
  }
  function renderRows() {
    const rows = filtered();
    $('#result-count').textContent = `${rows.length} of ${products.length} products`;
    $('#catalog-rows').innerHTML = rows.map(product => {
      const category = categoryById.get(product.category);
      return `<tr><td><span class="product-name">${product.name_en}</span><span class="product-cn">${product.name}</span></td><td>${category?.en || product.category}</td><td class="mono">${formatMoney(product.price)}</td><td class="mono">${product.sizes.join(', ')}</td><td><span class="status">4 views</span></td><td><a class="row-link" href="index.html#product/${product.slug}">Open ↗</a></td></tr>`;
    }).join('');
    setStatus(`${rows.length} products shown`);
  }
  function exportCsv() {
    const header = ['id','name_en','name_zh','category','price','sizes','slug'];
    const lines = [header, ...products.map(product => [product.id, product.name_en, product.name, product.category, product.price, product.sizes.join('|'), product.slug])]
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(','));
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'wlsa-store-catalog.csv'; link.click(); URL.revokeObjectURL(url);
    setStatus('Catalog CSV exported');
  }
  categories.forEach(category => $('#category-filter').insertAdjacentHTML('beforeend', `<option value="${category.id}">${category.en}</option>`));
  $('#product-search').addEventListener('input', event => { state.query = event.target.value.trim().toLowerCase(); renderRows(); });
  $('#category-filter').addEventListener('change', event => { state.category = event.target.value; renderRows(); });
  $('#export-csv').addEventListener('click', exportCsv);
  renderStats(); renderRows();
})();
