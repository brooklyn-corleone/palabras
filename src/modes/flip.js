// Режим flip — карточка с переворотом, ES→RU. Узнавание с самооценкой.
// Потолок режима — коробка 3: «вспомнил при виде слова» это не то же самое,
// что вспомнить слово с нуля, и двигать выше по такому ответу нечестно.

import { el, replace } from '../dom.js';

const DIR_LABEL = 'Испанский → Русский';
const HALF_FLIP = 120; // половина переворота, вторая половина доигрывается в CSS

export function render({ word, card, onAnswer, onArchive }) {
  const root = el('div', { class: 'mode' });

  function head() {
    return el(
      'div',
      { class: 'dir' },
      el('span', { text: DIR_LABEL + ' · ' + (card.arch ? 'архив' : 'коробка ' + card.box) }),
      onArchive ? el('button', { class: 'mini', onclick: onArchive }, 'в архив') : null,
    );
  }

  // Гасим лицевую сторону, на середине подменяем содержимое, показываем обратную.
  // При prefers-reduced-motion меняем сразу — анимация тут украшение, а не смысл.
  function flipTo(build) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      build();
      return;
    }
    root.classList.add('flip-out');
    setTimeout(() => {
      build();
      root.classList.remove('flip-out');
      root.classList.add('flip-in');
      setTimeout(() => root.classList.remove('flip-in'), HALF_FLIP * 2);
    }, HALF_FLIP);
  }

  // ---- лицевая сторона ------------------------------------------------------
  function ask() {
    replace(
      root,
      head(),
      el('div', { class: 'prompt', text: word.es }),
      el(
        'div',
        { class: 'row' },
        el(
          'button',
          { class: 'btn', dataset: { key: 'space' }, onclick: () => flipTo(reveal) },
          'Показать',
          el('kbd', { text: 'Пробел' }),
        ),
      ),
    );
  }

  // ---- обратная сторона -----------------------------------------------------
  function reveal() {
    replace(
      root,
      head(),
      el('div', { class: 'prompt', text: word.es }),
      el(
        'div',
        { class: 'verdict ok' },
        el('span', { class: 'lbl', text: 'Перевод' }),
        el('b', { text: word.ru }),
      ),
      el(
        'div',
        { class: 'row' },
        el(
          'button',
          { class: 'btn bad', dataset: { key: '1' }, onclick: () => onAnswer(false) },
          'Не помнил',
          el('kbd', { text: '1' }),
        ),
        el(
          'button',
          { class: 'btn good', dataset: { key: '2' }, onclick: () => onAnswer(true) },
          'Помнил',
          el('kbd', { text: '2' }),
        ),
      ),
    );
  }

  ask();
  return root;
}
