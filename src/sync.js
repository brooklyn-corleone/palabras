// Синхронизация своих устройств через приватный GitHub Gist (спека, раздел 3).
//
// Чей это прогресс, определяет профиль (profiles.js): у каждого свой файл в гисте,
// `palabras-<id профиля>.json`. Токен один на всех — его вставляют на каждом устройстве,
// и все устройства пишут в один приватный гист, каждый профиль в свой файл. Аккаунт
// GitHub нужен одному человеку, второму достаточно выбрать себя при запуске.
//
// Приложение обязано работать без этого модуля: нет токена или нет сети — синхронизация
// тихо пропускается, и всё живёт в IndexedDB, как раньше.
//
// Токен лежит в localStorage отдельно от состояния. Состояние уходит в гист и в файл
// «Скачать колоду», а токену ни там, ни там не место. Токен не логируется: в ошибки
// попадает только код, а не запрос.

import { state, save, now, onSave, reindex } from './state.js';

const API = 'https://api.github.com';
// Файл текущего профиля. Ставится в start() до первой синхронизации.
let file = fileFor('');
const CONFIG_KEY = 'palabras.sync';
const LOG_DAYS = 90; // столько же, сколько хранит журнал srs.js

// Через сколько после последнего ответа отправлять. Десять секунд — компромисс:
// отвечать на каждую карточку запросом незачем, а уйти из приложения, не отправив,
// за это время почти невозможно — уход тоже отправляет сразу.
const DEBOUNCE_MS = 10000;
// Возврат в приложение тянет чужие изменения не чаще раза в минуту: переключение
// между вкладками браузера не должно каждый раз ходить в GitHub.
const PULL_EVERY_MS = 60000;

// ---------------------------------------------------------------------------
// слияние — чистые функции, проверяются в tests/sync.test.js
// ---------------------------------------------------------------------------

// Слияние по `updated`: выигрывает более поздняя правка, по каждой карточке и каждому
// слову отдельно. Last-write-wins здесь честен: человек один и в каждый момент
// занимается на одном устройстве (спека, раздел 3).
//
// Но голое сравнение `updated` теряет прогресс. Карточка, заведённая при первом
// запуске планшета, получает `updated` = момент запуска — позже, чем вчерашний ответ
// на телефоне. Нетронутая карточка победила бы выученную. Поэтому нетронутое не имеет
// веса вовсе (ранг ''), и любая настоящая правка его перебивает.

// Карточку трогали, если её спрашивали (`seen`), убирали в архив, отмечали «уже знаю»,
// поднимали выше первой коробки или сбрасывали руками (`reset`).
export function cardRank(c) {
  if (!c) return null;
  const untouched = !c.seen && !c.arch && c.box === 1 && !c.known && !c.lapses && !c.reset;
  return untouched ? '' : c.updated || '';
}

// Слово трогали, если его правили, удаляли, восстанавливали или помечали «проблема».
// Слово из колоды получает `created` и `updated` одной меткой, и любое действие
// пользователя их разводит. Нетронутые слова между устройствами не спорят: их текст
// всё равно приезжает из deck.seed.json.
export function wordRank(w) {
  if (!w) return null;
  const touched = w.edited || w.deleted || (w.updated && w.updated !== w.created);
  return touched ? w.updated || '' : '';
}

// Журнал по дням пишется каждым устройством отдельно (`logs[deviceId]`): ответы
// с разных устройств — разные ответы, и серия считается по их сумме (fullLog в srs.js).
// Чужой журнал сливается максимумом: счётчики за день у одного устройства только
// растут, а в гисте могла оказаться устаревшая копия, отправленная третьим устройством.
function mergeLog(a, b, from) {
  const out = {};
  for (const log of [a || {}, b || {}]) {
    for (const [d, e] of Object.entries(log)) {
      if (d < from || !e) continue;
      const o = out[d] || (out[d] = { r: 0, w: 0 });
      o.r = Math.max(o.r, e.r || 0);
      o.w = Math.max(o.w, e.w || 0);
      if (e.clear) o.clear = true;
    }
  }
  return out;
}

function logAhead(mine, theirs) {
  for (const [d, e] of Object.entries(mine || {})) {
    const t = (theirs || {})[d];
    if (!t || (e.r || 0) > (t.r || 0) || (e.w || 0) > (t.w || 0) || (e.clear && !t.clear)) return true;
  }
  return false;
}

// Вливает remote в local на месте. Ничего локального не удаляет: слово, которого нет
// в гисте, остаётся и уедет туда следующей отправкой. Удаление — tombstone, и оно
// приезжает как обычная правка слова.
//
// Возвращает { pulled, ahead }: изменилось ли что-то здесь и есть ли у нас то,
// чего нет в гисте, — тогда гист надо переписать.
export function mergeData(local, remote, deviceId, from) {
  let pulled = false;
  let ahead = false;

  const byId = new Map(local.words.map((w, i) => [w.id, i]));
  const remoteIds = new Set();
  for (const rw of remote.words || []) {
    if (!rw || !rw.id) continue;
    remoteIds.add(rw.id);
    const i = byId.get(rw.id);
    if (i === undefined) {
      byId.set(rw.id, local.words.length);
      local.words.push(rw);
      pulled = true;
    } else if (wordRank(rw) > wordRank(local.words[i])) {
      local.words[i] = rw;
      pulled = true;
    } else if (wordRank(local.words[i]) > wordRank(rw)) {
      ahead = true;
    }
  }
  if (local.words.some((w) => !remoteIds.has(w.id))) ahead = true;

  const rc = remote.cards || {};
  for (const [key, card] of Object.entries(rc)) {
    if (!card) continue;
    const mine = local.cards[key];
    if (!mine || cardRank(card) > cardRank(mine)) {
      local.cards[key] = card;
      pulled = true;
    } else if (cardRank(mine) > cardRank(card)) {
      ahead = true;
    }
  }
  if (Object.keys(local.cards).some((key) => !rc[key])) ahead = true;

  const logs = remote.logs || {};
  if (!local.peerLogs) local.peerLogs = {};
  for (const [dev, log] of Object.entries(logs)) {
    if (dev === deviceId) continue;
    const before = local.peerLogs[dev];
    const merged = mergeLog(before, log, from);
    if (logAhead(merged, before)) pulled = true;
    if (logAhead(merged, log)) ahead = true;
    if (Object.keys(merged).length) local.peerLogs[dev] = merged;
    else delete local.peerLogs[dev];
  }
  for (const dev of Object.keys(local.peerLogs)) if (!logs[dev]) ahead = true;
  if (logAhead(local.log, logs[deviceId])) ahead = true;

  return { pulled, ahead };
}

// Что лежит в гисте. Настройки и дневная цель не синхронизируются (спека): длина урока
// и тема — свойство устройства, а не человека.
export function payload(s, from) {
  const logs = {};
  for (const [dev, log] of Object.entries(s.peerLogs || {})) logs[dev] = log;
  logs[s.deviceId] = mergeLog(s.log, null, from);
  return { app: 'palabras', v: s.v, words: s.words, cards: s.cards, logs };
}

// Гист, который мы не узнаём, не трогаем: перезаписать чужой файл хуже, чем не синхронизироваться.
export function parseRemote(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw syncError('format');
  }
  if (!data || data.app !== 'palabras' || !Array.isArray(data.words) || typeof data.cards !== 'object') {
    throw syncError('format');
  }
  return data;
}

// Имя файла профиля в гисте. Без профиля — старое имя, с которого всё начиналось.
export function fileFor(profileId) {
  return profileId ? 'palabras-' + profileId + '.json' : 'palabras.json';
}

// Наш гист — тот, где есть файл любого профиля: на втором устройстве второй человек
// подключается тем же токеном и находит тот же гист, хотя своего файла в нём ещё нет.
export function isOurGist(g) {
  return !!(g && g.files && Object.keys(g.files).some((name) => /^palabras(-[a-z0-9]+)?\.json$/.test(name)));
}

// Пользователь может вставить и ID, и адрес гиста целиком.
export function parseGistId(text) {
  const s = String(text || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  const last = s.split('/').pop().split('#')[0].split('?')[0];
  return /^[0-9a-f]{20,40}$/i.test(last) ? last : null;
}

// ---------------------------------------------------------------------------
// настройка: токен и ID гиста
// ---------------------------------------------------------------------------

function readConfig() {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeConfig(c) {
  try {
    if (c) globalThis.localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
    else globalThis.localStorage.removeItem(CONFIG_KEY);
  } catch (e) {
    // Хранилище заблокировано — синхронизация просто не переживёт перезагрузку.
  }
  config = c;
}

let config = readConfig();

// Для экрана настроек — без токена: интерфейсу достаточно знать, что он есть.
export function status() {
  if (!config || !config.token) return { on: false };
  return {
    on: true,
    gistId: config.gistId,
    lastSyncAt: config.lastSyncAt || null,
    lastError: config.lastError || null,
    running: !!running,
  };
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

function syncError(code) {
  const e = new Error('sync: ' + code);
  e.code = code;
  return e;
}

async function gh(path, token, opts = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...opts,
      // Свежий ответ обязателен: из HTTP-кэша приехал бы гист до последней отправки
      // с другого устройства.
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (e) {
    throw syncError('offline');
  }
  if (res.status === 401) throw syncError('auth');
  if (res.status === 403 || res.status === 429) {
    throw syncError(res.headers.get('x-ratelimit-remaining') === '0' ? 'limit' : 'forbidden');
  }
  if (res.status === 404) throw syncError('missing');
  if (!res.ok) throw syncError('http');
  return res.json();
}

// Больше мегабайта API отдаёт файл обрезанным, и тогда его надо дочитать по raw_url.
// Колода на триста слов весит около ста килобайт, но молча слить половину файла нельзя.
async function readFile(gist) {
  const f = gist.files && gist.files[file];
  if (!f) return null;
  if (!f.truncated) return f.content;
  try {
    const res = await fetch(f.raw_url, { cache: 'no-store' });
    if (!res.ok) throw new Error();
    return await res.text();
  } catch (e) {
    throw syncError('offline');
  }
}

function fromDay() {
  const d = new Date();
  d.setDate(d.getDate() - LOG_DAYS);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function body() {
  // PATCH меняет только перечисленные файлы: файл второго профиля остаётся как был.
  return JSON.stringify({ files: { [file]: { content: JSON.stringify(payload(state, fromDay())) } } });
}

// ---------------------------------------------------------------------------
// одна синхронизация: забрать → слить → отправить, если у нас есть новое
// ---------------------------------------------------------------------------

let running = null;
let again = false;
let quiet = false; // запись, которую сделала сама синхронизация, новой синхронизации не просит
let hooks = { onChange() {}, onStatus() {} };

async function syncOnce() {
  const c = config;
  if (!c || !c.token) return;
  try {
    const gist = await gh('/gists/' + c.gistId, c.token);
    const text = await readFile(gist);
    let res = { pulled: false, ahead: true };
    if (text !== null) res = mergeData(state, parseRemote(text), state.deviceId, fromDay());
    if (res.pulled) {
      reindex();
      quiet = true;
      save();
      quiet = false;
      hooks.onChange();
    }
    if (res.ahead) await gh('/gists/' + c.gistId, c.token, { method: 'PATCH', body: body() });
    writeConfig({ ...config, lastSyncAt: now(), lastError: null });
  } catch (e) {
    if (config) writeConfig({ ...config, lastError: e.code || 'http' });
  }
}

// Одна синхронизация за раз. Попросили во время текущей — проходим ещё раз после неё:
// ответ, данный, пока шёл запрос, иначе ждал бы следующего повода.
export function syncNow() {
  if (!config || !config.token) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    await null; // сначала running присвоится, и onStatus увидит «синхронизирую»
    hooks.onStatus();
    try {
      do {
        again = false;
        await syncOnce();
      } while (again);
    } finally {
      running = null;
      hooks.onStatus();
    }
  })();
  return running;
}

// Подключение. Без ID ищем свой гист среди гистов аккаунта: на втором и третьем
// устройстве достаточно вставить тот же токен. Не нашли — создаём приватный.
// Ошибку бросаем наружу и ничего не сохраняем: неподошедший токен запоминать незачем.
export async function connect(token, gistText) {
  token = String(token || '').trim();
  if (!token) throw syncError('empty');
  const typed = parseGistId(gistText);
  if (typed === null) throw syncError('badid');

  let gistId = typed;
  let created = false;
  if (gistId) {
    const gist = await gh('/gists/' + gistId, token);
    const text = await readFile(gist);
    if (text !== null) parseRemote(text);
  } else {
    const list = await gh('/gists?per_page=100', token);
    const found = (Array.isArray(list) ? list : [])
      .filter(isOurGist)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    if (found) {
      gistId = found.id;
    } else {
      const files = { [file]: { content: JSON.stringify(payload(state, fromDay())) } };
      const gist = await gh('/gists', token, {
        method: 'POST',
        body: JSON.stringify({ description: 'Palabras — прогресс', public: false, files }),
      });
      gistId = gist.id;
      created = true;
    }
  }

  writeConfig({ token, gistId, lastSyncAt: null, lastError: null });
  await syncNow();
  return { gistId, created };
}

// Отключение не трогает ни локальные данные, ни гист: прогресс остаётся и там, и там.
export function disconnect() {
  clearTimeout(timer);
  writeConfig(null);
  hooks.onStatus();
}

// Отправить отложенное сейчас — перед сменой профиля страница перезагружается,
// и таймер на десять секунд до отправки не доживёт.
export function flush() {
  if (!timer) return running || Promise.resolve();
  clearTimeout(timer);
  timer = null;
  return syncNow();
}

// ---------------------------------------------------------------------------
// когда синхронизироваться
// ---------------------------------------------------------------------------

let timer = null;

function schedule() {
  if (quiet || !config || !config.token) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    syncNow();
  }, DEBOUNCE_MS);
}

// При запуске, при возврате в приложение и через десять секунд после последнего ответа.
// Уход из приложения отправляет сразу: на телефоне его могут выгрузить из памяти
// раньше, чем истекут десять секунд.
export function start(h, profileId) {
  hooks = { ...hooks, ...h };
  file = fileFor(profileId);
  onSave(schedule);
  document.addEventListener('visibilitychange', () => {
    if (!config || !config.token) return;
    if (document.visibilityState === 'hidden') {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        syncNow();
      }
      return;
    }
    const last = config.lastSyncAt ? Date.parse(config.lastSyncAt) : 0;
    if (Date.now() - last > PULL_EVERY_MS) syncNow();
  });
  return syncNow();
}
