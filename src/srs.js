// Движок повторений: коробки Лейтнера, архив, веса режимов, сборка очереди.
// Логика перенесена из reference/palabras.html, про DOM здесь ничего не знают.

import {
  state,
  today,
  addDays,
  now,
  save,
  wordById,
  parseKey,
  isLiveKey,
  deckRevision,
} from './state.js';

export const INTERVALS = [1, 2, 4, 8, 16]; // дни для коробок 1..5
export const BOX_LABEL = ['1 день', '2 дня', '4 дня', '8 дней', '16 дней'];

// Имена стадий вместо номеров коробок, как у WaniKani: «коробка 3» ничего не говорит
// тому, кто не читал про Лейтнера, а «помню» — говорит. Номер остаётся в подписи шкалы.
export const STAGES = ['учу', 'знакомо', 'помню', 'уверенно', 'твёрдо'];

export function stageLabel(card) {
  if (!card) return '';
  if (card.arch) return 'архив';
  if (isNewCard(card)) return 'новое';
  return STAGES[card.box - 1] || '';
}

// Потолок коробки для каждого режима. Узнать слово среди двух-трёх вариантов много легче,
// чем вспомнить его с нуля, поэтому одинаково засчитывать режимы нельзя — иначе слова
// «выучиваются» фальшиво.
//
// letters даёт буквы в подсказку, поэтому останавливается на четвёртой коробке.
// Коробка 5 в направлении RU→ES — только за чистый ввод по памяти.
//
// У flip потолок тоже 5, и это не поблажка. flip обслуживает ровно одно направление —
// ES→RU (MODE_DIR), где кроме него есть только choice с выбором из трёх. Пока потолок
// flip был 3, es-карточка не могла подняться выше третьей коробки ничем вообще:
// половина колоды возвращалась каждые четыре дня вечно, а коробка слова (минимум двух
// направлений) никогда не показывала больше тройки. Оценка у flip своя, зато честная —
// как во всех SRS, где пользователь сам говорит «помнил», — а RU→ES от этого не страдает:
// туда flip не попадает ни при каких настройках.
export const MAX_BOX = { type: 5, letters: 4, flip: 5, choice: 3, match: 0 };

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

  // Лестница симметрична в обе стороны: сначала вариант подсказан, дальше подсказок нет.
  // Без второй ветки es-карточка в четвёртой коробке могла снова получить choice
  // с его потолком 3 и застрять там же, откуда только что вышла.
  if (dir === 'es') {
    if (box <= 3) return pickOne(['flip', 'choice']);
    return 'flip';
  }

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
//
// Спряжение (ser/estar/tener, поле conj) отдельно от обычных слов: вариант вроде
// «hablar» рядом с «tienen» не проверяет знание языка, а угадывается по виду — глагол
// в инфинитиве и личная форма даже близко не похожи. Спряжения путаем только между
// собой, обычные слова — только между собой; на «что угодно» скатываемся лишь если
// кандидатов своего вида не хватило.
export function pickDistractors(word, dir, n = 2) {
  const answerOf = (w) => (dir === 'es' ? w.ru : w.es);
  const correct = answerOf(word);

  const usable = state.words.filter(
    (w) => !w.deleted && w.id !== word.id && w.es && w.ru && answerOf(w) !== correct,
  );
  const sameKind = (w) => !!w.conj === !!word.conj;

  const tiers = [
    shuffle(usable.filter((w) => sameKind(w) && w.pos && w.pos === word.pos)),
    shuffle(usable.filter((w) => sameKind(w) && Math.abs(answerOf(w).length - correct.length) <= 3)),
    shuffle(usable.filter(sameKind)),
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
//
// Только из уже знакомых слов: соединять пары из слов, которых ни разу не видел, —
// гадание, а не разминка. Новое слово сначала показывается экраном знакомства.
export function pickMatchWords() {
  const ids = [];
  const seen = new Set();
  for (const key of queue) {
    const w = wordOf(key);
    if (!w || seen.has(w.id) || !w.es || !w.ru || isNewWord(w.id)) continue;
    seen.add(w.id);
    ids.push(w);
    if (ids.length >= MATCH_PAIRS) break;
  }
  return ids.length >= MATCH_PAIRS ? shuffle(ids) : null;
}

// ---------------------------------------------------------------------------
// очередь сессии
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// трудные слова и новые слова за день
// ---------------------------------------------------------------------------

// Слово становится трудным после четырёх промахов. Промах засчитывается не чаще раза
// в день на карточку: неверная карточка возвращается в очередь и может провалиться
// ещё дважды за то же занятие, а трудность — это «не держится от дня ко дню».
// В Anki такие карточки называются leech, порог по умолчанию — восемь; у нас коробок
// пять, а не десятки ступеней, поэтому порог ниже.
export const LEECH = 4;

function noteLapse(c) {
  const t = today();
  if (c.lapseDay === t) return;
  c.lapseDay = t;
  c.lapses = (c.lapses || 0) + 1;
}

// Трудное — пока не выучено: слово, дошедшее до архива, справилось с трудностью само.
export function isHard(id) {
  const es = state.cards[id + '|es'];
  const ru = state.cards[id + '|ru'];
  if (!es && !ru) return false;
  if ((es && es.arch) || (ru && ru.arch)) return false;
  return Math.max((es && es.lapses) || 0, (ru && ru.lapses) || 0) >= LEECH;
}

export function hardWordIds() {
  const ids = new Set();
  for (const key of Object.keys(state.cards)) {
    if (!isLiveKey(key)) continue;
    const id = parseKey(key).wordId;
    if (!ids.has(id) && isHard(id)) ids.add(id);
  }
  return ids;
}

// Новых слов в день — отдельно от размера занятия, как в Anki и Lingvist. Без этого
// свежая колода в двести сорок слов отдаёт новые занятие за занятием, пока не кончится,
// а через день все они разом возвращаются на повторение. 0 — без лимита.
export const NEW_PER_DAY = [10, 20, 40, 0];

export function newPerDay() {
  const n = state.settings && state.settings.newPerDay;
  return typeof n === 'number' ? n : 20;
}

// Карточка новая, если её ещё ни разу не спрашивали. У карточек, заведённых до появления
// поля seen, его нет: тех, что выше первой коробки, явно спрашивали, а лежащие в первой
// считаем новыми — для слова, которое так и не поднялось, это почти правда.
function isNewCard(c) {
  return !c.seen && !c.arch && c.box === 1;
}

function wordCards(id) {
  return ['|es', '|ru'].map((s) => state.cards[id + s]).filter(Boolean);
}

export function isNewWord(id) {
  const cards = wordCards(id);
  return cards.length > 0 && cards.every(isNewCard);
}

// Сколько слов впервые встретилось сегодня: хотя бы одна карточка спрошена сегодня,
// и ни одна — раньше.
function introducedToday() {
  const t = today();
  const ids = new Set();
  for (const key of Object.keys(state.cards)) {
    if (!isLiveKey(key)) continue;
    const id = parseKey(key).wordId;
    if (ids.has(id)) continue;
    const cards = wordCards(id);
    // «Уже знаю» — не новое слово, взятое в работу, а знакомое, и дневной лимит
    // оно не тратит: иначе десять знакомых слов съели бы половину дня.
    if (cards.some((c) => c.known === t)) continue;
    if (cards.some((c) => c.seen === t) && cards.every((c) => c.seen === t || isNewCard(c))) {
      ids.add(id);
    }
  }
  return ids.size;
}

export function newLeftToday() {
  const limit = newPerDay();
  if (!limit) return Infinity;
  return Math.max(0, limit - introducedToday());
}

// Сколько ждёт сегодня, без оглядки на настройки занятия: повторение отдельно,
// новые — отдельно и уже с учётом дневного лимита.
export function todayCounts() {
  const t = today();
  const review = new Set();
  const fresh = new Set();
  for (const key of Object.keys(state.cards)) {
    if (!isLiveKey(key)) continue;
    const c = state.cards[key];
    if (c.arch || c.due > t) continue;
    const id = parseKey(key).wordId;
    if (isNewWord(id)) fresh.add(id);
    else review.add(id);
  }
  return { review: review.size, fresh: Math.min(fresh.size, newLeftToday()) };
}

// Оставить в очереди не больше `left` новых слов. Порядок ключей уже случайный,
// поэтому берём первые встретившиеся.
function limitNew(keys, left) {
  if (left === Infinity) return keys;
  const allowed = new Set();
  return keys.filter((key) => {
    const id = parseKey(key).wordId;
    if (!isNewWord(id)) return true;
    if (allowed.has(id)) return true;
    if (allowed.size >= left) return false;
    allowed.add(id);
    return true;
  });
}

let queue = [];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Слова одной темы — не подряд. При знакомстве смысловые группы мешают: «рука, нога,
// голова» подряд путаются друг с другом сильнее, чем вперемешку с другими темами
// (Tinkham 1993, Waring 1997). Перемешивание и так почти всегда разводит темы,
// но на колоде, где треть слов — глаголы, соседи из одной темы выпадают часто.
// Жадно: если карточка той же темы, что предыдущая, меняем её с ближайшей другой.
// Когда другой темы нет (занятие по одной теме), оставляем как есть.
export function spreadCats(keys) {
  const catOf = (key) => {
    const w = wordById(parseKey(key).wordId);
    return (w && w.cat) || '';
  };
  const out = keys.slice();
  for (let i = 1; i < out.length; i++) {
    const prev = catOf(out[i - 1]);
    if (!prev || catOf(out[i]) !== prev) continue;
    for (let j = i + 1; j < out.length; j++) {
      if (catOf(out[j]) !== prev) {
        [out[i], out[j]] = [out[j], out[i]];
        break;
      }
    }
  }
  return out;
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
    // Слово, отмеченное галочкой вручную, идёт в занятие любым — архивное в том числе.
    // Просил именно его, прятать нечего.
    const picked = session.picked;
    out = out.filter((key) => picked && picked.has(parseKey(key).wordId));
  } else if (source === 'hard') {
    // Трудные — независимо от срока: их и выбирают, чтобы прогнать вне очереди.
    const hard = hardWordIds();
    out = out.filter((key) => hard.has(parseKey(key).wordId));
  } else {
    // Архив — отдельное состояние «выучено, проверяем изредка», и сам по себе в занятие
    // он не идёт: подмешивается ниже и дозированно. Раньше у «случайных» этого фильтра
    // не было, и архивные приходили как обычные — но в цель они не идут
    // (counted: false), так что цель на таком занятии не набиралась.
    out = out.filter((key) => !state.cards[key].arch);
    if (source !== 'random') out = out.filter((key) => state.cards[key].due <= t);
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
  // Дневной лимит новых — только для обычного повторения. Случайные, выбранные
  // и трудные заказаны руками, и урезать заказ было бы самоуправством.
  if (source === 'due') out = limitNew(out, newLeftToday());
  queue = spreadCats(limitByWords(out, session.size));

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

// Слова уже собранной очереди — нужны режиму «Пары», который работает пачками,
// а не карточками. Очередь здесь не пересобираем: вызывающий делает это сам, и раньше
// из-за второй пересборки пачки «Пар» оказывались из другой очереди, чем само занятие.
export function sessionWords() {
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
  // Пересобираем очередь только для обычного занятия без лимита: там кончившиеся
  // карточки действительно означают «на сегодня всё». Занятие из выбранных или
  // случайных слов конечно по замыслу — иначе оно никогда не закончится.
  //
  // Лимит по словам сюда же: без этой проверки он не работал вовсе. Очередь набиралась
  // на двадцать слов, вычерпывалась, тут же собиралась заново на следующие двадцать —
  // и так пока не кончится вся колода. На свежих двухстах сорока словах это
  // четыреста восемьдесят карточек в одном занятии, которое не кончается.
  const endless = (session.source || 'due') === 'due' && !session.size;
  if (!queue.length && endless) buildQueue();
  return queue.shift() || null;
}

// Сколько слов ещё ждут повторения сегодня — без оглядки на настройки занятия.
// Нужно экрану в конце: «занятие закончено» и «на сегодня всё» — разные вещи,
// и обещать второе, когда созрело ещё две сотни карточек, нельзя.
// Новые сверх дневного лимита сегодня не придут, поэтому и ждущими не считаются.
export function dueWordCount() {
  const { review, fresh } = todayCounts();
  return review + fresh;
}

export function requeue(key) {
  queue.push(key);
}

export function queueLength() {
  return queue.length;
}

// «Повторить ещё раз» на экране итога: прогоняем заново ровно те слова, что были
// в занятии, не трогая сроки.
//
// Ровно те: раньше сюда попадала вся колода целиком — несозревшие карточки и архив
// в том числе, — и кнопка «повторить» запускала пятьсот карточек вместо двадцати.
// По сроку не фильтруем намеренно: у пройденного срок уже сдвинут в будущее,
// а смысл кнопки как раз в том, чтобы пройти пройденное ещё раз.
export function buildExtraQueue(wordIds) {
  const ids = wordIds instanceof Set ? wordIds : new Set(wordIds || []);
  queue = shuffle(
    Object.keys(state.cards).filter((key) => isLiveKey(key) && ids.has(parseKey(key).wordId)),
  );
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
// Три уровня строгости сравнения, от мягкого к точному:
//   loose  — без всей диакритики, ñ тоже становится n;
//   norm   — без ударений, но ñ остаётся буквой;
//   strict — всё как написано, кроме регистра, знаков препинания и артикля.
//
// ñ в испанском — отдельная буква алфавита, а не «n с украшением»: año и ano — разные
// слова, и второе лучше не говорить вслух. Раньше norm снимал тильду вместе с ударениями
// (NFD раскладывает ñ на n + U+0303), и ñ в классе [^a-zñ] был мёртвым кодом.
function loose(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(el|la|los|las|un|una)\s+/, '');
}

export function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    // Собираем ñ обратно до того, как снимем ударения, — иначе тильда уйдёт с ними.
    .replace(/n\u0303/g, 'ñ')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zñ\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(el|la|los|las|un|una)\s+/, '');
}

const LETTER = /[a-záéíóúüñ]/;

function strict(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^a-záéíóúüñ\s]/g, '')
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
//
// Кэшируем по счётчику правок колоды: множество пересобиралось на каждый неверный
// ответ, а это norm() на каждое слово колоды — на трёхстах словах заметно, и чем
// больше колода, тем хуже. deckRevision() меняется при любой правке текста слова.
let answersCache = null;
let answersRev = -1;

function allAnswers() {
  const rev = deckRevision();
  if (answersCache && answersRev === rev) return answersCache;
  const set = new Set();
  for (const w of state.words) if (!w.deleted) set.add(norm(w.es));
  answersCache = set;
  answersRev = rev;
  return set;
}

// "ok" | "accent" | "almost" | "no". Опечатка в один символ засчитывается как верный ответ:
// наказывать за промах пальцем — значит учить печатать, а не язык.
//
// Но снисхождение выключается там, где оно вредит: на коротких словах (soy, es, son
// отличаются одной-двумя буквами) и когда набранное совпадает с другим словом колоды.
// Иначе спряжения «выучиваются» на автомате, а таблица глагола этого не прощает.
const MIN_TYPO_LEN = 5;

// Пары, где диакритика меняет слово: «si» — «если», «sí» — «да». Здесь пропущенный
// знак — не небрежность, а другой ответ, и засчитывать его нельзя.
const ACCENT_PAIRS = new Set([
  'si', 'sí', 'el', 'él', 'tu', 'tú', 'mi', 'mí', 'se', 'sé',
  'te', 'té', 'de', 'dé', 'mas', 'más', 'ano', 'año',
]);

// Ответы колоды в точном написании — чтобы «esta» на месте «está» не засчитывалось
// как пропущенное ударение, если «esta» само есть в колоде.
let strictCache = null;
let strictRev = -1;

function allAnswersStrict() {
  const rev = deckRevision();
  if (strictCache && strictRev === rev) return strictCache;
  const set = new Set();
  for (const w of state.words) if (!w.deleted) set.add(strict(w.es));
  strictCache = set;
  strictRev = rev;
  return set;
}

// "accent" — всё верно, кроме диакритики (ударение, ñ, ü). Засчитывается, как у Lingvist
// и Duolingo: наказывать за ударение на телефонной клавиатуре — значит учить печатать.
// Но молча прощать тоже нельзя: раньше такой ответ получал просто «Верно», и выучить
// ударения было невозможно. Поэтому отдельный вердикт — режим показывает, где знак.
export function judge(input, target) {
  const s = strict(input);
  const t = strict(target);
  if (!s) return 'no';
  if (s === t) return 'ok';
  if (loose(input) === loose(target)) {
    if (ACCENT_PAIRS.has(s) && ACCENT_PAIRS.has(t)) return 'no';
    if (allAnswersStrict().has(s)) return 'no';
    return 'accent';
  }
  const a = norm(input);
  const b = norm(target);
  if (b.length >= MIN_TYPO_LEN && lev(a, b) <= 1 && !allAnswers().has(a)) return 'almost';
  return 'no';
}

// Позиции букв в target (после NFC), где ответ разошёлся с ним диакритикой. Нужны только
// для вердикта "accent": тогда буквы двух строк идут один к одному, и достаточно пройти
// их параллельно, пропуская артикль, пробелы и ¿?. Набранный артикль strict уже срезал.
export function accentMarks(input, target) {
  const typed = [...strict(input).replace(/\s+/g, '')];
  const chars = [...(target || '').normalize('NFC').toLowerCase()];
  const article = chars.join('').match(/^\s*(el|la|los|las|un|una)\s+/);
  const marks = new Set();
  let k = 0;
  for (let i = article ? [...article[0]].length : 0; i < chars.length; i++) {
    if (!LETTER.test(chars[i])) continue;
    if (typed[k] !== chars[i]) marks.add(i);
    k++;
  }
  return marks;
}

// Посимвольное сравнение набранного с правильным — для «почти» и близких промахов.
// Возвращает индексы в input.normalize('NFC') (лишние или неверные буквы) и в
// target.normalize('NFC') (пропущенные), либо null, если ответ на правильный не похож:
// в «perro» вместо «gato» подсветка каждой буквы ничего не объясняет.
// Сравниваем по общей подпоследовательности: одна вставленная буква не должна
// окрашивать весь хвост слова, как при сравнении позиция в позицию.
export function diffMarks(input, target) {
  const a = [...(input || '').normalize('NFC').toLowerCase()];
  const b = [...(target || '').normalize('NFC').toLowerCase()];
  const na = norm(input);
  const nb = norm(target);
  if (!na || lev(na, nb) > Math.max(2, Math.ceil(nb.length / 3))) return null;

  // Артикль необязателен, так что «la» в одном из ответов — не ошибка.
  const skip = (chars) => {
    const m = chars.join('').match(/^\s*(el|la|los|las|un|una)\s+/);
    return m ? [...m[0]].length : 0;
  };
  const sa = skip(a);
  const sb = skip(b);
  const x = a.slice(sa);
  const y = b.slice(sb);

  // Таблица длин LCS, затем обратный проход: что не попало в общую часть — расхождение.
  const L = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const typed = new Set();
  const missing = new Set();
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i++;
      j++;
    } else if (j >= y.length || (i < x.length && L[i + 1][j] >= L[i][j + 1])) {
      if (LETTER.test(x[i])) typed.add(sa + i);
      i++;
    } else {
      if (LETTER.test(y[j])) missing.add(sb + j);
      j++;
    }
  }
  return { typed, missing };
}

// ---------------------------------------------------------------------------
// оценка карточки
// ---------------------------------------------------------------------------

// Архив — шестое состояние поверх пяти коробок: слово выучено, но изредка проверяется.
// Само переключение — без save и пересборки очереди, чтобы пачка обошлась одним разом.
function setArchived(id, on) {
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
}

// Очередь после этого не пересобирается, а только теряет карточки слова. Раньше здесь
// стоял buildQueue(), и «в архив» посреди занятия перетасовывало его заново: при лимите
// «десять слов» оставшиеся девять менялись на другие случайные.
export function archiveWord(id, on) {
  setArchived(id, on);
  save();
  return on !== false ? dropWord(id) : [];
}

// Пачкой: на экране конца занятия отмечают сразу по десятку слов, и делать
// столько же записей в базу незачем.
export function archiveWords(ids, on) {
  for (const id of ids) setArchived(id, on);
  save();
  if (on !== false) for (const id of ids) dropWord(id);
}

// Убрать карточки слова из текущей очереди. Возвращает убранные — для «Отменить».
export function dropWord(id) {
  const gone = queue.filter((key) => parseKey(key).wordId === id);
  if (gone.length) queue = queue.filter((key) => parseKey(key).wordId !== id);
  return gone;
}

// Снимок обеих карточек слова до действия и возврат к нему — это и есть «Отменить»
// у тоста. Копируем записи целиком: коробка, срок, архив, счётчик промахов.
export function snapshotWord(id) {
  const snap = {};
  for (const suffix of ['|es', '|ru']) {
    const c = state.cards[id + suffix];
    if (c) snap[suffix] = { ...c };
  }
  return snap;
}

export function restoreWord(id, snap) {
  for (const [suffix, card] of Object.entries(snap)) {
    state.cards[id + suffix] = { ...card, updated: now() };
  }
  save();
}

// Вернуть карточки в начало очереди: отменённое действие должно вернуть ту карточку,
// с которой ушли, а не отправить её в конец занятия.
export function unshiftKeys(keys) {
  const fresh = keys.filter((key) => !queue.includes(key));
  queue.unshift(...fresh);
}

// «Уже знаю» на экране знакомства с новым словом: обе карточки сразу в третью коробку,
// как в Memrise и Drops. Не в архив — знакомое на вид слово ещё надо проверить
// вспоминанием, и через четыре дня оно придёт обычной карточкой.
export const KNOWN_BOX = 3;

export function markKnown(id) {
  const t = today();
  for (const c of wordCards(id)) {
    c.box = KNOWN_BOX;
    c.due = addDays(INTERVALS[KNOWN_BOX - 1]);
    c.seen = c.seen || t;
    c.known = t;
    c.updated = now();
  }
  save();
  return dropWord(id);
}

// Потолок для ответа с опечаткой: см. opts.cap в grade.
export const ALMOST_CAP = 4;

// Возвращает { box, arch, counted } — что показать в шкале и считать ли в дневную цель.
// opts.cap — потолок для одного ответа ниже потолка режима: «почти — опечатка» засчитывается,
// но пятая коробка требует точного написания.
export function grade(key, mode, correct, opts = {}) {
  const c = state.cards[key];
  if (!c) return null;

  // Первая встреча с карточкой — для дневного лимита новых слов (см. newLeftToday).
  if (!c.seen) c.seen = today();
  // Промах пальцем в «Парах» трудным слово не делает. И в точность не идёт: в «Парах»
  // пишутся только промахи, верные пары не оцениваются вовсе.
  if (mode !== 'match') {
    if (!correct) noteLapse(c);
    logAnswer(correct);
  }

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

  const modeCap = MAX_BOX[mode] === undefined ? 5 : MAX_BOX[mode];
  const cap = Math.min(modeCap, opts.cap || 5);
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
  // В цель идут только верные ответы. Неверная карточка возвращается в очередь и будет
  // отвечена ещё раз — считая обе попытки, цель набиралась бы вдвое быстрее промахов,
  // а число на экране перестало бы значить «столько карточек я вспомнил».
  //
  // Разминка не идёт в цель вообще: она про то, чтобы войти в ритм, а не про повторение.
  const counted = mode !== 'match' && correct;
  if (counted) state.stats.done++;

  // Слово, дошедшее до пятой коробки в обоих направлениях, уходит в архив само.
  // Без этого архив наполнялся только руками, и весь механизм вокруг него — подмешивание
  // выученного, MAX_ARCHIVE_MIX, «изредка проверяется» — просто не запускался: пятая
  // коробка была конечной остановкой с интервалом шестнадцать дней навсегда.
  //
  // Планка высокая нарочно: пятёрка в RU→ES берётся только чистым вводом по памяти,
  // так что случайно сюда не попасть. Забыл потом — архив сам вернёт слово в оборот
  // (см. ветку c.arch в начале функции).
  //
  // Разминку сюда не пускаем: match коробки не двигает и решать судьбу слова не должен.
  if (counted && wordBox(parseKey(key).wordId) === 5) {
    setArchived(parseKey(key).wordId, true);
    save();
    return { box: 5, arch: true, counted, correct };
  }

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

// ---------------------------------------------------------------------------
// журнал по дням: точность, серия дней, прогноз
// ---------------------------------------------------------------------------

// state.log — { 'YYYY-MM-DD': { r, w, clear } }: верных, неверных и «разобрал всё».
// Хранится ровно столько, сколько нужно серии и точности. Девяносто дней — с запасом:
// серия дальше пары месяцев считается по тем же записям и рвётся только на пропуске.
const LOG_DAYS = 90;

function dayLog(t) {
  if (!state.log || typeof state.log !== 'object') state.log = {};
  if (!state.log[t]) {
    state.log[t] = { r: 0, w: 0 };
    const old = addDays(-LOG_DAYS);
    for (const d of Object.keys(state.log)) if (d < old) delete state.log[d];
  }
  return state.log[t];
}

function logAnswer(correct) {
  const e = dayLog(today());
  if (correct) e.r++;
  else e.w++;
}

// День засчитан и тогда, когда повторять больше нечего: при трёх созревших словах
// десяти верных ответов не набрать, и серия рвалась бы у того, кто сделал всё.
export function noteDayClear() {
  dayLog(today()).clear = true;
  save();
}

// Журнал всех устройств человека: свой плюс приехавшие синхронизацией (peerLogs).
// Ответы с разных устройств — разные ответы, поэтому складываем. Иначе серия рвалась бы
// в день, когда занимался на планшете, а смотришь на телефоне.
function fullLog() {
  const peers = Object.values(state.peerLogs || {});
  if (!peers.length) return state.log || {};
  const out = {};
  for (const log of [state.log || {}, ...peers]) {
    for (const [d, e] of Object.entries(log)) {
      if (!e) continue;
      const o = out[d] || (out[d] = { r: 0, w: 0 });
      o.r += e.r || 0;
      o.w += e.w || 0;
      if (e.clear) o.clear = true;
    }
  }
  return out;
}

// Точность за последние `days` дней, включая сегодня. null — ответов не было.
export function accuracy(days = 7) {
  const log = fullLog();
  const from = addDays(-(days - 1));
  let r = 0;
  let w = 0;
  for (const [d, e] of Object.entries(log)) {
    if (d < from) continue;
    r += e.r || 0;
    w += e.w || 0;
  }
  return r + w ? Math.round((100 * r) / (r + w)) : null;
}

// Серия дней. День засчитан после STREAK_MIN верных ответов — это самый короткий урок
// из настроек — или когда разобрано всё, что созрело.
export const STREAK_MIN = 10;

// Сдвиг даты 'YYYY-MM-DD' на n дней по местному времени, как и today().
export function shiftIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d + n);
  return (
    date.getFullYear() +
    '-' +
    String(date.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getDate()).padStart(2, '0')
  );
}

function dayActive(log, d) {
  const e = log[d];
  return !!e && ((e.r || 0) >= STREAK_MIN || !!e.clear);
}

// Один пропуск в семь дней серию не рвёт — заморозка, как у Duolingo, но без покупки
// и без кнопки: она срабатывает сама. Пропущенный день в счёт не идёт, только держит серию.
// Сегодняшний день, пока не засчитан, тоже не рвёт: день ещё не кончился.
//
// Чистая функция от журнала — ничего не хранит, поэтому её нельзя «сломать»
// перестановкой часов или импортом колоды: серия всегда пересчитывается из записей.
export function streakFrom(log, t) {
  const todayDone = dayActive(log, t);
  let d = todayDone ? t : shiftIso(t, -1);
  let days = 0;
  let frozen = null; // последний по времени день, прикрытый заморозкой
  let lastFreeze = null; // для правила «одна на семь дней» при обходе назад
  for (let i = 0; i < LOG_DAYS + 7; i++) {
    if (dayActive(log, d)) {
      days++;
    } else {
      const gap = lastFreeze ? daysBetween(d, lastFreeze) : Infinity;
      if (gap < 7) break;
      // Пропуск после начала истории — не заморозка, а её край.
      if (!Object.keys(log).some((k) => k < d && dayActive(log, k))) break;
      lastFreeze = d;
      if (!frozen) frozen = d;
    }
    d = shiftIso(d, -1);
  }
  return { days, todayDone, frozen: days ? frozen : null };
}

function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
}

export function streak() {
  return streakFrom(fullLog(), today());
}

export function todayLog() {
  const e = fullLog()[today()];
  return { r: (e && e.r) || 0, w: (e && e.w) || 0 };
}

// Сколько слов придёт завтра и за ближайшие семь дней — как прогноз в Anki и WaniKani.
// Слово считается в тот день, когда созреет первая его карточка. Сегодняшнее сюда
// не входит: оно уже в «к повторению». Выученное тоже: его подмешивается не больше трёх.
export function forecast() {
  const t = today();
  const tomorrow = addDays(1);
  const week = addDays(7);
  const first = new Map();
  for (const key of Object.keys(state.cards)) {
    if (!isLiveKey(key)) continue;
    const c = state.cards[key];
    if (c.arch || c.due <= t || c.due > week) continue;
    const id = parseKey(key).wordId;
    if (!first.has(id) || c.due < first.get(id)) first.set(id, c.due);
  }
  // Слово, у которого другая карточка созрела уже сегодня, придёт сегодня — не считаем.
  let tom = 0;
  let wk = 0;
  for (const [id, due] of first) {
    if (wordCards(id).some((c) => !c.arch && c.due <= t)) continue;
    wk++;
    if (due <= tomorrow) tom++;
  }
  return { tomorrow: tom, week: wk };
}
