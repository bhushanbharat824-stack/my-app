const CACHE_NAME = 'rajbhasha-qpr-cache-v1';

// ये वो फाइलें हैं जिन्हें हमारा ऐप बिना इंटरनेट के चलाने के लिए सेव (Cache) करेगा
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// 1. Install Event: ऐप इंस्टॉल होते ही फाइलों को सेव करना
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
  self.skipWaiting();
});

// 2. Activate Event: पुरानी फाइलों को हटाकर नई फाइलों को जगह देना
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 3. Fetch Event: जब इंटरनेट न हो, तो सेव की गई (Cached) फाइलें दिखाना
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // अगर फाइल पहले से सेव है, तो तुरंत दिखा दो
        if (response) {
          return response;
        }
        // नहीं तो इंटरनेट से मँगा लो
        return fetch(event.request);
      })
  );
});
