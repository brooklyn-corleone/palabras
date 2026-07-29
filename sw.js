// Service worker: оболочка из кэша, колода из сети.
//
// Версию кэша поднимать руками при изменении списка файлов — старые кэши
// вычищаются в activate.
//
// skipWaiting здесь обязателен. Без него новый воркер стоит в очереди, пока не
// закроются все вкладки со старым, — а на телефоне вкладка не закрывается неделями.
// Получается худший из вариантов: оболочка старая (она из кэша), а колода свежая
// (она по сети), и приложение работает по старым правилам с новыми данными.
// Именно так «не работал» множественный выбор — код был прошлой версии.
//
// Страница после смены воркера сама перезагружается, см. ui.js: модули в памяти
// должны совпасть с тем, что воркер теперь отдаёт.

const CACHE = 'palabras-v8';

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'src/db.js',
  'src/dom.js',
  'src/notes.js',
  'src/srs.js',
  'src/state.js',
  'src/ui.js',
  'src/modes/choice.js',
  'src/modes/flip.js',
  'src/modes/letters.js',
  'src/modes/match.js',
  'src/modes/type.js',
  'deck.seed.json',
  'notes.seed.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Колода и правила — единственный канал пополнения из репозитория. Отдай их из кэша,
// и новое не доедет никогда, поэтому здесь сеть в приоритете.
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok && new URL(request.url).origin === self.location.origin) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    // Переход по адресу без сети — отдаём оболочку, дальше приложение справится само.
    if (request.mode === 'navigate') {
      const shell = await caches.match('index.html');
      if (shell) return shell;
    }
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // чужие адреса не наше дело

  if (url.pathname.endsWith('/deck.seed.json') || url.pathname.endsWith('/notes.seed.json')) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});
