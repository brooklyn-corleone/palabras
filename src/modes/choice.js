// Режим choice — выбор из трёх вариантов. Самый лёгкий способ вспомнить слово,
// поэтому потолок — коробка 3: узнавание среди вариантов ещё не значит знание.

import { el, replace, announce } from '../dom.js';
import { pickDistractors } from '../srs.js';

const OPTIONS = 3;

export function render({ word, card, dir, onAnswer, onArchive, onFlag, flagged: initFlagged }) {
  const root = el('div', { class: 'mode' });

  const asking = dir === 'es' ? word.es : word.ru;
  const answer = dir === 'es' ? word.ru : word.es;
  const label = dir === 'es' ? 'Испанский → Русский' : 'Русский → Испанский';

  const options = [answer, ...pickDistractors(word, dir, OPTIONS - 1).map((w) => (dir === 'es' ? w.ru : w.es))];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }

  let answered = false;
  let flagged = !!initFlagged;

  function head() {
    const flagBtn = el(
      'button',
      { class: 'mini' + (flagged ? ' flagged' : ''), 'aria-pressed': String(flagged) },
      flagged ? '✓ проблема' : 'проблема',
    );
    flagBtn.addEventListener('click', () => {
      flagged = !flagged;
      onFlag(flagged);
      flagBtn.classList.toggle('flagged', flagged);
      flagBtn.setAttribute('aria-pressed', String(flagged));
      flagBtn.textContent = flagged ? '✓ проблема' : 'проблема';
    });
    return el(
      'div',
      { class: 'dir' },
      el('span', { text: label + ' · ' + (card.arch ? 'архив' : 'коробка ' + card.box) }),
      onArchive ? el('button', { class: 'mini', onclick: onArchive }, 'в архив') : null,
      flagBtn,
    );
  }

  // После ответа варианты не исчезают: важно увидеть, что было правильным, рядом
  // с тем, что выбрал. Поэтому подсвечиваем и ждём отдельного шага «дальше».
  function choose(value, button) {
    if (answered) return;
    answered = true;
    const correct = value === answer;

    // Номер варианта меняем на ✓ / ✕: одним цветом рамки верное от неверного
    // не отличить при дейтеранопии, а номер после ответа уже не нужен.
    for (const btn of root.querySelectorAll('.option')) {
      btn.disabled = true;
      if (btn.dataset.value === answer) mark(btn, 'is-right', '✓', 'верно');
    }
    if (!correct) mark(button, 'is-wrong', '✕', 'ваш ответ');
    announce(correct ? 'Верно: ' + answer : 'Неверно. Правильный ответ: ' + answer);

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

  function mark(btn, cls, sign, spoken) {
    btn.classList.add(cls);
    const num = btn.querySelector('.option-num');
    num.textContent = sign;
    num.setAttribute('aria-label', spoken);
  }

  replace(
    root,
    head(),
    el('div', { class: 'prompt', lang: dir === 'es' ? 'es' : null, text: asking }),
    el(
      'div',
      { class: 'options' },
      options.map((value, i) => {
        const btn = el(
          'button',
          { class: 'option', lang: dir === 'es' ? null : 'es', dataset: { value, key: String(i + 1) } },
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
