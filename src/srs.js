// Движок повторений: коробки Лейтнера, архив, веса режимов, сборка очереди.
// Логика перенесена из reference/palabras.html, про DOM здесь ничего не знают.

import { state, today, addDays, now, save, wordById, parseKey, isLiveKey } from './state.js';

export const INTERVALS = [1, 2, 4, 8, 16]; // дни для коробок 1..5
export const BOX_LABEL = ['1 день', '2 дня', '4 дня', '8 дней', '16 дней'];

// Потолок коробки для каждого режима. Узнать слово среди двух-трёх вариантов много легче,
// чем вспомнить его с нуля, поэтому одинаково засчитывать режимы нельзя — иначе слова
// «выучиваются» фальшиво.
//
// letters даёт буквы в подсказку, поэтому останавливается на четвёртой коробке.
// Коробка 5 — только за чистый ввод по памяти.
export const MAX_BOX = { type: 5, letters: 4, flip: 3, choice: 3, match: 0 };

// ---------------------------------------------------------------------------
// выбор режима
// ---------------------------------------------------------------------------

function pickOne(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// dir "ru" — показываем русское, вспоминаем испанское (воспроизведение).
// dir "es" — показываем испанское, вспоминаем русское (узнавание).
//
// Чем выше коробка, тем меньше подсказок: сначала выбор из вариантов, потом сборка
// из букв, потом чистый ввод. Обратно režим не «понижается» — за этим следит MAX_BOX.
// Какое направление карточки требует режим, если его выбрали руками.
// null — режим работает в обе стороны. type и letters всегда RU→ES (воспроизведение),
// flip всегда ES→RU (узнавание), иначе задание теряет смысл.
export const MODE_DIR = { type: 'ru', letters: 'ru', flip: 'es', choice: null, match: null };

export const MODE_LABEL = {
  choice: 'Квиз',
  type: 'Ввод',
  letters: 'Из букв',
  flip: 'Карточки',
  match: 'Пары',
};

// Режимы, которые сами задают карточку. `match` работает пачками, а не карточками,
// поэтому в выборе режима для очереди не участвует.
function cardModes(modes) {
  if (!modes || !modes.size) return [];
  return [...modes].filter((m) => m !== 'match' && MAX_BOX[m] !== undefined);
}

// Направления, которые нужны выбранным режимам. null — годятся любые.
// Если выбраны и «ввод» (RU→ES), и «карточки» (ES→RU), в занятие идут оба направления.
export function allowedDirs(modes) {
  const chosen = cardModes(modes);
  if (!chosen.length) return null;
  const dirs = new Set();
  for (const m of chosen) {
    if (!MODE_DIR[m]) return null; // choice работает в обе стороны — ограничивать нечем
    dirs.add(MODE_DIR[m]);
  }
  return dirs;
}

export function pickMode(key, modes) {
  const { dir } = parseKey(key);

  // Режимы, выбранные руками, важнее лестницы коробок: пользователь знает, что хочет
  // потренировать. Веса MAX_BOX при этом остаются в силе, так что схитрить не выйдет.
  const chosen = cardModes(modes).filter((m) => !MODE_DIR[m] || MODE_DIR[m] === dir);
  if (chosen.length) return pickOne(chosen);

  const card = state.cards[key];
  const box = card ? card.box : 1;

  if (card && card.arch) return dir === 'ru' ? 'type' : 'flip';

  if (dir === 'es') return pickOne(['flip', 'choice']);

  if (box === 1) return pickOne(['choice', 'letters']);
  if (box <= 3) return pickOne(['letters', 'type']);
  return 'type';
}

// ---------------------------------------------------------------------------
// дистракторы для режима choice
// ---------------------------------------------------------------------------

// Вариант, который не отличить от правильного, делает выбор бессмысленным, а слишком
// далёкий — тривиальным. Поэтому берём по приоритету: та же часть речи → близкая длина
// → что угодно. Слово с тем же переводом не берём никогда.
export function pickDistractors(word, dir, n = 2) {
  const answerOf = (w) => (dir === 'es' ? w.ru : w.es);
  const correct = answerOf(word);

  const usable = state.words.filter(
    (w) => !w.deleted && w.id !== word.id && w.es && w.ru && answerOf(w) !== correct,
  );

  const tiers = [
    shuffle(usable.filter((w) => w.pos && w.pos === word.pos)),
    shuffle(usable.filter((w) => Math.abs(answerOf(w).length - correct.length) <= 3)),
    shuffle(usable.slice()),
  ];

  const out = [];
  const taken = new Set();
  for (const tier of tiers) {
    for (const w of tier) {
      if (out.length >= n) break;
      if (taken.has(w.id) || out.some((o) => answerOf(o) === answerOf(w))) continue;
      taken.add(w.id);
      out.push(w);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// разминка match
// ---------------------------------------------------------------------------

export const MATCH_PAIRS = 6;

// Сколько выученных слов максимум подмешивать в одно занятие.
export const MAX_ARCHIVE_MIX = 3;

// Пачка из шести пар в начале сессии — только если карточек к повторению вообще хватает.
// Разминка не должна становиться единственным содержанием дня.
export function pickMatchWords() {
  const ids = [];
  const seen = new Set();
  for (const key of queue) {
    const w = wordOf(key);
    if (!w || seen.has(w.id) || !w.es || !w.ru) continue;
    seen.add(w.id);
    ids.push(w);
    if (ids.length >= MATCH_PAIRS) break;
  }
  return ids.length >= MATCH_PAIRS ? shuffle(ids) : null;
}

// ---------------------------------------------------------------------------
// очередь сессии
// ---------------------------------------------------------------------------

let queue = [];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function archivedKeys() {
  return Object.keys(state.cards).filter((k) => state.cards[k].arch && isLiveKey(k));
}

// Настройки текущего занятия. Пустые — обычный режим «что созрело к повторению».
//   source: 'due' | 'random' | 'picked'
//   cats:   Set с кодами тем (пустой — все темы)
//   size:   сколько слов взять (0 — сколько есть)
//   modes:  Set с режимами (пустой — авто, по лестнице коробок)
//   picked: Set с id слов для source: 'picked'
let session = {};

export function setSession(options) {
  session = options || {};
}

export function getSession() {
  return session;
}

// Ограничиваем занятие по словам, а не по карточкам: «20 слов» для человека — это
// двадцать слов, даже если у каждого два направления.
function limitByWords(keys, size) {
  if (!size || size <= 0) return keys;
  const allowed = new Set();
  for (const key of keys) {
    if (allowed.size >= size) break;
    allowed.add(parseKey(key).wordId);
  }
  return keys.filter((key) => allowed.has(parseKey(key).wordId));
}

export function buildQueue(options) {
  if (options) session = options;
  const source = session.source || 'due';
  const dirs = allowedDirs(session.modes);
  const cats = session.cats && session.cats.size ? session.cats : null;
  const t = today();

  let out = Object.keys(state.cards).filter(isLiveKey);

  if (source === 'picked') {
    const picked = session.picked;
    out = out.filter((key) => picked && picked.has(parseKey(key).wordId));
  } else if (source !== 'random') {
    out = out.filter((key) => !state.cards[key].arch && state.cards[key].due <= t);
  }
  if (dirs) out = out.filter((key) => dirs.has(parseKey(key).dir));
  // Темы выбираются независимо от источника: «случайные 20 из семьи и дома» — обычный запрос.
  if (cats) {
    out = out.filter((key) => {
      const w = wordById(parseKey(key).wordId);
      return w && cats.has(w.cat);
    });
  }

  shuffle(out);
  queue = limitByWords(out, session.size);

  // Выученные подмешиваем только в обычное занятие: если слова выбраны руками
  // или заказано «двадцать случайных», подмешивать к ним чужое было бы самоуправством.
  //
  // Делается это после лимита, а не до: иначе на занятии «10 слов» подмешанное выученное
  // конкурировало бы за те же десять мест и почти всегда выбрасывалось. «Десять слов» —
  // это десять новых плюс пара повторений сверху, а не десять на всех.
  //
  // Доля — примерно одна на десять, но не больше MAX_ARCHIVE_MIX за занятие. Без потолка
  // на колоде в пятьсот слов половина занятия превратилась бы в повторение выученного.
  if (source === 'due') {
    const arch = shuffle(archivedKeys()).filter((key) => {
      const { wordId, dir } = parseKey(key);
      if (dirs && !dirs.has(dir)) return false;
      if (!cats) return true;
      const w = wordById(wordId);
      return w && cats.has(w.cat);
    });
    const share = Math.min(Math.round(queue.length / 10), MAX_ARCHIVE_MIX);
    const take = queue.length ? Math.min(arch.length, Math.max(1, share)) : 0;
    for (let i = 0; i < take; i++) {
      queue.splice(Math.floor(Math.random() * (queue.length + 1)), 0, arch[i]);
    }
  }

  return queue.length;
}

// Слова для занятия целиком — нужны режиму «Пары», который работает пачками, а не карточками.
export function sessionWords() {
  buildQueue();
  const seen = new Set();
  const words = [];
  for (const key of queue) {
    const w = wordOf(key);
    if (!w || seen.has(w.id) || !w.es || !w.ru) continue;
    seen.add(w.id);
    words.push(w);
  }
  return words;
}

export function nextKey() {
  // Пересобираем очередь только для обычного занятия: там кончившиеся карточки
  // означают «на сегодня всё». Занятие из выбранных или случайных слов конечно
  // по замыслу — иначе оно никогда не закончится.
  if (!queue.length && (session.source || 'due') === 'due') buildQueue();
  return queue.shift() || null;
}

export function requeue(key) {
  queue.push(key);
}

export function queueLength() {
  return queue.length;
}

// «Повторить ещё раз» на экране итога: прогоняем всё живое, ничего не меняя в сроках.
export function buildExtraQueue() {
  queue = shuffle(Object.keys(state.cards).filter(isLiveKey));
  return queue.length;
}

// ---------------------------------------------------------------------------
// проверка ответа
// ---------------------------------------------------------------------------

// Сводим ответ к сравнимому виду: нижний регистр, без диакритики, без артикля,
// без знаков препинания. Пользователь учит слово, а не раскладку клавиатуры.
//
// Артикль снимаем последним, уже после чистки и trim. В прототипе он снимался первым,
// и любой пробел или «¿» в начале строки ломал правило: ответ « la llave» приводился
// к «la llave», сравнивался с «llave» и считался ошибкой.
export function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zñ\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(el|la|los|las|un|una)\s+/, '');
}

// Расстояние Левенштейна. Нужно только чтобы отличить опечатку от незнания,
// поэтому хватает двух строк матрицы.
export function lev(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = [];
  let cur = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur.slice();
  }
  return prev[n];
}

// Нормализованные ответы всех живых слов колоды. Нужны, чтобы отличить опечатку
// от соседней формы: «está» вместо «estás» — это не промах пальцем, а другое слово.
function allAnswers() {
  const set = new Set();
  for (const w of state.words) if (!w.deleted) set.add(norm(w.es));
  return set;
}

// "ok" | "almost" | "no". Опечатка в один символ засчитывается как верный ответ:
// наказывать за промах пальцем — значит учить печатать, а не язык.
//
// Но снисхождение выключается там, где оно вредит: на коротких словах (soy, es, son
// отличаются одной-двумя буквами) и когда набранное совпадает с другим словом колоды.
// Иначе спряжения «выучиваются» на автомате, а таблица глагола этого не прощает.
const MIN_TYPO_LEN = 5;

export function judge(input, target) {
  const a = norm(input);
  const b = norm(target);
  if (!a) return 'no';
  if (a === b) return 'ok';
  if (b.length >= MIN_TYPO_LEN && lev(a, b) <= 1 && !allAnswers().has(a)) return 'almost';
  return 'no';
}

// ---------------------------------------------------------------------------
// оценка карточки
// ---------------------------------------------------------------------------

// Архив — шестое состояние поверх пяти коробок: слово выучено, но изредка проверяется.
export function archiveWord(id, on) {
  for (const suffix of ['|es', '|ru']) {
    const c = state.cards[id + suffix];
    if (!c) continue;
    if (on === false) {
      c.arch = false;
      c.box = 2;
      c.due = today();
    } else {
      c.arch = true;
      c.box = 5;
      c.due = addDays(INTERVALS[4]);
    }
    c.updated = now();
  }
  save();
  buildQueue();
}

// Возвращает { box, arch, counted } — что показать в шкале и считать ли в дневную цель.
export function grade(key, mode, correct) {
  const c = state.cards[key];
  if (!c) return null;

  if (c.arch) {
    if (correct) {
      c.due = addDays(INTERVALS[4]); // помнит — остаётся в архиве
    } else {
      c.arch = false; // забыл — возвращается в оборот
      c.box = 2;
      c.due = today();
      requeue(key);
    }
    c.updated = now();
    save();
    // Архивные повторения в дневную цель не идут: цель про новое, а не про поддержание.
    return { box: c.box, arch: c.arch, counted: false, correct };
  }

  const cap = MAX_BOX[mode] === undefined ? 5 : MAX_BOX[mode];
  if (correct) {
    // Выше потолка режима карточка не поднимается, но и не опускается —
    // за верный ответ наказывать не за что.
    c.box = Math.max(c.box, Math.min(c.box + 1, cap));
  } else if (mode === 'match') {
    c.box = Math.max(1, c.box - 1); // в match много промахов пальцем, полный сброс несправедлив
  } else {
    c.box = 1;
  }
  c.due = correct ? addDays(INTERVALS[c.box - 1]) : today();
  c.updated = now();
  if (!correct) requeue(key); // вернуть в конец сессии
  // Разминка в дневную цель не идёт: она про то, чтобы войти в ритм, а не про повторение.
  const counted = mode !== 'match';
  if (counted) state.stats.done++;
  save();
  return { box: c.box, arch: false, counted, correct };
}

// ---------------------------------------------------------------------------
// сводка для шкалы коробок
// ---------------------------------------------------------------------------

export function boxCounts() {
  const boxes = [0, 0, 0, 0, 0];
  let arch = 0;
  for (const key of Object.keys(state.cards)) {
    if (!isLiveKey(key)) continue;
    const c = state.cards[key];
    if (c.arch) arch++;
    else boxes[c.box - 1]++;
  }
  return { boxes, arch };
}

// Коробка слова целиком — минимум из двух его карточек: слово выучено настолько,
// насколько выучено его слабое направление.
export function wordBox(id) {
  const es = state.cards[id + '|es'];
  const ru = state.cards[id + '|ru'];
  const boxes = [es, ru].filter(Boolean).map((c) => c.box);
  return boxes.length ? Math.min(...boxes) : 1;
}

export function isArchived(id) {
  const c = state.cards[id + '|es'];
  return !!(c && c.arch);
}

export function wordOf(key) {
  return wordById(parseKey(key).wordId);
}
