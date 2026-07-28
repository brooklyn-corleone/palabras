// Режим letters — собрать испанское слово из букв. Между выбором из вариантов и чистым
// вводом: порядок букв вспоминать приходится самому, но алфавит подсказан.
// Поэтому потолок — коробка 4, пятая остаётся за режимом type.

import { el, replace } from '../dom.js';
import { norm } from '../srs.js';

const DIR_LABEL = 'Украинский → Испанский';
const DECOYS = 4;
const EXTRA_LETTERS = 'aeiorstnlucdmpbgv';

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Артикль в головоломку не берём: он не про написание слова, а его отсутствие
// в ответе всё равно засчитывается (см. norm в srs.js).
function puzzleTarget(es) {
  return es.replace(/^(el|la|los|las|un|una)\s+/i, '').trim();
}

// Буквы слова плюс несколько лишних, чтобы набор не выдавал длину ответа целиком.
function buildBank(target) {
  const chars = [...target].filter((c) => c !== ' ');
  const decoys = [];
  const own = new Set(chars.map((c) => c.toLowerCase()));
  const pool = [...EXTRA_LETTERS].filter((c) => !own.has(c));
  shuffle(pool);
  for (let i = 0; i < DECOYS && i < pool.length; i++) decoys.push(pool[i]);
  return shuffle(chars.concat(decoys));
}

export function render({ word, card, onAnswer, onArchive }) {
  const root = el('div', { class: 'mode' });
  const target = puzzleTarget(word.es);
  const bank = buildBank(target);
  const used = new Set(); // индексы букв, уже поставленных в ответ
  const picked = []; // индексы в порядке нажатия

  let answered = false;

  function head() {
    return el(
      'div',
      { class: 'dir' },
      el('span', { text: DIR_LABEL + ' · ' + (card.arch ? 'архив' : 'коробка ' + card.box) }),
      onArchive ? el('button', { class: 'mini', onclick: onArchive }, 'в архив') : null,
    );
  }

  function typed() {
    return picked.map((i) => bank[i]).join('');
  }

  function draw() {
    replace(
      root,
      head(),
      el('div', { class: 'prompt', text: word.ua }),
      el('div', { class: 'assembled', text: typed() || ' ' }),
      el(
        'div',
        { class: 'bank' },
        bank.map((ch, i) =>
          el(
            'button',
            {
              class: 'chip' + (used.has(i) ? ' is-used' : ''),
              disabled: used.has(i) || undefined,
              onclick: () => {
                used.add(i);
                picked.push(i);
                draw();
              },
            },
            ch,
          ),
        ),
      ),
      el(
        'div',
        { class: 'row' },
        el(
          'button',
          {
            class: 'btn',
            dataset: { key: 'enter' },
            onclick: check,
          },
          'Проверить',
          el('kbd', { text: 'Enter' }),
        ),
        el(
          'button',
          {
            class: 'btn ghost',
            onclick: () => {
              const last = picked.pop();
              if (last !== undefined) used.delete(last);
              draw();
            },
          },
          'Стереть',
        ),
        el('button', { class: 'btn ghost', onclick: () => check(true) }, 'Не знаю'),
      ),
    );
  }

  function check(giveUp) {
    if (answered) return;
    const correct = giveUp !== true && norm(typed()) === norm(target);
    answered = true;

    replace(
      root,
      head(),
      el('div', { class: 'prompt', text: word.ua }),
      el(
        'div',
        { class: 'verdict ' + (correct ? 'ok' : 'no') },
        el('span', { class: 'lbl', text: correct ? 'Верно' : 'Правильный ответ' }),
        el('b', { text: word.es }),
      ),
      el(
        'div',
        { class: 'row' },
        el(
          'button',
          { class: 'btn', dataset: { key: 'enter' }, onclick: () => onAnswer(correct) },
          'Дальше',
          el('kbd', { text: 'Enter' }),
        ),
      ),
    );
    root.querySelector('[data-key="enter"]').focus();
  }

  draw();
  return root;
}
