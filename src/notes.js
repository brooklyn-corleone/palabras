// Правила и таблицы — второй тип содержимого рядом со словами.
// Их не спрашивают и не оценивают: они просто иногда всплывают между карточками,
// чтобы спряжение или правило попадалось на глаза само, без отдельного «раздела теории».
//
// Пополняются так же, как колода: дописал в notes.seed.json → git push → появилось у всех.

import { el } from './dom.js';
import { state, save, now } from './state.js';

// Примерно одна подсказка на столько карточек. Реже — забудется, чаще — начнёт мешать.
const EVERY = 8;

let notes = [];

export async function loadNotes() {
  try {
    const res = await fetch('notes.seed.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    notes = Array.isArray(data.notes) ? data.notes : [];
  } catch (e) {
    console.warn('правила недоступны, работаем без них:', e);
    notes = [];
  }
  return notes.length;
}

export function count() {
  return notes.length;
}

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

function renderTable(note) {
  const head = note.head || [];
  const rows = note.rows || [];
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

export function render({ note, onDone }) {
  return el(
    'div',
    { class: 'mode note' },
    el('div', { class: 'dir', text: 'Подсказка' }),
    el('h2', { class: 'note-title', text: note.title || '' }),
    note.kind === 'table' ? renderTable(note) : el('p', { class: 'note-body', text: note.body || '' }),
    note.note ? el('p', { class: 'note-body', text: note.note }) : null,
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
