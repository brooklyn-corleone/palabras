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

// dir "ua" — показываем украинское, вспоминаем испанское (воспроизведение).
// dir "es" — показываем испанское, вспоминаем украинское (узнавание).
//
// Чем выше коробка, тем меньше подсказок: сначала выбор из вариантов, потом сборка
// из букв, потом чистый ввод. Обратно režим не «понижается» — за этим следит MAX_BOX.
export function pickMode(key) {
  const { dir } = parseKey(key);
  const card = state.cards[key];
  const box = card ? card.box : 1;

  if (card && card.arch) return dir === 'ua' ? 'type' : 'flip';

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
  const answerOf = (w) => (dir === 'es' ? w.ua : w.es);
  const correct = answerOf(word);

  const usable = state.words.filter(
    (w) => !w.deleted && w.id !== word.id && w.es && w.ua && answerOf(w) !== correct,
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

// Пачка из шести пар в начале сессии — только если карточек к повторению вообще хватает.
// Разминка не должна становиться единственным содержанием дня.
export function pickMatchWords() {
  const ids = [];
  const seen = new Set();
  for (const key of queue) {
    const w = wordOf(key);
    if (!w || seen.has(w.id) || !w.es || !w.ua) continue;
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

export function buildQueue() {
  const t = today();
  const out = [];
  for (const key of Object.keys(state.cards)) {
    const c = state.cards[key];
    if (c.arch) continue;
    if (c.due <= t && isLiveKey(key)) out.push(key);
  }
  shuffle(out);

  // Архивные подмешиваем примерно одну на десять обычных, но хотя бы одну:
  // иначе выученное тихо выпадает из памяти и обнаруживается это слишком поздно.
  const arch = shuffle(archivedKeys());
  const take = out.length ? Math.min(arch.length, Math.max(1, Math.round(out.length / 10))) : 0;
  for (let i = 0; i < take; i++) {
    out.splice(Math.floor(Math.random() * (out.length + 1)), 0, arch[i]);
  }
  queue = out;
  return queue.length;
}

export function nextKey() {
  if (!queue.length) buildQueue();
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
  for (const suffix of ['|es', '|ua']) {
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
  const ua = state.cards[id + '|ua'];
  const boxes = [es, ua].filter(Boolean).map((c) => c.box);
  return boxes.length ? Math.min(...boxes) : 1;
}

export function isArchived(id) {
  const c = state.cards[id + '|es'];
  return !!(c && c.arch);
}

export function wordOf(key) {
  return wordById(parseKey(key).wordId);
}
