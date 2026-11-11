// Правила и таблицы — второй тип содержимого рядом со словами.
// Их не спрашивают и не оценивают: они лежат в разделе «Правила» и вдобавок
// иногда сами всплывают между карточками, чтобы попадаться на глаза без усилий.
//
// Пополняются так же, как колода: дописал в notes.seed.json → git push → появилось у всех.
//
// Правило состоит из заголовка и блоков. Блок бывает трёх видов: table, list, text.
// Так одно правило может смешивать таблицу спряжения, перечень исключений и пояснение,
// а рисуется всё одним кодом.

import { el, replace } from './dom.js';
import { state, save, now, wordById } from './state.js';

// Примерно одна подсказка на столько карточек. Реже — забудется, чаще — начнёт мешать.
const EVERY = 8;

let notes = [];
let groups = {};

// Связь правил со словами: у правила в notes.seed.json есть `words` (id слов) и `cats`
// (темы колоды). Ссылка живёт в правилах, а не в словах: так её не нужно тащить через
// пополнение колоды, и она работает и для слов, которые пользователь поправил руками
// (такие пополнение больше не трогает). Одно слово — одно правило, это проверяет тест.
let byWord = new Map();
let byCat = new Map();

function indexLinks() {
  byWord = new Map();
  byCat = new Map();
  for (const note of notes) {
    for (const id of note.words || []) if (!byWord.has(id)) byWord.set(id, note);
    for (const cat of note.cats || []) if (!byCat.has(cat)) byCat.set(cat, note);
  }
}

export function ruleFor(word) {
  if (!word) return null;
  return byWord.get(word.id) || (word.cat && byCat.get(word.cat)) || null;
}

export async function loadNotes() {
  try {
    const res = await fetch('notes.seed.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    notes = Array.isArray(data.notes) ? data.notes : [];
    groups = data.groups || {};
  } catch (e) {
    console.warn('правила недоступны, работаем без них:', e);
    notes = [];
    groups = {};
  }
  indexLinks();
  return notes.length;
}

export function count() {
  return notes.length;
}

export function all() {
  return notes;
}

// Группы в порядке из notes.seed.json, но только те, в которых что-то есть.
// Правило без группы попадает в «Разное» — чтобы не потерялось молча.
export function byGroup() {
  const order = Object.keys(groups);
  const buckets = new Map();
  for (const note of notes) {
    const code = note.group && groups[note.group] ? note.group : '';
    if (!buckets.has(code)) buckets.set(code, []);
    buckets.get(code).push(note);
  }
  const out = [];
  for (const code of order) {
    if (buckets.has(code)) out.push({ code, label: groups[code], notes: buckets.get(code) });
  }
  if (buckets.has('')) out.push({ code: '', label: 'Разное', notes: buckets.get('') });
  return out;
}

export function byId(id) {
  return notes.find((n) => n.id === id) || null;
}

// ---------------------------------------------------------------------------
// когда показывать между карточками
// ---------------------------------------------------------------------------

// Сколько карточек прошло с прошлой подсказки. Живёт в памяти сессии, а не в состоянии:
// после перезапуска счётчик логично начинать заново.
let sinceLast = 0;

export function countCard() {
  sinceLast++;
}

// Порог для правила по ошибке: сразу после промаха на экране и так ответ и ссылка
// «Правило», а через две карточки правило уже напоминание, а не продолжение ошибки.
const EVERY_MISS = 2;

export function shouldShow(missed) {
  if (!notes.length) return false;
  if (sinceLast >= EVERY_MISS && hasMissRule(missed)) return true;
  if (sinceLast < EVERY) return false;
  // Случайность, чтобы подсказка не приходила строго на каждой восьмой и не превращалась
  // в предсказуемый ритм: после порога шанс примерно один к трём на карточку.
  return Math.random() < 0.34;
}

// Правила, уже показанные в этом запуске. Нужны только выбору по ошибкам: одно и то же
// правило после каждого промаха в спряжении tener быстро превращается в шум.
const shownNow = new Set();

// Сначала — правило к слову, на котором только что ошиблись (missed — id слов, последний
// промах в конце), как Explain My Answer у Duolingo: правило полезно, когда видно,
// к чему оно. Нет такого — то, что не показывалось дольше всех: так пользователь
// увидит все правила, а не одно и то же по кругу.
// Возвращает { note, word } — word задан, если правило выбрано по ошибке.
export function pick(missed = []) {
  for (let i = missed.length - 1; i >= 0; i--) {
    const word = wordById(missed[i]);
    const note = ruleFor(word);
    if (note && !shownNow.has(note.id)) return { note, word };
  }
  const seen = state.notesSeen || {};
  let best = null;
  let bestSeen = null;
  for (const note of notes) {
    const at = seen[note.id] || '';
    if (best === null || at < bestSeen) {
      best = note;
      bestSeen = at;
    }
  }
  return best ? { note: best, word: null } : null;
}

// Есть ли правило к недавней ошибке, ещё не показанное. Такое правило приходит раньше
// обычного порога: через пару карточек после промаха, а не через восемь.
export function hasMissRule(missed = []) {
  return missed.some((id) => {
    const note = ruleFor(wordById(id));
    return note && !shownNow.has(note.id);
  });
}

export function markSeen(id) {
  if (!state.notesSeen) state.notesSeen = {};
  state.notesSeen[id] = now();
  shownNow.add(id);
  sinceLast = 0;
  save();
}

// ---------------------------------------------------------------------------
// отрисовка
// ---------------------------------------------------------------------------

function table(block) {
  const head = block.head || [];
  const rows = block.rows || [];
  return el(
    'div',
    { class: 'note-table-wrap' },
    el(
      'table',
      { class: 'note-table' },
      head.length
        ? el(
            'thead',
            null,
            el(
              'tr',
              null,
              head.map((h) => el('th', { text: h })),
            ),
          )
        : null,
      el(
        'tbody',
        null,
        rows.map((row) =>
          el(
            'tr',
            null,
            row.map((cell, i) =>
              i === 0 ? el('th', { scope: 'row', text: cell }) : el('td', { text: cell }),
            ),
          ),
        ),
      ),
    ),
  );
}

function list(block) {
  return el(
    'div',
    { class: 'note-block' },
    block.title ? el('div', { class: 'cap note-block-title', text: block.title }) : null,
    el(
      'ul',
      { class: 'note-list' },
      (block.items || []).map((item) => el('li', { text: item })),
    ),
  );
}

// Правило целиком, без заголовка и кнопок — общее для карточки в занятии
// и для экрана «Правила».
export function renderBlocks(note) {
  // Старый формат (kind прямо на правиле) поддерживаем, чтобы уже опубликованный
  // notes.seed.json не ломал приложение до того, как доедет новый.
  const blocks = note.blocks || [
    note.kind === 'table' ? { kind: 'table', head: note.head, rows: note.rows } : null,
    note.body ? { kind: 'text', body: note.body } : null,
    note.note ? { kind: 'text', body: note.note } : null,
  ].filter(Boolean);

  return blocks.map((block) => {
    if (block.kind === 'table') return table(block);
    if (block.kind === 'list') return list(block);
    return el('p', { class: 'note-body', text: block.body || '' });
  });
}

// Правило как карточка внутри занятия. word — слово, на котором ошиблись, если правило
// выбрано по ошибке: подпись объясняет, почему именно это правило и именно сейчас.
export function render({ note, word, onDone }) {
  return el(
    'div',
    { class: 'mode note' },
    el(
      'div',
      { class: 'dir' },
      word
        ? el('span', null, 'Правило к слову ', el('span', { lang: 'es', text: word.es }))
        : el('span', { text: 'Подсказка' }),
    ),
    el('h2', { class: 'note-title', text: note.title || '' }),
    renderBlocks(note),
    el(
      'div',
      { class: 'row' },
      el(
        'button',
        { class: 'btn', dataset: { key: 'enter' }, onclick: onDone },
        'Понятно',
        el('kbd', { text: 'Enter' }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// правило поверх карточки
// ---------------------------------------------------------------------------

// Ссылка «Правило» в ответе. Открывает правило окном поверх карточки, а не вместо неё:
// после закрытия на экране тот же разбор ответа с той же кнопкой «Дальше».
export function ruleLink(note) {
  if (!note) return null;
  return el(
    'button',
    {
      class: 'mini rule-link',
      type: 'button',
      onclick: (e) => {
        e.stopPropagation();
        openRule(note, e.currentTarget);
      },
    },
    'Правило: ' + (note.title || ''),
  );
}

let opener = null;

export function openRule(note, from) {
  const sheet = document.getElementById('sheet');
  if (!sheet) return;
  opener = from || document.activeElement;
  document.getElementById('sheet-title').textContent = note.title || '';
  replace(document.getElementById('sheet-body'), renderBlocks(note));
  if (typeof sheet.showModal === 'function') sheet.showModal();
  else sheet.setAttribute('open', '');
  sheet.scrollTop = 0;
  markSeen(note.id);
}

export function closeRule() {
  const sheet = document.getElementById('sheet');
  if (!sheet || !sheet.hasAttribute('open')) return;
  if (typeof sheet.close === 'function') sheet.close();
  else sheet.removeAttribute('open');
}

export function bindSheet() {
  const sheet = document.getElementById('sheet');
  if (!sheet) return;
  document.getElementById('sheet-close').addEventListener('click', closeRule);
  // Касание по затемнённому фону закрывает окно, как лист в iOS. Сам фон — это
  // ::backdrop, и клик по нему приходит в dialog с целью — самим dialog.
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) closeRule();
  });
  // Фокус возвращаем туда, откуда открыли, — к ссылке «Правило» рядом с ответом.
  sheet.addEventListener('close', () => {
    if (opener && opener.isConnected) opener.focus();
    opener = null;
  });
}
