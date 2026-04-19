// Signal PWA — Service Worker v1.0
// Handles: caching, background periodic sync, push notifications, missed signal storage

const CACHE_NAME = 'signal-v1';
const CACHE_FILES = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

// ── INSTALL: cache app shell ──────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_FILES))
  );
  self.skipWaiting();
});

// ── ACTIVATE: clean old caches ────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── FETCH: serve from cache, fallback to network ─────────────────────────────
self.addEventListener('fetch', e => {
  // Only cache same-origin requests (not API calls)
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── BACKGROUND SYNC: triggered by app when going to background ───────────────
self.addEventListener('sync', e => {
  if (e.tag === 'market-scan') {
    e.waitUntil(doBackgroundScan());
  }
});

// ── PERIODIC BACKGROUND SYNC: runs every ~15 min when supported ──────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'market-scan-periodic') {
    e.waitUntil(doBackgroundScan());
  }
});

// ── PUSH: receive server-sent push (future upgrade path) ─────────────────────
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Signal Alert', {
      body: data.body || 'A signal has been detected.',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: data.tag || 'signal',
      renotify: true,
      requireInteraction: true,
      data: { url: './index.html' }
    })
  );
});

// ── NOTIFICATION CLICK: open app when notification is tapped ─────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus existing window if open
      for (const client of list) {
        if (client.url.includes('index.html') && 'focus' in client) {
          return client.focus();
        }
      }
      // Open new window
      if (clients.openWindow) return clients.openWindow('./index.html');
    })
  );
});

// ── BACKGROUND SCAN ENGINE ────────────────────────────────────────────────────
// Runs independently of the UI. Reads config from IndexedDB, fetches prices,
// runs strategy logic, stores missed signals, fires notifications.

const INSTRUMENTS = {
  GBPUSD: { label:'GBP/USD', icon:'💷', dp:4, twelveSymbol:'GBP/USD', alphaFrom:'GBP', alphaTo:'USD' },
  USDJPY: { label:'USD/JPY', icon:'💴', dp:2, twelveSymbol:'USD/JPY', alphaFrom:'USD', alphaTo:'JPY' },
  XAUUSD: { label:'XAU/USD', icon:'🥇', dp:2, twelveSymbol:'XAU/USD', alphaFrom:'XAU', alphaTo:'USD' },
  BTCUSD: { label:'BTC/USD', icon:'₿',  dp:0, twelveSymbol:'BTC/USD', alphaCrypto:'BTC', alphaMarket:'USD' },
};
const PAIRS = Object.keys(INSTRUMENTS);
const RSI_P=6, OB=70, OS=30, EF=100, ES=200;
const TRADE_START=3, TRADE_END=18;
const COOL_MS = 5 * 60 * 1000; // 5 min between repeat alerts per pair

async function doBackgroundScan() {
  const hour = new Date().getHours();
  if (hour < TRADE_START || hour >= TRADE_END) return; // outside window

  // Read config from IndexedDB
  const cfg = await readConfig();
  if (!cfg || !cfg.apiKey || cfg.demoMode) return; // no key — can't scan

  for (const pair of PAIRS) {
    try {
      const m15 = await bgFetch(pair, '15min', 250, cfg);
      const m15r = analyzeM15(m15, pair);
      if (!m15r.buyReady && !m15r.sellReady) continue;

      // M15 conditions pass — now check M1
      const m1 = await bgFetch(pair, '1min', 60, cfg);
      const m1r = analyzeM1(m1, m15r);
      const type = m1r.buySignal ? 'BUY' : m1r.sellSignal ? 'SELL' : null;
      if (!type) continue;

      // Check cooldown
      const lastKey = `last_${pair}_${type}`;
      const lastTime = cfg.lastAlerted?.[lastKey] || 0;
      if (Date.now() - lastTime < COOL_MS) continue;

      // Save signal to missed history
      const signal = { type, pair, time: new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), fromBg: true };
      await saveSignal(signal);

      // Update cooldown
      await saveLastAlerted(lastKey);

      const ins = INSTRUMENTS[pair];
      const emoji = type === 'BUY' ? '🟢' : '🔴';
      await self.registration.showNotification(`${emoji} ${type} — ${ins.label}`, {
        body: type === 'BUY'
          ? `All 6 conditions met. Uptrend on M15, RSI oversold on M15+M1, higher low + higher high (body). Consider LONG.`
          : `All 6 conditions met. Downtrend on M15, RSI overbought on M15+M1, lower high + lower low (body). Consider SHORT.`,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: pair + '_' + type,
        renotify: true,
        requireInteraction: true,
        vibrate: [200, 100, 200, 100, 400],
        data: { url: './index.html', signal }
      });
    } catch (err) {
      console.warn('[SW] Scan error for', pair, err.message);
    }
  }
}

// ── FETCH HELPERS (SW context — no DOM) ──────────────────────────────────────
async function bgFetch(pair, interval, count, cfg) {
  if (cfg.provider === 'alpha') return bgFetchAlpha(pair, interval, count, cfg.apiKey);
  return bgFetchTwelve(pair, interval, count, cfg.apiKey);
}

async function bgFetchTwelve(pair, interval, count, apiKey) {
  const sym = encodeURIComponent(INSTRUMENTS[pair].twelveSymbol);
  const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=${interval}&outputsize=${count}&apikey=${apiKey}&format=JSON`;
  const j = await (await fetch(url, { signal: AbortSignal.timeout(14000) })).json();
  if (j.status === 'error') throw new Error(j.message);
  if (!j.values?.length) throw new Error('No data');
  return j.values.reverse().map(c => ({ open:+c.open, high:+c.high, low:+c.low, close:+c.close }));
}

async function bgFetchAlpha(pair, interval, count, apiKey) {
  const ins = INSTRUMENTS[pair];
  const av = interval === '1min' ? '1min' : '15min';
  let url;
  if (pair === 'BTCUSD') {
    url = `https://www.alphavantage.co/query?function=CRYPTO_INTRADAY&symbol=${ins.alphaCrypto}&market=${ins.alphaMarket}&interval=${av}&outputsize=full&apikey=${apiKey}`;
  } else {
    url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${ins.alphaFrom}&to_symbol=${ins.alphaTo}&interval=${av}&outputsize=full&apikey=${apiKey}`;
  }
  const j = await (await fetch(url, { signal: AbortSignal.timeout(18000) })).json();
  const key = pair === 'BTCUSD' ? `Time Series Crypto (${av})` : `Time Series FX (${av})`;
  if (!j[key]) throw new Error((j['Note'] || j['Information'] || 'API error').slice(0, 100));
  return Object.entries(j[key]).sort((a,b)=>a[0].localeCompare(b[0])).slice(-count)
    .map(([,v])=>({ open:+v['1. open'], high:+v['2. high'], low:+v['3. low'], close:+v['4. close'] }));
}

// ── INDICATORS ────────────────────────────────────────────────────────────────
function ema(d, p) {
  const k=2/(p+1); let e=d[0]; const r=[e];
  for (let i=1;i<d.length;i++){e=d[i]*k+e*(1-k);r.push(e);}
  return r;
}
function rsi(d, p) {
  if (d.length < p+1) return Array(d.length).fill(50);
  const r=Array(p).fill(50); let g=0,l=0;
  for (let i=1;i<=p;i++){const x=d[i]-d[i-1];x>=0?g+=x:l-=x;}
  let ag=g/p,al=l/p; r.push(al===0?100:100-100/(1+ag/al));
  for (let i=p+1;i<d.length;i++){
    const x=d[i]-d[i-1],gx=x>0?x:0,lx=x<0?-x:0;
    ag=(ag*(p-1)+gx)/p; al=(al*(p-1)+lx)/p;
    r.push(al===0?100:100-100/(1+ag/al));
  }
  return r;
}
function analyzeM15(m15, pair) {
  const c=m15.map(x=>x.close), e100=ema(c,EF), e200=ema(c,ES), r15=rsi(c,RSI_P);
  const n=m15.length-1, price=c[n], e1=e100[n], e2=e200[n], rv=r15[n], lc=m15[n];
  const bull=price>e1&&price>e2, bear=price<e1&&price<e2;
  const os=rv<OS, ob=rv>OB, green=lc.close>lc.open, red=lc.close<lc.open;
  return { price, e1, e2, rv, bull, bear, os, ob, green, red, buyReady:bull&&os&&green, sellReady:bear&&ob&&red };
}
function analyzeM1(m1, m15r) {
  const c=m1.map(x=>x.close), r1=rsi(c,RSI_P);
  const n=m1.length-1, rv=r1[n], cur=m1[n], prv=m1[n-1];
  const cBL=Math.min(cur.open,cur.close), pBL=Math.min(prv.open,prv.close);
  const cBH=Math.max(cur.open,cur.close), pBH=Math.max(prv.open,prv.close);
  const hl=cBL>pBL, hh=cur.close>prv.close&&cur.close>cur.open;
  const lh=cBH<pBH, ll=cur.close<prv.close&&cur.close<cur.open;
  const m1os=rv<OS, m1ob=rv>OB;
  return { rv, m1os, m1ob, hl, hh, lh, ll,
    buySignal: m15r.buyReady&&m1os&&hl&&hh,
    sellSignal: m15r.sellReady&&m1ob&&lh&&ll
  };
}

// ── INDEXEDDB HELPERS ─────────────────────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('SignalDB', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('signals')) {
        const s = db.createObjectStore('signals', { keyPath: 'id', autoIncrement: true });
        s.createIndex('time', 'time');
      }
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}
async function readConfig() {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('config', 'readonly');
      const req = tx.objectStore('config').get('app');
      req.onsuccess = () => res(req.result?.value || null);
      req.onerror = () => rej(req.error);
    });
  } catch(e) { return null; }
}
async function saveSignal(signal) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('signals', 'readwrite');
    tx.objectStore('signals').add({ ...signal, savedAt: Date.now() });
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function saveLastAlerted(key) {
  const db = await openDB();
  const cfg = await readConfig() || {};
  cfg.lastAlerted = cfg.lastAlerted || {};
  cfg.lastAlerted[key] = Date.now();
  return new Promise((res, rej) => {
    const tx = db.transaction('config', 'readwrite');
    tx.objectStore('config').put({ key: 'app', value: cfg });
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
