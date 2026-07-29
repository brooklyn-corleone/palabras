// Проверка логики повторений вне браузера. Двадцать с лишним сценариев: коробки,
// веса режимов, архив, сборка занятия, пополнение колоды.
//
// В обычном виде не запускается: node не съест ES-модули из src/ без package.json
// с {"type": "module"}, а CLAUDE.md запрещает всё, что похоже на шаг к npm.
// Поэтому запуск — во временной папке, одной командой:
//
//   T=$(mktemp -d) && cp -R src tests/srs.test.js "$T"/ \
//     && echo '{"type":"module"}' > "$T/package.json" \
//     && (cd "$T" && node --test)
//
// Если решишь, что package.json в репозитории всё-таки не грех, — положи его рядом
// и запускай просто `node --test`. Сайту он не мешает: Pages его не читает.

import test from 'node:test';
import assert from 'node:assert/strict';

import { state, load, today, addDays, addWord, updateWord, deleteWord, mergeSeed } from '../src/state.js';
import * as srs from '../src/srs.js';

await load();

function resetDeck() {
  state.words.length = 0;
  for (const k of Object.keys(state.cards)) delete state.cards[k];
  state.stats.done = 0;
}

let seq = 0;
function makeWord(es = 'la llave', ru = 'ключ') {
  seq++;
  return addWord({ es, ru, ex: 'ejemplo ' + seq });
}

// ---------------------------------------------------------------------------

test('norm снимает артикль, диакритику и пунктуацию', () => {
  assert.equal(srs.norm('El Teléfono!'), 'telefono');
  assert.equal(srs.norm('  la  Llave  '), 'llave');
  assert.equal(srs.norm('el niño'), 'nino');
});

test('judge: точное совпадение, опечатка, промах', () => {
  assert.equal(srs.judge('la llave', 'la llave'), 'ok');
  assert.equal(srs.judge('llave', 'la llave'), 'ok'); // артикль не обязателен
  assert.equal(srs.judge('telefono', 'el teléfono'), 'ok'); // ударение не обязательно
  assert.equal(srs.judge('llavve', 'la llave'), 'almost'); // одна лишняя буква
  assert.equal(srs.judge('puerta', 'la llave'), 'no');
  assert.equal(srs.judge('', 'la llave'), 'no');
});

test('type поднимает карточку до коробки 5 и там останавливается', () => {
  resetDeck();
  const w = makeWord();
  const key = w.id + '|ru';

  for (const expected of [2, 3, 4, 5, 5]) {
    const res = srs.grade(key, 'type', true);
    assert.equal(res.box, expected);
  }
  // Срок следующего повтора считается по интервалу коробки, а не по календарю сессии.
  assert.equal(state.cards[key].due, addDays(16));
});

test('flip не поднимает выше коробки 3 и не опускает того, кто уже выше', () => {
  resetDeck();
  const w = makeWord();
  const key = w.id + '|es';

  assert.equal(srs.grade(key, 'flip', true).box, 2);
  assert.equal(srs.grade(key, 'flip', true).box, 3);
  assert.equal(srs.grade(key, 'flip', true).box, 3); // потолок режима
  assert.equal(srs.grade(key, 'flip', true).box, 3);

  // Карточка, добравшаяся до 5 через ввод, не должна проседать от верного flip.
  state.cards[key].box = 5;
  assert.equal(srs.grade(key, 'flip', true).box, 5);
});

test('ошибка сбрасывает в коробку 1 и возвращает карточку в сессию', () => {
  resetDeck();
  const w = makeWord();
  const key = w.id + '|ru';
  srs.grade(key, 'type', true);
  srs.grade(key, 'type', true);
  assert.equal(state.cards[key].box, 3);

  const before = srs.queueLength();
  const res = srs.grade(key, 'type', false);
  assert.equal(res.box, 1);
  assert.equal(state.cards[key].due, today());
  assert.equal(srs.queueLength(), before + 1);
});

test('match не двигает вверх и штрафует мягко', () => {
  resetDeck();
  const w = makeWord();
  const key = w.id + '|ru';
  state.cards[key].box = 3;

  assert.equal(srs.grade(key, 'match', true).box, 3); // вверх не двигает
  assert.equal(srs.grade(key, 'match', false).box, 2); // минус одна, а не в единицу
  srs.grade(key, 'match', false);
  assert.equal(srs.grade(key, 'match', false).box, 1); // ниже первой не падает
});

test('архив: угадал — остался, забыл — вернулся во вторую коробку', () => {
  resetDeck();
  const w = makeWord();
  srs.archiveWord(w.id, true);
  const key = w.id + '|es';
  assert.equal(state.cards[key].arch, true);

  let res = srs.grade(key, 'flip', true);
  assert.equal(res.arch, true);
  assert.equal(res.counted, false, 'архивные не идут в дневную цель');

  res = srs.grade(key, 'flip', false);
  assert.equal(res.arch, false);
  assert.equal(res.box, 2);
  assert.equal(state.cards[key].due, today());
});

test('дневная цель считает только неархивные ответы', () => {
  resetDeck();
  const a = makeWord('uno', 'один');
  const b = makeWord('dos', 'два');
  srs.archiveWord(b.id, true);

  const before = state.stats.done;
  srs.grade(a.id + '|ru', 'type', true);
  srs.grade(b.id + '|es', 'flip', true);
  assert.equal(state.stats.done, before + 1);
});

test('очередь берёт только созревшие карточки и подмешивает архив', () => {
  resetDeck();
  const due = makeWord('hoy', 'сегодня');
  const later = makeWord('mañana', 'завтра');
  const archived = makeWord('viejo', 'старый');

  state.cards[later.id + '|es'].due = addDays(5);
  state.cards[later.id + '|ru'].due = addDays(5);
  srs.archiveWord(archived.id, true);

  srs.buildQueue();
  const keys = [];
  for (let key = srs.nextKey(); key; key = srs.nextKey()) {
    keys.push(key);
    if (keys.length > 20) break;
  }

  assert.ok(keys.includes(due.id + '|es'));
  assert.ok(keys.includes(due.id + '|ru'));
  assert.ok(!keys.includes(later.id + '|es'), 'несозревшая карточка не должна попасть в очередь');
  assert.ok(
    keys.some((k) => k.startsWith(archived.id)),
    'хотя бы одна архивная подмешивается',
  );
});

test('удалённое слово исчезает из очереди и не воскресает из колоды', async () => {
  resetDeck();
  const seed = {
    version: 42,
    words: [{ id: 'seed-test-1', es: 'la prueba', ru: 'проверка', pos: 'n', ex: 'Una prueba.' }],
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => seed });

  assert.equal(await mergeSeed(), 1, 'новое слово из колоды добавляется');
  assert.equal(await mergeSeed(), 0, 'повторный запуск ничего не дублирует');

  // Нетронутое слово обновляется из репозитория: опечатка в переводе чинится пушем.
  seed.words[0].ru = 'испытание';
  await mergeSeed();
  assert.equal(state.words.find((x) => x.id === 'seed-test-1').ru, 'испытание');

  // Как только пользователь правит слово сам, оно замерзает и пополнение его не трогает.
  updateWord('seed-test-1', { ru: 'мой перевод' });
  seed.words[0].ru = 'другое из репозитория';
  assert.equal(await mergeSeed(), 0);
  assert.equal(state.words.find((x) => x.id === 'seed-test-1').ru, 'мой перевод');

  // Удаление — tombstone, а не вычёркивание: иначе слово вернётся при следующем старте.
  deleteWord('seed-test-1');
  assert.equal(await mergeSeed(), 0, 'удалённое слово не воскресает');
  assert.equal(state.words.find((x) => x.id === 'seed-test-1').deleted, true);

  srs.buildQueue();
  const keys = [];
  for (let key = srs.nextKey(); key; key = srs.nextKey()) {
    keys.push(key);
    if (keys.length > 20) break;
  }
  assert.ok(!keys.some((k) => k.startsWith('seed-test-1')), 'удалённое не попадает в очередь');
});

test('pickMode: чем выше коробка, тем меньше подсказок', () => {
  resetDeck();
  const w = makeWord('la casa', 'дім');
  const es = w.id + '|es';
  const ua = w.id + '|ru';

  // Узнавание — всегда переворот или выбор из вариантов.
  for (let i = 0; i < 30; i++) {
    assert.ok(['flip', 'choice'].includes(srs.pickMode(es)));
  }

  const seen = new Set();
  for (const [box, allowed] of [
    [1, ['choice', 'letters']],
    [2, ['letters', 'type']],
    [3, ['letters', 'type']],
    [4, ['type']],
    [5, ['type']],
  ]) {
    state.cards[ua].box = box;
    for (let i = 0; i < 30; i++) {
      const mode = srs.pickMode(ua);
      assert.ok(allowed.includes(mode), 'коробка ' + box + ' не должна давать ' + mode);
      seen.add(mode);
    }
  }
  assert.ok(seen.has('letters') && seen.has('type') && seen.has('choice'), 'все режимы встречаются');

  // Главное следствие весов: в коробку 5 нельзя попасть ничем, кроме чистого ввода.
  state.cards[ua].box = 4;
  assert.equal(srs.pickMode(ua), 'type');
  assert.equal(srs.MAX_BOX.letters, 4);
  assert.equal(srs.MAX_BOX.choice, 3);
});

test('дистракторы не повторяют правильный ответ', () => {
  resetDeck();
  const target = makeWord('la casa', 'дім');
  makeWord('el piso', 'квартира');
  makeWord('la mesa', 'стіл');
  makeWord('la silla', 'стілець');

  const d = srs.pickDistractors(target, 'ru', 2);
  assert.equal(d.length, 2);
  assert.ok(!d.some((w) => w.id === target.id));
  assert.equal(new Set(d.map((w) => w.es)).size, 2, 'варианты не дублируются');
});

test('соседняя форма глагола не проходит как опечатка', () => {
  resetDeck();
  makeWord('estás', 'ти є — estar');
  makeWord('está', 'він/вона є — estar');
  makeWord('estoy', 'я є — estar');

  // «esta» — это отдельное слово колоды, а не промах пальцем по «estás».
  assert.equal(srs.judge('esta', 'estás'), 'no');
  assert.equal(srs.judge('estás', 'estás'), 'ok');
  assert.equal(srs.judge('estas', 'estás'), 'ok', 'ударение ставить не обязательно');

  // Короткие формы требуют точности: soy/son/es различаются одной буквой.
  resetDeck();
  makeWord('soy', 'я є — ser');
  assert.equal(srs.judge('son', 'soy'), 'no');
  assert.equal(srs.judge('so', 'soy'), 'no');
  assert.equal(srs.judge('soy', 'soy'), 'ok');
});


// Очередь source:'due' пересобирается сама, поэтому в тестах её всегда читаем с потолком.
function drain(limit = 60) {
  const out = [];
  for (let k = srs.nextKey(); k && out.length < limit; k = srs.nextKey()) out.push(k);
  return out;
}

test('занятие: лимит считается в словах, а не в карточках', () => {
  resetDeck();
  const words = [];
  for (let i = 0; i < 8; i++) words.push(makeWord('palabra' + i, 'слово' + i));

  srs.setSession({});
  assert.equal(srs.buildQueue(), 16, 'восемь слов — это шестнадцать карточек');

  assert.equal(srs.buildQueue({ source: 'due', size: 3, modes: new Set() }), 6);
  const limited = drain(6);
  assert.equal(new Set(limited.map((k) => k.split('|')[0])).size, 3);
  srs.setSession({});
});

test('занятие из выбранных слов берёт только их и заканчивается', () => {
  resetDeck();
  const a = makeWord('uno', 'один');
  const b = makeWord('dos', 'два');
  makeWord('tres', 'три');

  const picked = new Set([a.id, b.id]);
  srs.buildQueue({ source: 'picked', size: 0, modes: new Set(), picked });
  const got = drain();
  assert.equal(got.length, 4);
  assert.ok(got.every((k) => picked.has(k.split('|')[0])));
  // Очередь не пересобирается сама: занятие конечно по замыслу.
  assert.equal(srs.nextKey(), null);
  srs.setSession({});
});

test('выбранный руками режим задаёт направление карточек', () => {
  resetDeck();
  for (let i = 0; i < 4; i++) makeWord('palabra' + i, 'слово' + i);

  srs.buildQueue({ source: 'random', size: 0, modes: new Set(['type']), picked: null });
  const typed = drain();
  assert.ok(typed.length > 0);
  assert.ok(typed.every((k) => k.endsWith('|ru')), 'ввод — это всегда RU→ES');
  assert.equal(srs.pickMode(typed[0], new Set(['type'])), 'type');

  srs.buildQueue({ source: 'random', size: 0, modes: new Set(['flip']), picked: null });
  const flipped = drain();
  assert.ok(flipped.length > 0);
  assert.ok(flipped.every((k) => k.endsWith('|es')), 'карточки — это всегда ES→RU');
  assert.equal(srs.pickMode(flipped[0], new Set(['flip'])), 'flip');

  // Веса режимов принудительный выбор не отменяет.
  assert.equal(srs.MAX_BOX.flip, 3);
  srs.setSession({});
});

test('случайное занятие берёт слова независимо от срока повтора', () => {
  resetDeck();
  const w = makeWord('mañana', 'завтра');
  state.cards[w.id + '|es'].due = addDays(30);
  state.cards[w.id + '|ru'].due = addDays(30);

  srs.setSession({});
  assert.equal(srs.buildQueue(), 0, 'к повторению ничего нет');
  assert.equal(srs.buildQueue({ source: 'random', size: 0, modes: new Set() }), 2);
  srs.setSession({});
});

test('занятие по теме берёт только слова этой темы', () => {
  resetDeck();
  const a = addWord({ es: 'la madre', ru: 'мать' });
  const b = addWord({ es: 'el padre', ru: 'отец' });
  const c = addWord({ es: 'la cabeza', ru: 'голова' });
  a.cat = 'familia';
  b.cat = 'familia';
  c.cat = 'cuerpo';

  srs.buildQueue({ source: 'random', cats: new Set(['familia']), size: 0, modes: new Set() });
  const got = drain();
  assert.equal(got.length, 4, 'два слова темы — четыре карточки');
  const ids = new Set(got.map((k) => k.split('|')[0]));
  assert.ok(ids.has(a.id) && ids.has(b.id));
  assert.ok(!ids.has(c.id), 'чужая тема в занятие не попадает');

  // Тема и лимит работают вместе.
  srs.buildQueue({ source: 'random', cats: new Set(['familia']), size: 1, modes: new Set() });
  assert.equal(new Set(drain().map((k) => k.split('|')[0])).size, 1);
  srs.setSession({});
});

test('несколько форматов сразу дают оба направления карточек', () => {
  resetDeck();
  for (let i = 0; i < 4; i++) makeWord('palabra' + i, 'слово' + i);

  // Ввод (RU→ES) и карточки (ES→RU) вместе — в занятие идут оба направления.
  const modes = new Set(['type', 'flip']);
  srs.buildQueue({ source: 'random', size: 0, modes });
  const keys = drain();
  assert.equal(keys.length, 8);
  assert.ok(keys.some((k) => k.endsWith('|ru')) && keys.some((k) => k.endsWith('|es')));

  // Каждой карточке достаётся только тот режим, который подходит её направлению.
  for (const key of keys) {
    const mode = srs.pickMode(key, modes);
    assert.equal(mode, key.endsWith('|ru') ? 'type' : 'flip');
  }

  // Квиз работает в обе стороны, поэтому ничего не ограничивает.
  assert.equal(srs.allowedDirs(new Set(['choice'])), null);
  assert.equal(srs.allowedDirs(new Set(['type', 'choice'])), null);
  assert.deepEqual(srs.allowedDirs(new Set(['letters'])), new Set(['ru']));
  assert.equal(srs.allowedDirs(new Set()), null, 'пустой набор — это авто');
  srs.setSession({});
});

test('несколько тем сразу берутся вместе', () => {
  resetDeck();
  const a = addWord({ es: 'la madre', ru: 'мать' });
  const b = addWord({ es: 'la cabeza', ru: 'голова' });
  const c = addWord({ es: 'la casa', ru: 'дом' });
  a.cat = 'familia';
  b.cat = 'cuerpo';
  c.cat = 'casa';

  srs.buildQueue({ source: 'random', cats: new Set(['familia', 'casa']), size: 0, modes: new Set() });
  const ids = new Set(drain().map((k) => k.split('|')[0]));
  assert.ok(ids.has(a.id) && ids.has(c.id));
  assert.ok(!ids.has(b.id), 'невыбранная тема не попадает');
  srs.setSession({});
});

test('выученные слова подмешиваются в занятие, но не заливают его', () => {
  resetDeck();
  // Пятьсот карточек к повторению и большой архив — проверяем потолок подмешивания.
  const learned = [];
  for (let i = 0; i < 40; i++) learned.push(makeWord('viejo' + i, 'старое' + i));
  for (const w of learned) srs.archiveWord(w.id, true);
  for (let i = 0; i < 60; i++) makeWord('nuevo' + i, 'новое' + i);

  srs.setSession({});
  // Читаем ровно одну сборку очереди: nextKey пересобирает её сам, когда она кончилась,
  // и накопленное за несколько заходов о доле в одном занятии ничего не говорит.
  const size = srs.buildQueue();
  const keys = [];
  for (let i = 0; i < size; i++) keys.push(srs.nextKey());
  const archived = keys.filter((k) => learned.some((w) => k.startsWith(w.id + '|')));

  assert.ok(archived.length >= 1, 'хотя бы одно выученное слово должно попасться');
  assert.ok(
    archived.length <= srs.MAX_ARCHIVE_MIX,
    'выученных не больше потолка, иначе занятие превратится в повторение: ' + archived.length,
  );

  // Маленькая колода: одно выученное слово всё равно приходит.
  resetDeck();
  const old = makeWord('solo', 'единственное');
  srs.archiveWord(old.id, true);
  makeWord('otro', 'другое');
  const small = srs.buildQueue();
  const smallKeys = [];
  for (let i = 0; i < small; i++) smallKeys.push(srs.nextKey());
  assert.ok(
    smallKeys.some((k) => k.startsWith(old.id + '|')),
    'при живом архиве всегда подмешивается хотя бы одно слово',
  );
  srs.setSession({});
});

test('выученное слово, забытое при повторении, возвращается в оборот', () => {
  resetDeck();
  const w = makeWord('olvidado', 'забытое');
  srs.archiveWord(w.id, true);
  const key = w.id + '|es';

  // Вспомнил — остаётся в архиве и не занимает место в дневной цели.
  let res = srs.grade(key, 'flip', true);
  assert.equal(res.arch, true);
  assert.equal(res.counted, false);

  // Не вспомнил — выходит из архива во вторую коробку и приходит снова сегодня же.
  res = srs.grade(key, 'flip', false);
  assert.equal(res.arch, false);
  assert.equal(res.box, 2);
  assert.equal(state.cards[key].due, today());
  assert.equal(srs.isArchived(w.id), false, 'слово больше не считается выученным');
});

test('лимит занятия не съедает подмешанные выученные слова', () => {
  resetDeck();
  const learned = [];
  for (let i = 0; i < 5; i++) learned.push(makeWord('viejo' + i, 'старое' + i));
  for (const w of learned) srs.archiveWord(w.id, true);
  for (let i = 0; i < 40; i++) makeWord('nuevo' + i, 'новое' + i);

  // «10 слов» — это десять активных плюс повторение сверху, а не десять на всех.
  const size = srs.buildQueue({ source: 'due', size: 10, modes: new Set() });
  const keys = [];
  for (let i = 0; i < size; i++) keys.push(srs.nextKey());

  const isLearned = (k) => learned.some((w) => k.startsWith(w.id + '|'));
  const fresh = keys.filter((k) => !isLearned(k));
  const archived = keys.filter(isLearned);

  assert.equal(new Set(fresh.map((k) => k.split('|')[0])).size, 10, 'ровно десять активных слов');
  assert.ok(archived.length >= 1, 'выученное должно попасть и в короткое занятие');
  assert.ok(archived.length <= srs.MAX_ARCHIVE_MIX);
  srs.setSession({});
});
