// Слияние для синхронизации через Gist (src/sync.js). Сеть не трогаем: проверяем чистые
// функции — кто побеждает при встрече двух устройств и что уезжает в гист.
//
//   sh tests/run.sh tests/sync.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeData, payload, cardRank, wordRank, parseRemote, parseGistId } from '../src/sync.js';

const FROM = '2026-01-01';

function seedWord(id, stamp = '2026-11-01T10:00:00.000Z') {
  return { id, es: 'la ' + id, ru: id, created: stamp, updated: stamp, deleted: false };
}

function fresh(stamp) {
  return { box: 1, due: '2026-11-01', arch: false, updated: stamp };
}

function device(words, cards, log = {}) {
  return { words, cards, log, peerLogs: {} };
}

test('выученная карточка побеждает нетронутую, даже заведённую позже', () => {
  // Телефон учил слово вчера, планшет впервые открыли сегодня — его карточка «новее».
  const tablet = device([seedWord('casa', '2026-11-10T09:00:00.000Z')], {
    'casa|es': fresh('2026-11-10T09:00:00.000Z'),
  });
  const phone = {
    words: [seedWord('casa')],
    cards: { 'casa|es': { box: 3, due: '2026-11-13', arch: false, seen: '2026-11-08', updated: '2026-11-09T20:00:00.000Z' } },
    logs: {},
  };
  const res = mergeData(tablet, phone, 'tablet', FROM);
  assert.equal(tablet.cards['casa|es'].box, 3);
  assert.equal(res.pulled, true);
});

test('из двух тронутых побеждает поздняя правка, и устройство с ней просит отправки', () => {
  const local = device([seedWord('casa')], {
    'casa|es': { box: 4, due: '2026-11-18', arch: false, seen: '2026-11-01', updated: '2026-11-10T12:00:00.000Z' },
  });
  const remote = {
    words: [seedWord('casa')],
    cards: { 'casa|es': { box: 2, due: '2026-11-11', arch: false, seen: '2026-11-01', updated: '2026-11-09T12:00:00.000Z' } },
    logs: {},
  };
  const res = mergeData(local, remote, 'a', FROM);
  assert.equal(local.cards['casa|es'].box, 4);
  assert.equal(res.pulled, false);
  assert.equal(res.ahead, true);
});

test('удаление с другого устройства приезжает, нетронутое слово его не воскрешает', () => {
  const local = device([seedWord('casa', '2026-11-10T09:00:00.000Z')], {});
  const gone = { ...seedWord('casa'), deleted: true, updated: '2026-11-05T10:00:00.000Z' };
  mergeData(local, { words: [gone], cards: {}, logs: {} }, 'a', FROM);
  assert.equal(local.words[0].deleted, true);
});

test('восстановленное слово не удаляется обратно старым tombstone', () => {
  const restored = { ...seedWord('casa'), deleted: false, updated: '2026-11-06T10:00:00.000Z' };
  const local = device([restored], {});
  const gone = { ...seedWord('casa'), deleted: true, updated: '2026-11-05T10:00:00.000Z' };
  mergeData(local, { words: [gone], cards: {}, logs: {} }, 'a', FROM);
  assert.equal(local.words[0].deleted, false);
});

test('слово, добавленное вручную на другом устройстве, приезжает вместе с карточками', () => {
  const local = device([seedWord('casa')], { 'casa|es': fresh('2026-11-01T10:00:00.000Z') });
  const mine = { id: 'u1', es: 'el gato', ru: 'кот', created: 'x', updated: 'x', edited: true };
  const res = mergeData(
    local,
    { words: [seedWord('casa'), mine], cards: { 'u1|es': fresh('x'), 'u1|ru': fresh('x') }, logs: {} },
    'a',
    FROM,
  );
  assert.ok(local.words.some((w) => w.id === 'u1'));
  assert.ok(local.cards['u1|ru']);
  assert.equal(res.pulled, true);
});

test('локальное, чего нет в гисте, ничем не стирается и просит отправки', () => {
  const local = device([seedWord('casa'), seedWord('mesa')], { 'mesa|es': fresh('x') });
  const res = mergeData(local, { words: [seedWord('casa')], cards: {}, logs: {} }, 'a', FROM);
  assert.equal(local.words.length, 2);
  assert.ok(local.cards['mesa|es']);
  assert.equal(res.ahead, true);
});

test('сброс прогресса побеждает старый прогресс другого устройства', () => {
  const reset = { box: 1, due: '2026-11-10', arch: false, reset: 'r', updated: '2026-11-10T08:00:00.000Z' };
  const old = { box: 5, due: '2026-11-20', arch: false, seen: '2026-10-01', updated: '2026-11-04T08:00:00.000Z' };
  assert.ok(cardRank(reset) > cardRank(old));
  assert.equal(cardRank(fresh('2026-11-10T08:00:00.000Z')), '');
  assert.equal(wordRank(seedWord('casa')), '');
});

test('одинаковые данные не просят ни забрать, ни отправить', () => {
  const words = [seedWord('casa')];
  const cards = { 'casa|es': { box: 2, due: '2026-11-12', arch: false, seen: '2026-11-10', updated: 't' } };
  const log = { '2026-11-10': { r: 12, w: 2 } };
  const local = device(structuredClone(words), structuredClone(cards), structuredClone(log));
  const remote = { words, cards, logs: { a: log } };
  assert.deepEqual(mergeData(local, remote, 'a', FROM), { pulled: false, ahead: false });
});

test('журналы устройств хранятся раздельно и сливаются максимумом', () => {
  const local = device([], {}, { '2026-11-10': { r: 5, w: 1 } });
  local.peerLogs.tablet = { '2026-11-10': { r: 8, w: 0 } };
  // В гисте устаревшая копия журнала планшета, отправленная третьим устройством,
  // и свежие ответы ноутбука.
  const remote = {
    words: [],
    cards: {},
    logs: {
      tablet: { '2026-11-10': { r: 3, w: 0 } },
      laptop: { '2026-11-10': { r: 4, w: 2, clear: true }, '2025-01-01': { r: 1, w: 0 } },
      a: { '2026-11-10': { r: 1, w: 0 } },
    },
  };
  const res = mergeData(local, remote, 'a', FROM);
  assert.equal(local.peerLogs.tablet['2026-11-10'].r, 8);
  assert.deepEqual(local.peerLogs.laptop, { '2026-11-10': { r: 4, w: 2, clear: true } });
  assert.equal(local.log['2026-11-10'].r, 5, 'свой журнал из гиста не перетирается');
  assert.equal(res.pulled, true);
  assert.equal(res.ahead, true);
});

test('в гист уходят слова, карточки и журналы, но не настройки', () => {
  const s = {
    v: 4,
    deviceId: 'a',
    words: [seedWord('casa')],
    cards: {},
    log: { '2026-11-10': { r: 1, w: 0 } },
    peerLogs: { b: { '2026-11-09': { r: 2, w: 0 } } },
    settings: { goal: 20 },
    stats: { done: 3 },
  };
  const p = payload(s, FROM);
  assert.equal(p.app, 'palabras');
  assert.deepEqual(Object.keys(p.logs).sort(), ['a', 'b']);
  assert.equal(p.settings, undefined);
  assert.equal(p.stats, undefined);
});

test('чужой файл в гисте не принимается за колоду', () => {
  assert.throws(() => parseRemote('{"hello":1}'), { code: 'format' });
  assert.throws(() => parseRemote('не json'), { code: 'format' });
  assert.ok(parseRemote(JSON.stringify({ app: 'palabras', words: [], cards: {} })));
});

test('ID гиста принимается и адресом целиком', () => {
  assert.equal(parseGistId(''), '');
  assert.equal(parseGistId('https://gist.github.com/someone/aa5a315d61ae9438b18d/'), 'aa5a315d61ae9438b18d');
  assert.equal(parseGistId(' aa5a315d61ae9438b18d '), 'aa5a315d61ae9438b18d');
  assert.equal(parseGistId('что-то'), null);
});
