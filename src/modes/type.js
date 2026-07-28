// Режим type — ввод текста, RU→ES. Активное воспроизведение: единственный режим,
// который поднимает карточку в коробки 4 и 5 (см. MAX_BOX в srs.js).

import { el, replace } from '../dom.js';
import { judge } from '../srs.js';

const DIR_LABEL = 'Русский → Испанский';

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

  // ---- ввод ответа ----------------------------------------------------------
  function ask() {
    const input = el('input', {
      type: 'text',
      id: 'answer',
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      placeholder: 'escribe aquí…',
    });

    replace(
      root,
      head(),
      el('div', { class: 'prompt', text: word.ru }),
      input,
      el('div', { class: 'hint', text: 'Артикль не обязателен, ударения можно не ставить' }),
      el(
        'div',
        { class: 'row' },
        el(
          'button',
          {
            class: 'btn',
            dataset: { key: 'enter' },
            onclick: () => reveal(judge(input.value, word.es)),
          },
          'Проверить',
          el('kbd', { text: 'Enter' }),
        ),
        el('button', { class: 'btn ghost', onclick: () => reveal('no') }, 'Не знаю'),
      ),
    );
    input.focus();
  }

  // ---- разбор ответа --------------------------------------------------------
  function reveal(verdict) {
    const correct = verdict === 'ok' || verdict === 'almost';
    const label =
      verdict === 'ok' ? 'Верно' : verdict === 'almost' ? 'Почти — опечатка' : 'Правильный ответ';

    replace(
      root,
      head(),
      el('div', { class: 'prompt', text: word.ru }),
      el(
        'div',
        { class: 'verdict ' + (correct ? 'ok' : 'no') },
        el('span', { class: 'lbl', text: label }),
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

  ask();
  return root;
}
