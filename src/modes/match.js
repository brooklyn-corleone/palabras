// Режим match — сопоставление двух колонок. Разминка в начале сессии, а не проверка:
// коробки вверх не двигает вообще (MAX_BOX.match = 0), а за промах штрафует мягко,
// потому что половина ошибок тут — это промах пальцем, а не незнание.
//
// Интерфейс отличается от остальных режимов: карточка не одна, а пачка пар.
// Поэтому вместо onAnswer здесь onMiss на каждую неверную пару и onDone в конце.

import { el, replace } from '../dom.js';

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function render({ words, onMiss, onDone }) {
  const root = el('div', { class: 'mode' });

  // Колонки перемешиваются независимо, иначе пары окажутся друг напротив друга.
  const left = shuffle(words.map((w) => ({ id: w.id, text: w.es })));
  const right = shuffle(words.map((w) => ({ id: w.id, text: w.ua })));

  const solved = new Set();
  let pickedLeft = null;
  let locked = false;

  function finishIfDone() {
    if (solved.size !== words.length) return;
    replace(
      root.querySelector('.row'),
      el(
        'button',
        { class: 'btn', dataset: { key: 'enter' }, onclick: onDone },
        'Дальше',
        el('kbd', { text: 'Enter' }),
      ),
    );
    root.querySelector('[data-key="enter"]').focus();
  }

  function cell(item, side) {
    const btn = el(
      'button',
      { class: 'pair', dataset: { id: item.id, side }, text: item.text },
    );
    btn.addEventListener('click', () => {
      if (locked || solved.has(item.id)) return;

      if (side === 'left') {
        for (const b of root.querySelectorAll('.pair[data-side="left"]')) {
          b.classList.remove('is-picked');
        }
        pickedLeft = item.id;
        btn.classList.add('is-picked');
        return;
      }

      if (!pickedLeft) return;

      if (pickedLeft === item.id) {
        solved.add(item.id);
        for (const b of root.querySelectorAll('.pair[data-id="' + item.id + '"]')) {
          b.classList.remove('is-picked');
          b.classList.add('is-solved');
          b.disabled = true;
        }
        pickedLeft = null;
        finishIfDone();
        return;
      }

      // Неверная пара: короткая подсветка и разрыв, чтобы ошибка была заметна,
      // но не требовала отдельного клика «понял».
      const wrongLeft = root.querySelector('.pair[data-side="left"].is-picked');
      onMiss(pickedLeft);
      locked = true;
      btn.classList.add('is-wrong');
      if (wrongLeft) wrongLeft.classList.add('is-wrong');
      setTimeout(() => {
        btn.classList.remove('is-wrong');
        if (wrongLeft) wrongLeft.classList.remove('is-wrong', 'is-picked');
        pickedLeft = null;
        locked = false;
      }, 450);
    });
    return btn;
  }

  replace(
    root,
    el('div', { class: 'dir' }, el('span', { text: 'Разминка · соедини пары' })),
    el(
      'div',
      { class: 'match' },
      el('div', { class: 'match-col' }, left.map((i) => cell(i, 'left'))),
      el('div', { class: 'match-col' }, right.map((i) => cell(i, 'right'))),
    ),
    el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: onDone }, 'Пропустить')),
  );

  return root;
}
