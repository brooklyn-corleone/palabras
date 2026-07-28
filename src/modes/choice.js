// Режим choice — выбор из трёх вариантов. Самый лёгкий способ вспомнить слово,
// поэтому потолок — коробка 3: узнавание среди вариантов ещё не значит знание.

import { el, replace } from '../dom.js';
import { pickDistractors } from '../srs.js';

const OPTIONS = 3;

export function render({ word, card, dir, onAnswer, onArchive }) {
  const root = el('div', { class: 'mode' });

  const asking = dir === 'es' ? word.es : word.ua;
  const answer = dir === 'es' ? word.ua : word.es;
  const label = dir === 'es' ? 'Испанский → Украинский' : 'Украинский → Испанский';

  const options = [answer, ...pickDistractors(word, dir, OPTIONS - 1).map((w) => (dir === 'es' ? w.ua : w.es))];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }

  let answered = false;

  function head() {
    return el(
      'div',
      { class: 'dir' },
      el('span', { text: label + ' · ' + (card.arch ? 'архив' : 'коробка ' + card.box) }),
      onArchive ? el('button', { class: 'mini', onclick: onArchive }, 'в архив') : null,
    );
  }

  // После ответа варианты не исчезают: важно увидеть, что было правильным, рядом
  // с тем, что выбрал. Поэтому подсвечиваем и ждём отдельного шага «дальше».
  function choose(value, button) {
    if (answered) return;
    answered = true;
    const correct = value === answer;

    for (const btn of root.querySelectorAll('.option')) {
      btn.disabled = true;
      if (btn.dataset.value === answer) btn.classList.add('is-right');
    }
    if (!correct) button.classList.add('is-wrong');

    replace(
      root.querySelector('.row'),
      el(
        'button',
        {
          class: 'btn',
          dataset: { key: 'enter' },
          onclick: () => onAnswer(correct),
        },
        'Дальше',
        el('kbd', { text: 'Enter' }),
      ),
    );
    root.querySelector('[data-key="enter"]').focus();
  }

  replace(
    root,
    head(),
    el('div', { class: 'prompt', text: asking }),
    el(
      'div',
      { class: 'options' },
      options.map((value, i) => {
        const btn = el(
          'button',
          { class: 'option', dataset: { value, key: String(i + 1) } },
          el('span', { class: 'option-num', text: String(i + 1) }),
          el('span', { text: value }),
        );
        btn.addEventListener('click', () => choose(value, btn));
        return btn;
      }),
    ),
    el('div', { class: 'row' }),
  );

  return root;
}
