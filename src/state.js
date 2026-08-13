// Загрузка, сохранение, миграции и пополнение колоды из deck.seed.json.
// Состояние держим одним объектом в памяти, на диск пишем целиком через db.js.

import * as db from './db.js';

const STATE_KEY = 'state';
const VERSION = 4;

// "es" — показываем испанское, вспоминаем русское (узнавание).
// "ru" — показываем русское, вспоминаем испанское (воспроизведение).
export const DIRS = ['es', 'ru'];

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

// Переименование поля перевода и направления карточки: `<id>|from` → `<id>|to`.
// Прогресс не теряется, потому что переезжает вся запись карточки целиком.
function renameDir(s, from, to) {
  for (const w of s.words || []) {
    if (!w[to]) w[to] = w[from] || '';
    delete w[from];
  }
  const suffix = '|' + from;
  const renamed = {};
  for (const [key, card] of Object.entries(s.cards || {})) {
    renamed[key.endsWith(suffix) ? key.slice(0, -suffix.length) + '|' + to : key] = card;
  }
  s.cards = renamed;
}

// Миграции только вперёд и только достраивающие: ничего не удаляем и не перетираем.
function migrate(raw) {
  const s = raw;

  // Язык перевода менялся: русский → украинский (v3) → снова русский (v4).
  // Обе миграции переименовывают одно и то же поле и одно направление карточки,
  // поэтому пишем их как одну пару взаимно обратных переходов.
  if (!s.v || s.v < 3) renameDir(s, 'ru', 'ua');
  if (s.v < 4) renameDir(s, 'ua', 'ru');
  s.v = VERSION;

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

export function addWord({ es, ru, ex = '', mn = '', pos = '' }) {
  const word = {
    id: 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    es,
    ru,
    ex,
    mn,
    pos,
    cat: '',
    created: now(),
    updated: now(),
    deleted: false,
    // Слово, заведённое руками, репозиторию не принадлежит и обновляться из него не должно.
    edited: true,
  };
  state.words.push(word);
  index.set(word.id, word);
  makeCards(word.id);
  save();
  return word;
}

// Единственный законный способ поменять поля слова. Кроме самой правки помечает слово
// как отредактированное — после этого пополнение колоды его не трогает.
export function updateWord(id, patch) {
  const w = wordById(id);
  if (!w) return null;
  Object.assign(w, patch, { updated: now(), edited: true });
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

// Пометка «есть проблема» — локальная памятка на потом, никуда не отправляется.
// В отличие от updateWord не трогает `edited`: слово всё равно должно чиниться
// пополнением колоды, а не замораживаться из-за жалобы на него.
export function flagWord(id, on) {
  const w = wordById(id);
  if (!w) return;
  w.flagged = !!on;
  w.updated = now();
  save();
}

// ---------------------------------------------------------------------------
// пополнение колоды из репозитория
// ---------------------------------------------------------------------------

// Слово считается нетронутым, пока пользователь его не редактировал.
//
// Флаг явный, а не «created !== updated»: обе метки берутся из Date и при быстром
// редактировании попадают в одну миллисекунду — правка тогда молча теряется
// при следующем пополнении колоды. Такую ошибку почти невозможно заметить.
function isPristine(w) {
  return !w.edited;
}

// Поля, которые приезжают из репозитория. Прогресс и метки сюда не входят.
const SEED_FIELDS = ['es', 'ru', 'ex', 'pos', 'cat'];

// Читаем deck.seed.json и добавляем те id, которых нет локально.
//
// Существующие слова обновляем только если пользователь их не трогал: тогда репозиторий
// остаётся источником правды и опечатка в переводе чинится одним пушем. Как только слово
// отредактировано в приложении, оно замораживается и пополнение его больше не касается.
// Удалённые (tombstone) не воскрешаем — их id тоже считается известным.
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
  let refreshed = 0;

  for (const sw of seed.words) {
    if (!sw || !sw.id) continue;

    const existing = index.get(sw.id);
    if (existing) {
      if (existing.deleted || !isPristine(existing)) continue;
      let changed = false;
      for (const field of SEED_FIELDS) {
        const value = sw[field] || '';
        if (existing[field] !== value) {
          existing[field] = value;
          changed = true;
        }
      }
      // conj — булев признак спряжения (см. pickDistractors в srs.js), а не строка,
      // поэтому идёт отдельно от SEED_FIELDS и их общего `|| ''`.
      const conj = !!sw.conj;
      if (!!existing.conj !== conj) {
        existing.conj = conj;
        changed = true;
      }
      // `updated` не двигаем: слово должно остаться нетронутым и для следующего пополнения.
      if (changed) refreshed++;
      continue;
    }

    const stamp = now();
    const word = {
      id: sw.id,
      es: sw.es || '',
      ru: sw.ru || '',
      ex: sw.ex || '',
      mn: sw.mn || '',
      pos: sw.pos || '',
      cat: sw.cat || '',
      conj: !!sw.conj,
      created: stamp,
      updated: stamp,
      deleted: false,
    };
    state.words.push(word);
    index.set(word.id, word);
    makeCards(word.id);
    added++;
  }

  const cats = JSON.stringify(seed.categories || {});
  const catsChanged = JSON.stringify(state.categories || {}) !== cats;
  if (catsChanged) state.categories = seed.categories || {};

  if (added || refreshed || catsChanged) {
    state.seedVersion = seed.version;
    save();
  }
  return added;
}

// Темы колоды: код → название. Приезжают из deck.seed.json, поэтому переименовать
// тему можно одним пушем, не трогая слова.
export function categories() {
  const known = state.categories || {};
  const used = new Set();
  for (const w of state.words) if (!w.deleted && w.cat) used.add(w.cat);
  return [...used].map((code) => [code, known[code] || code]);
}
