// Режим letters — собрать испанское слово из букв. Между выбором из вариантов и чистым
// вводом: порядок букв вспоминать приходится самому, но алфавит подсказан.
// Поэтому потолок — коробка 4, пятая остаётся за режимом type.

import { el, replace } from '../dom.js';
import { norm } from '../srs.js';

const DIR_LABEL = 'Русский → Испанский';
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
// в ответе всё равно засчитывается (см. norm в srs.js). Вопросительные ¿ ? и
// восклицательные ¡ ! тоже убираем — это не буквы, а лишние фишки в наборе.
function puzzleTarget(es) {
  return es
    .replace(/^(el|la|los|las|un|una)\s+/i, '')
    .replace(/[¿?¡!]/g, '')
    .trim();
}

// Где в цели стоят пробелы, в координатах строки без пробелов: число — сколько букв
// стоит слева от пробела. Пробел фишкой не выдаётся, поэтому в собранное слово его
// подставляет сам режим: иначе «de vez en cuando» читается как «devezencuando»
// и проверить себя перед нажатием «Проверить» невозможно.
//
// Границы слов открываются постепенно, по мере набора, а общая длина ответа
// по-прежнему не видна — ради этого в наборе и лежат лишние буквы.
function spaceGaps(target) {
  const gaps = new Set();
  let letters = 0;
  for (const ch of target) {
    if (ch === ' ') gaps.add(letters);
    else letters++;
  }
  return gaps;
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

export function render({
  word,
  card,
  onAnswer,
  onArchive,
  onFlag,
  onSkipFormat,
  flagged: initFlagged,
}) {
  const root = el('div', { class: 'mode' });
  const target = puzzleTarget(word.es);
  const bank = buildBank(target);
  const gaps = spaceGaps(target);
  const used = new Set(); // индексы букв, уже поставленных в ответ
  const picked = []; // индексы в порядке нажатия

  let answered = false;
  let flagged = !!initFlagged;

  // Кнопка «проблема» видна всегда, в отличие от «в архив»: собрать слово из букв —
  // единственный режим, где сама головоломка (а не только перевод) может подвести,
  // и пожаловаться на неё должно быть можно в любой момент, а не только на части экранов.
  // Переключаем прямо в узле, не перерисовывая весь экран: иначе слетит набранное слово.
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
    // «не из букв» — жалоба не на слово, а на формат: перевод в порядке, а головоломка
    // не работает. Слово остаётся в колоде и в остальных форматах, а здесь больше
    // не появится. Сразу уходим на следующую карточку: доигрывать пазл, который только
    // что назвали негодным, незачем.
    const skipBtn = onSkipFormat
      ? el('button', { class: 'mini', onclick: () => onSkipFormat(true) }, 'не из букв')
      : null;

    return el(
      'div',
      { class: 'dir dir-crowded' },
      el('span', { text: DIR_LABEL + ' · ' + (card.arch ? 'архив' : 'коробка ' + card.box) }),
      onArchive ? el('button', { class: 'mini', onclick: onArchive }, 'в архив') : null,
      flagBtn,
      skipBtn,
    );
  }

  function typed() {
    // Пробел ставим перед буквой, а не после: так в конце строки не висит лишний,
    // когда набор остановился ровно на границе слов.
    return picked.map((idx, i) => (i > 0 && gaps.has(i) ? ' ' : '') + bank[idx]).join('');
  }

  function draw() {
    replace(
      root,
      head(),
      el('div', { class: 'prompt', text: word.ru }),
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

  // Пробелы в собранной строке расставлены автоматически (см. spaceGaps), а не выбраны
  // пользователем, так что спрашивать их при сравнении нечестно и незачем: сверяем
  // только буквы. Заодно любая цель из нескольких слов остаётся решаемой,
  // даже если её пробелы разойдутся с пробелами в цели.
  function flat(s) {
    return norm(s).replace(/\s+/g, '');
  }

  function check(giveUp) {
    if (answered) return;
    const correct = giveUp !== true && flat(typed()) === flat(target);
    answered = true;

    replace(
      root,
      head(),
      el('div', { class: 'prompt', text: word.ru }),
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
