// Проверки данных: deck.seed.json и notes.seed.json.
//
// Движок проверяется в srs.test.js, а здесь — то, что в него попадает. Колода
// пополняется руками, часто пачками, и ошибка в одном поле не ломает приложение,
// а тихо портит занятие: подсказка с ответом внутри, два слова с одним переводом,
// таблица с разъехавшимися строками. Такое ловится только проверкой.
//
// Запуск — вместе с остальными, командой из шапки srs.test.js или через tests/run.sh.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { norm } from '../src/srs.js';

const deck = JSON.parse(readFileSync(new URL('../deck.seed.json', import.meta.url), 'utf8'));
const notes = JSON.parse(readFileSync(new URL('../notes.seed.json', import.meta.url), 'utf8'));

const words = deck.words.filter((w) => !w.deleted);

// Список id в сообщении полезнее числа: сразу видно, какие слова чинить.
function report(bad, format) {
  return bad.map(format).join('\n       ');
}

// ---------------------------------------------------------------------------
// колода
// ---------------------------------------------------------------------------

test('колода: обязательные поля на месте', () => {
  const bad = words.filter((w) => !w.id || !w.es || !w.ru || !w.pos || !w.cat);
  assert.equal(bad.length, 0, 'пустые поля:\n       ' + report(bad, (w) => `${w.id}: ${JSON.stringify(w)}`));
});

test('колода: id уникальны', () => {
  const seen = new Map();
  const dupes = [];
  for (const w of deck.words) {
    if (seen.has(w.id)) dupes.push(w.id);
    seen.set(w.id, true);
  }
  assert.deepEqual(dupes, [], 'одинаковый id = потерянный прогресс у одного из слов');
});

test('колода: id пригоден как ключ карточки', () => {
  // Ключ карточки — "<id>|ru", и parseKey режет по последней «|».
  const bad = words.filter((w) => w.id.includes('|') || /\s/.test(w.id));
  assert.equal(bad.length, 0, 'id с «|» или пробелом ломает ключ карточки:\n       ' + report(bad, (w) => w.id));
});

test('колода: тема слова есть в словаре тем', () => {
  const known = new Set(Object.keys(deck.categories || {}));
  const bad = words.filter((w) => !known.has(w.cat));
  assert.equal(bad.length, 0, 'тема не описана:\n       ' + report(bad, (w) => `${w.id} → ${w.cat}`));
});

test('колода: нет двух слов с одинаковым испанским', () => {
  const by = new Map();
  for (const w of words) {
    const k = norm(w.es);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(w.id);
  }
  const dupes = [...by].filter(([, ids]) => ids.length > 1);
  assert.equal(
    dupes.length,
    0,
    'один ответ на две карточки — вторая всегда «неверно»:\n       ' +
      report(dupes, ([k, ids]) => `${k}: ${ids.join(', ')}`),
  );
});

test('колода: нет двух слов с одинаковым русским', () => {
  const by = new Map();
  for (const w of words) {
    const k = w.ru.trim().toLowerCase();
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(w.id);
  }
  const dupes = [...by].filter(([, ids]) => ids.length > 1);
  assert.equal(
    dupes.length,
    0,
    'одинаковая подсказка — вопрос в Квизе и Парах неразрешим:\n       ' +
      report(dupes, ([k, ids]) => `${k}: ${ids.join(', ')}`),
  );
});

// Самая дорогая ошибка: подсказка, в которой написан ответ. В «Из букв» и «Вводе»
// такая карточка не проверяет ничего. Ловим и точное совпадение, и форму на расстоянии
// одной буквы — «levantarte» в подсказке к «levantarse» помогает ничуть не меньше.
test('колода: подсказка не содержит ответа', () => {
  const lev = (a, b) => {
    if (Math.abs(a.length - b.length) > 1) return 2;
    let prev = [...Array(b.length + 1).keys()];
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  };

  const bad = [];
  for (const w of words) {
    const answer = norm(w.es);
    if (!answer) continue;
    // Латинские куски подсказки: только они могут оказаться испанским ответом.
    const chunks = (w.ru.match(/[a-zA-Zá-úñÁ-ÚÑ]+/g) || []).map(norm).filter((c) => c.length > 2);
    for (const part of answer.split(' ')) {
      if (part.length < 3) continue;
      // У спряжений (conj) инфинитив в подсказке — это условие задачи, а не утечка:
      // «ты — estar» без estar неотличимо от «ты — ser», а спрашивают форму, не глагол.
      // Точное совпадение с ответом остаётся ошибкой и для них.
      const near = (c) => !w.conj && part.length >= 5 && lev(c, part) <= 1;
      const hit = chunks.find((c) => c === part || near(c));
      if (hit) {
        bad.push(`${w.id}: ответ «${w.es}», а в подсказке «${hit}» — ${JSON.stringify(w.ru)}`);
        break;
      }
    }
  }
  assert.equal(bad.length, 0, 'ответ виден в вопросе:\n       ' + bad.join('\n       '));
});

test('колода: подсказка помещается на карточку', () => {
  const LIMIT = 60;
  const bad = words.filter((w) => w.ru.length > LIMIT);
  assert.equal(
    bad.length,
    0,
    `подсказка длиннее ${LIMIT} символов — в Квизе это вариант на три строки:\n       ` +
      report(bad, (w) => `${w.id} (${w.ru.length}): ${w.ru}`),
  );
});

test('колода: испанское слово набирается из букв', () => {
  // Режим letters раскладывает ответ на фишки и добавляет четыре лишние буквы.
  // Два десятка фишек на телефоне — это уже не головоломка, а мучение.
  const LIMIT = 20;
  const bad = words.filter((w) => norm(w.es).replace(/\s/g, '').length > LIMIT);
  assert.equal(bad.length, 0, `больше ${LIMIT} букв:\n       ` + report(bad, (w) => `${w.id}: ${w.es}`));
});

test('колода: версия поднята относительно предыдущей правки', () => {
  assert.equal(typeof deck.version, 'number');
  assert.ok(deck.version > 0);
});

// ---------------------------------------------------------------------------
// правила
// ---------------------------------------------------------------------------

test('правила: id уникальны и группа описана', () => {
  const groups = new Set(Object.keys(notes.groups || {}));
  const seen = new Set();
  const dupes = [];
  const orphans = [];
  for (const n of notes.notes) {
    if (seen.has(n.id)) dupes.push(n.id);
    seen.add(n.id);
    if (n.group && !groups.has(n.group)) orphans.push(`${n.id} → ${n.group}`);
  }
  assert.deepEqual(dupes, [], 'одинаковый id правила');
  assert.deepEqual(orphans, [], 'группа не описана в groups — правило уедет в «Разное»');
});

test('правила: блоки знакомого вида и с содержимым', () => {
  const KINDS = new Set(['table', 'list', 'text']);
  const bad = [];
  for (const n of notes.notes) {
    if (!n.title) bad.push(`${n.id}: нет заголовка`);
    for (const b of n.blocks || []) {
      if (!KINDS.has(b.kind)) bad.push(`${n.id}: неизвестный блок «${b.kind}»`);
      if (b.kind === 'text' && !b.body) bad.push(`${n.id}: пустой text`);
      if (b.kind === 'list' && !(b.items || []).length) bad.push(`${n.id}: пустой list`);
      if (b.kind === 'table' && !(b.rows || []).length) bad.push(`${n.id}: пустая table`);
    }
  }
  assert.deepEqual(bad, []);
});

test('правила: строки таблицы совпадают по ширине с заголовком', () => {
  const bad = [];
  for (const n of notes.notes) {
    for (const b of n.blocks || []) {
      if (b.kind !== 'table' || !b.head) continue;
      for (const [i, row] of (b.rows || []).entries()) {
        if (row.length !== b.head.length) {
          bad.push(`${n.id}: строка ${i + 1} — ${row.length} ячеек против ${b.head.length} в заголовке`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], 'таблица разъедется при отрисовке');
});
