// Режим flip — карточка с переворотом, ES→RU. Узнавание с самооценкой.
// Потолок режима — коробка 5: другого способа поднять es-карточку выше тройки нет
// (почему — в CLAUDE.md, «Режимы и веса»).

import { el, replace, announce } from '../dom.js';
import { sayable, autoSpeak } from '../speech.js';
import { stageLabel } from '../srs.js';
import { ruleLink } from '../notes.js';

const DIR_LABEL = 'Испанский → Русский';
const HALF_FLIP = 120; // половина переворота, вторая половина доигрывается в CSS

export function render({ word, card, onAnswer, onArchive, onFlag, flagged: initFlagged, rule }) {
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
      el('span', { text: DIR_LABEL + ' · ' + stageLabel(card) }),
      onArchive ? el('button', { class: 'mini', onclick: onArchive }, 'в архив') : null,
      flagBtn,
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
      sayable(el('div', { class: 'prompt', lang: 'es', text: word.es }), word.es),
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
    autoSpeak(word.es);
  }

  // ---- обратная сторона -----------------------------------------------------
  function reveal() {
    replace(
      root,
      head(),
      sayable(el('div', { class: 'prompt', lang: 'es', text: word.es }), word.es),
      el(
        'div',
        { class: 'verdict neutral' },
        el('span', { class: 'lbl', text: 'Перевод' }),
        el('b', { text: word.ru }),
        // Оборот нейтральный, «помнил или нет» решается кнопкой ниже — правило к слову
        // показываем при любом исходе.
        ruleLink(rule),
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
    announce('Перевод: ' + word.ru);
  }

  ask();
  return root;
}
