#!/usr/bin/env node
// scrape.js - ECJ Luxe Collection Inventory Scraper
// Fetches all timepieces from ecjluxe.com WooCommerce API

const https = require('https');
const fs    = require('fs');

const BASE_URL    = 'https://ecjluxe.com';
const CAT_ID      = 11774; // Timepieces category
const PER_PAGE    = 100;
const CACHE_FILE  = 'attribute-cache.json';
const HISTORY_FILE = 'history.json';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ECJ-Tracker/1.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ body: JSON.parse(data), headers: res.headers }); }
        catch(e) { resolve({ body: data, headers: res.headers }); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(page) {
  const url = `${BASE_URL}/wp-json/wc/store/products?category=${CAT_ID}&per_page=${PER_PAGE}&page=${page}&status=publish&orderby=date&order=desc`;
  const { body, headers } = await get(url);
  return { products: Array.isArray(body) ? body : [], total: parseInt(headers['x-wp-total'] || 0) };
}

async function fetchProductDetail(slug) {
  try {
    const url = `${BASE_URL}/product/${slug}/`;
    return new Promise((resolve) => {
      https.get(url, { headers: { 'User-Agent': 'ECJ-Tracker/1.0' } }, res => {
        let html = '';
        res.on('data', d => html += d);
        res.on('end', () => {
          const attrs = {};
          // Parse table rows from product description
          const tableRows = html.matchAll(/<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi);
          for (const m of tableRows) {
            const key = m[1].trim();
            const val = m[2].replace(/<[^>]*>/g, '').trim();
            if (key && val) attrs[key] = val;
          }
          resolve(attrs);
        });
      }).on('error', () => resolve({}));
    });
  } catch(e) { return {}; }
}

function formatPrice(cents) {
  if (!cents) return '';
  const dollars = parseInt(cents) / 100;
  return '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function extractBrand(categories) {
  const watchBrands = ['Rolex','Patek Philippe','Audemars Piguet','Richard Mille','Cartier','Omega',
    'Breitling','IWC','Hublot','Tag Heuer','Panerai','Vacheron','A. Lange','Jaeger','Seiko','Tudor',
    'Chanel','Bulgari','Bvlgari','Chopard','Montblanc','Longines','Movado','Franck Muller','Girard'];
  for (const brand of watchBrands) {
    if (categories.some(c => c.toLowerCase().includes(brand.toLowerCase()))) return brand;
  }
  // Fallback: use sub-category that isn't "Timepieces" or "Pre-Loved" or "New Arrivals"
  const nonGeneric = categories.filter(c => !['Timepieces','Pre-Loved Timepieces','New Arrivals','SUMMER FUN'].includes(c));
  return nonGeneric[0] || '';
}

async function main() {
  console.log('ECJ Luxe Collection — Inventory Snapshot');
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  console.log('Timestamp :', now, 'ET');

  // Load cache
  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}
  }
  console.log('Cache     :', Object.keys(cache).length, 'products already stored');

  // Load existing history
  let history = {};
  if (fs.existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}
  }

  // Fetch first page to get total
  const { products: firstPage, total } = await fetchPage(1);
  const totalPages = Math.ceil(total / PER_PAGE);
  console.log(`Fetching ${total} timepieces across ${totalPages} pages...`);

  let allProducts = [...firstPage];
  for (let page = 2; page <= totalPages; page++) {
    process.stdout.write('.');
    const { products } = await fetchPage(page);
    allProducts = allProducts.concat(products);
    await sleep(300);
  }
  console.log(`\nFetched ${allProducts.length} products`);

  // Build snapshot
  const snapshot = {};
  let newCount = 0, fromCache = 0;

  for (const p of allProducts) {
    const sku = p.sku || String(p.id);
    const categories = (p.categories || []).map(c => c.name);
    const brand = extractBrand(categories);
    const price = formatPrice(p.prices?.price);
    const regularPrice = formatPrice(p.prices?.regular_price);
    const salePrice = p.prices?.sale_price && p.prices.sale_price !== p.prices.regular_price
      ? formatPrice(p.prices.sale_price) : '';
    const image = p.images?.[0]?.src || '';
    const stockStatus = p.is_in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';

    // Check cache for detail attributes
    let detail = {};
    if (cache[sku]) {
      detail = cache[sku];
      fromCache++;
    } else {
      const slug = p.slug || p.permalink?.split('/product/')[1]?.replace(/\/$/, '');
      if (slug) {
        detail = await fetchProductDetail(slug);
        cache[sku] = detail;
        newCount++;
        await sleep(200);
      }
    }

    snapshot[sku] = {
      id: p.id,
      sku,
      name: p.name,
      brand,
      referenceNumber: detail['Reference Number'] || '',
      movement: detail['Movement'] || '',
      caseSize: detail['Case Size'] || '',
      caseMaterial: detail['Case Material'] || '',
      dialDetails: detail['Dial Details'] || '',
      bezelDetails: detail['Bezel Details'] || '',
      bandMaterial: detail['Band Material'] || '',
      boxPapers: detail['Box/Papers'] || detail['Papers'] || '',
      serialInfo: detail['Serial Info'] || '',
      categories: categories.join(', '),
      price,
      regularPrice,
      salePrice,
      stockStatus,
      image,
      permalink: p.permalink || '',
      year: detail['Year'] || detail['Serial Info']?.match(/\d{4}/)?.[0] || '',
    };
  }

  console.log(`From cache: ${fromCache} | Newly fetched: ${newCount}`);

  // Add snapshot to history
  const timestamp = new Date().toISOString();
  history[timestamp] = snapshot;

  // Keep only last 500 snapshots to prevent file bloat
  const keys = Object.keys(history).sort();
  if (keys.length > 500) {
    keys.slice(0, keys.length - 500).forEach(k => delete history[k]);
  }

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`Saved ${Object.keys(snapshot).length} products to history.json`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
