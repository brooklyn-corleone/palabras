// Режим type — ввод текста, RU→ES. Активное воспроизведение: единственный режим,
// который поднимает карточку в коробки 4 и 5 (см. MAX_BOX в srs.js).

import { el, replace } from '../dom.js';
import { judge, accentMarks } from '../srs.js';

const DIR_LABEL = 'Русский → Испанский';

export function render({ word, card, onAnswer, onArchive, onFlag, flagged: initFlagged }) {
  const root = el('div', { class: 'mode' });
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
      el('span', { text: DIR_LABEL + ' · ' + (card.arch ? 'архив' : 'коробка ' + card.box) }),
      onArchive ? el('button', { class: 'mini', onclick: onArchive }, 'в архив') : null,
      flagBtn,
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
      // lang подсказывает iOS испанскую раскладку (á, ñ долгим нажатием), а enterkeyhint
      // подписывает клавишу ввода «Готово» вместо «return».
      lang: 'es',
      enterkeyhint: 'done',
      placeholder: 'escribe aquí…',
    });

    replace(
      root,
      head(),
      el('div', { class: 'prompt', text: word.ru }),
      input,
      el('div', { class: 'hint', text: 'Артикль не обязателен. Без ударения засчитаем, но покажем, где оно' }),
      el(
        'div',
        { class: 'row' },
        el(
          'button',
          {
            class: 'btn',
            dataset: { key: 'enter' },
            onclick: () => reveal(judge(input.value, word.es), input.value),
          },
          'Проверить',
          el('kbd', { text: 'Enter' }),
        ),
        el('button', { class: 'btn ghost', onclick: () => reveal('no', '') }, 'Не знаю'),
      ),
    );
    input.focus();
  }

  // ---- разбор ответа --------------------------------------------------------
  function reveal(verdict, typed) {
    const correct = verdict !== 'no';
    const marks = verdict === 'accent' ? accentMarks(typed, word.es) : null;
    const label = {
      ok: 'Верно',
      accent: accentLabel(marks),
      almost: 'Почти — опечатка',
      no: 'Правильный ответ',
    }[verdict];
    // Набранное показываем при любом расхождении, кроме ударения: там подсвечена сама
    // буква, а без своего ответа перед глазами не видно, в чём именно была ошибка.
    const shown = typed.trim();

    replace(
      root,
      head(),
      el('div', { class: 'prompt', text: word.ru }),
      el(
        'div',
        { class: 'verdict ' + (correct ? 'ok' : 'no') },
        el('span', { class: 'lbl', text: label }),
        answerText(marks),
        shown && (verdict === 'almost' || verdict === 'no')
          ? el('span', { class: 'typed' }, 'ваш ответ: ', el('span', { lang: 'es', text: shown }))
          : null,
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

  // «С ударением» про пропущенную тильду — неправда, а ñ стоит назвать отдельно:
  // это не знак над буквой, а другая буква алфавита.
  function accentLabel(marks) {
    const text = [...word.es.normalize('NFC').toLowerCase()];
    const missed = [...(marks || [])].map((i) => text[i]);
    const tilde = missed.filter((ch) => ch === 'ñ').length;
    if (tilde && tilde === missed.length) return 'Верно, но пишется через ñ';
    if (tilde) return 'Верно, но с ударением и ñ';
    return 'Верно, но с ударением';
  }

  // Правильный ответ с подсвеченными буквами, где пропущена диакритика.
  function answerText(marks) {
    const text = word.es.normalize('NFC');
    if (!marks || !marks.size) return el('b', { lang: 'es', text });
    return el(
      'b',
      { lang: 'es' },
      [...text].map((ch, i) => (marks.has(i) ? el('mark', { text: ch }) : ch)),
    );
  }

  ask();
  return root;
}
