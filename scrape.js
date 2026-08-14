#!/usr/bin/env node
// scrape.js - ECJ Luxe Collection Inventory Scraper

const https   = require('https');
const fs      = require('fs');

const BASE_URL     = 'https://ecjluxe.com';
const CAT_ID       = 11774;
const PER_PAGE     = 100;
const CACHE_FILE   = 'attribute-cache.json';
const HISTORY_FILE = 'history.json';

function get(url) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'ECJ-Tracker/1.0', 'Accept': '*/*' } };
    https.get(url, opts, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ body: JSON.parse(data), headers: res.headers, status: res.statusCode }); }
        catch(e) { resolve({ body: data, headers: res.headers, status: res.statusCode }); }
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

async function fetchProductDetail(permalink) {
  try {
    const { body: html, status } = await get(permalink);
    if (typeof html !== 'string' || status !== 200) return {};
    const attrs = {};
    // Match all table rows with two cells
    const tableRows = [...html.matchAll(/<tr[^>]*>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)];
    for (const m of tableRows) {
      const key = m[1].replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&#\d+;/g,'').trim();
      const val = m[2].replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&#[^;]+;/g,'').trim();
      if (key && val && key.length < 60) attrs[key] = val;
    }
    return attrs;
  } catch(e) { return {}; }
}

function formatPrice(cents) {
  if (!cents || cents === '0') return '';
  const n = parseInt(cents);
  if (!n) return '';
  return '$' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function extractBrand(categories, name) {
  const brands = ['Rolex','Patek Philippe','Audemars Piguet','AP','Richard Mille','Cartier','Omega',
    'Breitling','IWC','Hublot','Tag Heuer','Panerai','Vacheron Constantin','A. Lange','A. Lange & Sohne',
    'Jaeger-LeCoultre','Seiko','Tudor','Chanel','Bulgari','Bvlgari','Chopard','Montblanc','Longines',
    'Movado','Franck Muller','Girard-Perregaux','Blancpain','Zenith','Bell & Ross','Rado','Tissot'];
  for (const b of brands) {
    if (categories.some(c => c.toLowerCase().includes(b.toLowerCase()))) return b;
    if (name.toLowerCase().includes(b.toLowerCase())) return b;
  }
  const skip = new Set(['Timepieces','Pre-Loved Timepieces','New Timepieces','New Arrivals','SUMMER FUN','Timepieces for Women']);
  const nonGeneric = categories.filter(c => !skip.has(c));
  return nonGeneric[0] || '';
}

// Map various field name formats to standard names
function mapFields(raw) {
  const fieldMap = {
    'Reference Number':    ['Reference Number','Reference #','Ref#','Ref Number','Reference','Item Number'],
    'movement':            ['Movement','Movement Type','Caliber'],
    'caseSize':            ['Case Size','Diameter','Size'],
    'caseMaterial':        ['Case Material','Case'],
    'dialDetails':         ['Dial Details','Dial','Dial Color'],
    'bezelDetails':        ['Bezel Details','Bezel','Bezel Material'],
    'bandMaterial':        ['Band Material','Strap Material','Bracelet Material','Band','Strap'],
    'boxPapers':           ['Box/Papers','Box & Papers','Box and Papers','Papers','Box','Includes'],
    'serialInfo':          ['Serial Info','Serial Number','Serial','Year','Year/Box/Papers'],
    'year':                ['Year','Year of Purchase','Production Year'],
    'description':         ['Additional details','Additional Details','Notes','Condition','Description'],
  };
  const out = {};
  for (const [std, variants] of Object.entries(fieldMap)) {
    for (const v of variants) {
      if (raw[v] !== undefined) { out[std] = raw[v]; break; }
    }
  }
  return out;
}

async function main() {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  console.log('ECJ Luxe Collection — Inventory Snapshot');
  console.log('Timestamp :', now, 'ET');

  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}
  }
  console.log('Cache     :', Object.keys(cache).length, 'products cached');

  let history = {};
  if (fs.existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}
  }

  // Fetch all products
  const { products: firstPage, total } = await fetchPage(1);
  const totalPages = Math.ceil(total / PER_PAGE);
  console.log(`Fetching ${total} timepieces across ${totalPages} pages...`);

  let allProducts = [...firstPage];
  for (let page = 2; page <= totalPages; page++) {
    process.stdout.write('.');
    try {
      const { products } = await fetchPage(page);
      allProducts = allProducts.concat(products);
    } catch(e) { console.log(`\nPage ${page} error: ${e.message}`); }
    await sleep(300);
  }
  console.log(`\nFetched ${allProducts.length} products`);

  const snapshot = {};
  let newCount = 0, fromCache = 0, emptyCache = 0;

  for (const p of allProducts) {
    const sku = p.sku || String(p.id);
    const categories = (p.categories || []).map(c => c.name);
    const brand = extractBrand(categories, p.name);

    // Price — API gives cents as string
    const priceRaw  = p.prices?.price || p.prices?.regular_price || '0';
    const price     = formatPrice(priceRaw);

    // Stock status — use is_in_stock boolean (most reliable field)
    const inStock = p.is_in_stock === true || p.stock_status === 'instock';
    const stockStatus = inStock ? 'In Stock' : 'Out of Stock';

    const image     = p.images?.[0]?.src || '';
    const permalink = p.permalink || '';

    // Get or fetch detail attributes
    let rawDetail = {};
    if (cache[sku] && Object.keys(cache[sku]).length > 0) {
      rawDetail = cache[sku];
      fromCache++;
    } else {
      if (permalink) {
        rawDetail = await fetchProductDetail(permalink);
        cache[sku] = rawDetail;
        if (Object.keys(rawDetail).length > 0) newCount++;
        else emptyCache++;
        await sleep(150);
      }
    }

    const detail = mapFields(rawDetail);

    // Extract year from serialInfo or year field
    let year = detail.year || '';
    if (!year && detail.serialInfo) {
      const m = detail.serialInfo.match(/\b(19|20)\d{2}\b/);
      if (m) year = m[0];
    }

    snapshot[sku] = {
      id:              p.id,
      sku,
      name:            p.name,
      brand,
      referenceNumber: detail['Reference Number'] || rawDetail['Reference Number'] || rawDetail['Reference #'] || '',
      movement:        detail.movement   || '',
      caseSize:        detail.caseSize   || '',
      caseMaterial:    detail.caseMaterial || '',
      dialDetails:     detail.dialDetails  || '',
      bezelDetails:    detail.bezelDetails || '',
      bandMaterial:    detail.bandMaterial || '',
      boxPapers:       detail.boxPapers    || '',
      serialInfo:      detail.serialInfo   || '',
      description:     detail.description  || '',
      categories:      categories.join(', '),
      price,
      regularPrice:    formatPrice(p.prices?.regular_price || '0'),
      salePrice:       p.prices?.sale_price && p.prices.sale_price !== p.prices.regular_price
                         ? formatPrice(p.prices.sale_price) : '',
      stockStatus,
      image,
      permalink,
      year,
    };
  }

  console.log(`From cache: ${fromCache} | Newly fetched: ${newCount} | Empty: ${emptyCache}`);

  const timestamp = new Date().toISOString();
  history[timestamp] = snapshot;

  // Keep last 500 snapshots
  const keys = Object.keys(history).sort();
  if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete history[k]);

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`Saved ${Object.keys(snapshot).length} products`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
