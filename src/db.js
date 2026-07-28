// Мини-обёртка над IndexedDB. Одно хранилище "kv", в нём один ключ со всем состоянием.
// Состояние маленькое даже на тысячах слов, поэтому читаем и пишем его целиком —
// это проще и надёжнее, чем раскладывать слова по записям и держать индексы.
//
// Если IndexedDB недоступна (приватный режим, заблокированное хранилище),
// молча спускаемся на localStorage, а оттуда — в память. Приложение продолжает
// работать, но пользователю надо об этом сказать: смотри флаг storageKind.

const DB_NAME = 'palabras';
const DB_VERSION = 1;
const STORE = 'kv';
const LS_PREFIX = 'palabras.';

// "idb" | "ls" | "memory" — что реально используется. Проставляется при первом обращении.
export let storageKind = 'idb';

const memory = new Map();
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB недоступна'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('не удалось открыть IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB заблокирована другой вкладкой'));
  });
  return dbPromise;
}

// Оборачиваем запрос IndexedDB в промис: нативный API событийный, а нам нужен await.
function request(store, run) {
  return new Promise((resolve, reject) => {
    const req = run(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  const t = db.transaction(STORE, 'readonly');
  return request(t.objectStore(STORE), (s) => s.get(key));
}

async function idbSet(key, value) {
  const db = await openDb();
  const t = db.transaction(STORE, 'readwrite');
  await request(t.objectStore(STORE), (s) => s.put(value, key));
  // Ждём коммита транзакции, иначе закрытие вкладки сразу после записи может её потерять.
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('транзакция прервана'));
  });
}

function lsGet(key) {
  const raw = globalThis.localStorage.getItem(LS_PREFIX + key);
  return raw === null ? undefined : JSON.parse(raw);
}

function lsSet(key, value) {
  globalThis.localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
}

export async function get(key) {
  if (storageKind === 'idb') {
    try {
      return await idbGet(key);
    } catch (e) {
      console.warn('IndexedDB недоступна, переходим на localStorage:', e);
      storageKind = 'ls';
    }
  }
  if (storageKind === 'ls') {
    try {
      return lsGet(key);
    } catch (e) {
      console.warn('localStorage недоступен, работаем только в памяти:', e);
      storageKind = 'memory';
    }
  }
  return memory.get(key);
}

export async function set(key, value) {
  if (storageKind === 'idb') {
    try {
      await idbSet(key, value);
      return;
    } catch (e) {
      console.warn('запись в IndexedDB не удалась, переходим на localStorage:', e);
      storageKind = 'ls';
    }
  }
  if (storageKind === 'ls') {
    try {
      lsSet(key, value);
      return;
    } catch (e) {
      console.warn('запись в localStorage не удалась, работаем только в памяти:', e);
      storageKind = 'memory';
    }
  }
  memory.set(key, value);
}
