// Правила и таблицы — второй тип содержимого рядом со словами.
// Их не спрашивают и не оценивают: они лежат в разделе «Правила» и вдобавок
// иногда сами всплывают между карточками, чтобы попадаться на глаза без усилий.
//
// Пополняются так же, как колода: дописал в notes.seed.json → git push → появилось у всех.
//
// Правило состоит из заголовка и блоков. Блок бывает трёх видов: table, list, text.
// Так одно правило может смешивать таблицу спряжения, перечень исключений и пояснение,
// а рисуется всё одним кодом.

import { el } from './dom.js';
import { state, save, now } from './state.js';

// Примерно одна подсказка на столько карточек. Реже — забудется, чаще — начнёт мешать.
const EVERY = 8;

let notes = [];
let groups = {};

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

export function shouldShow() {
  if (!notes.length || sinceLast < EVERY) return false;
  // Случайность, чтобы подсказка не приходила строго на каждой восьмой и не превращалась
  // в предсказуемый ритм: после порога шанс примерно один к трём на карточку.
  return Math.random() < 0.34;
}

// Берём ту, что не показывалась дольше всех: так пользователь увидит все правила,
// а не одно и то же по кругу.
export function pick() {
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
  return best;
}

export function markSeen(id) {
  if (!state.notesSeen) state.notesSeen = {};
  state.notesSeen[id] = now();
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

// Правило как карточка внутри занятия.
export function render({ note, onDone }) {
  return el(
    'div',
    { class: 'mode note' },
    el('div', { class: 'dir' }, el('span', { text: 'Подсказка' })),
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
