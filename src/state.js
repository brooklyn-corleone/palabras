// Загрузка, сохранение, миграции и пополнение колоды из deck.seed.json.
// Состояние держим одним объектом в памяти, на диск пишем целиком через db.js.

import * as db from './db.js';

const STATE_KEY = 'state';
const VERSION = 3;

// "es" — показываем испанское, вспоминаем украинское (узнавание).
// "ua" — показываем украинское, вспоминаем испанское (воспроизведение).
export const DIRS = ['es', 'ua'];

export let state = null;

// ---------------------------------------------------------------------------
// даты
// ---------------------------------------------------------------------------
// Считаем по местному времени, а не по UTC: иначе у пользователя восточнее Гринвича
// вечером наступает «завтра» и карточки приходят на повтор раньше срока.

function pad(n) {
  return String(n).padStart(2, '0');
}

function iso(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function today() {
  return iso(new Date());
}

export function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
}

export function now() {
  return new Date().toISOString();
}

function uuid() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  // Запасной вариант для старых движков и не-https контекстов.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// индекс слов
// ---------------------------------------------------------------------------

let index = new Map();

function reindex() {
  index = new Map(state.words.map((w) => [w.id, w]));
}

export function wordById(id) {
  return index.get(id) || null;
}

// Живые слова — без удалённых. Tombstone остаётся в words навсегда,
// иначе слово воскреснет из deck.seed.json или с другого устройства.
export function activeWords() {
  return state.words.filter((w) => !w.deleted);
}

export function cardKey(wordId, dir) {
  return wordId + '|' + dir;
}

export function parseKey(key) {
  const i = key.lastIndexOf('|');
  return { wordId: key.slice(0, i), dir: key.slice(i + 1) };
}

// Карточка живая, если слово существует и не удалено.
export function isLiveKey(key) {
  const w = wordById(parseKey(key).wordId);
  return !!w && !w.deleted;
}

// ---------------------------------------------------------------------------
// создание и миграции
// ---------------------------------------------------------------------------

function freshState() {
  return {
    v: VERSION,
    deviceId: uuid(),
    words: [],
    cards: {},
    settings: { theme: 'auto', goal: 20 },
    stats: { day: today(), done: 0 },
  };
}

// Миграции только вперёд и только достраивающие: ничего не удаляем и не перетираем.
function migrate(raw) {
  const s = raw;

  // v2 → v3: язык перевода сменился с русского на украинский. Поле `ru` у слова стало `ua`,
  // направление карточки "…|ru" стало "…|ua". Переименовываем, прогресс сохраняем.
  if (!s.v || s.v < 3) {
    for (const w of s.words || []) {
      if (!w.ua) w.ua = w.ru || '';
      delete w.ru;
    }
    const renamed = {};
    for (const [key, card] of Object.entries(s.cards || {})) {
      renamed[key.endsWith('|ru') ? key.slice(0, -3) + '|ua' : key] = card;
    }
    s.cards = renamed;
    s.v = VERSION;
  }

  if (!s.deviceId) s.deviceId = uuid();
  if (!Array.isArray(s.words)) s.words = [];
  if (!s.cards || typeof s.cards !== 'object') s.cards = {};
  if (!s.settings) s.settings = {};
  if (!s.settings.theme) s.settings.theme = 'auto';
  if (typeof s.settings.goal !== 'number') s.settings.goal = 20;
  if (!s.stats) s.stats = { day: today(), done: 0 };
  return s;
}

// Новый день — счётчик дневной цели обнуляется. Прогресс по карточкам не трогаем.
function rollDay() {
  if (state.stats.day !== today()) {
    state.stats.day = today();
    state.stats.done = 0;
  }
}

// ---------------------------------------------------------------------------
// загрузка и сохранение
// ---------------------------------------------------------------------------

export async function load() {
  let raw = null;
  try {
    raw = await db.get(STATE_KEY);
  } catch (e) {
    console.warn('не удалось прочитать состояние:', e);
  }
  const storedVersion = raw && typeof raw === 'object' ? raw.v : null;
  state = raw && typeof raw === 'object' ? migrate(raw) : freshState();
  reindex();
  rollDay();

  // Результат миграции сразу закрепляем на диске. Иначе она проигрывается заново при
  // каждом запуске, а любая частичная запись из другого места оставит данные между
  // двумя форматами — ровно так теряются переводы при переименовании поля.
  if (storedVersion !== state.v) save();
}

// Пишем по очереди: два быстрых ответа подряд не должны спорить за одну запись.
let writeChain = Promise.resolve();

export function save() {
  writeChain = writeChain
    .then(() => db.set(STATE_KEY, state))
    .catch((e) => console.warn('не удалось сохранить состояние:', e));
  return writeChain;
}

// ---------------------------------------------------------------------------
// слова
// ---------------------------------------------------------------------------

function makeCards(wordId) {
  for (const dir of DIRS) {
    const key = cardKey(wordId, dir);
    if (state.cards[key]) continue;
    state.cards[key] = { box: 1, due: today(), arch: false, updated: now() };
  }
}

export function addWord({ es, ua, ex = '', mn = '', pos = '' }) {
  const word = {
    id: 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    es,
    ua,
    ex,
    mn,
    pos,
    created: now(),
    updated: now(),
    deleted: false,
  };
  state.words.push(word);
  index.set(word.id, word);
  makeCards(word.id);
  save();
  return word;
}

export function updateWord(id, patch) {
  const w = wordById(id);
  if (!w) return null;
  Object.assign(w, patch, { updated: now() });
  save();
  return w;
}

// Удаление — это tombstone, а не вычёркивание из массива.
export function deleteWord(id) {
  const w = wordById(id);
  if (!w) return;
  w.deleted = true;
  w.updated = now();
  save();
}

// ---------------------------------------------------------------------------
// пополнение колоды из репозитория
// ---------------------------------------------------------------------------

// Читаем deck.seed.json и добавляем только те id, которых нет локально.
// Существующие слова не трогаем: пользователь мог поправить перевод или дописать
// мнемонику. Удалённые (tombstone) не воскрешаем — их id тоже считается известным.
export async function mergeSeed() {
  let seed;
  try {
    const res = await fetch('deck.seed.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    seed = await res.json();
  } catch (e) {
    console.warn('колода из репозитория недоступна, работаем с локальной:', e);
    return 0;
  }
  if (!seed || !Array.isArray(seed.words)) {
    console.warn('deck.seed.json не похож на колоду');
    return 0;
  }

  let added = 0;
  for (const sw of seed.words) {
    if (!sw || !sw.id || index.has(sw.id)) continue;
    const word = {
      id: sw.id,
      es: sw.es || '',
      ua: sw.ua || '',
      ex: sw.ex || '',
      mn: sw.mn || '',
      pos: sw.pos || '',
      created: now(),
      updated: now(),
      deleted: false,
    };
    state.words.push(word);
    index.set(word.id, word);
    makeCards(word.id);
    added++;
  }

  if (added) {
    state.seedVersion = seed.version;
    save();
  }
  return added;
}
