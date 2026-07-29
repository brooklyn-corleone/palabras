// Оболочка: тема, вкладки, дневная цель, шкала коробок, список слов, клавиатура.
// Про логику повторений здесь знают ровно столько, сколько нужно для отрисовки.

import * as db from './db.js';
import * as srs from './srs.js';
import * as notes from './notes.js';
import { el, replace } from './dom.js';
import { render as renderType } from './modes/type.js';
import { render as renderFlip } from './modes/flip.js';
import { render as renderChoice } from './modes/choice.js';
import { render as renderLetters } from './modes/letters.js';
import { render as renderMatch } from './modes/match.js';
import {
  state,
  load,
  save,
  mergeSeed,
  today,
  now,
  activeWords,
  addWord,
  deleteWord,
  categories,
  DIRS,
} from './state.js';

const MODES = {
  type: renderType,
  flip: renderFlip,
  choice: renderChoice,
  letters: renderLetters,
};

const $ = (id) => document.getElementById(id);

const stage = $('stage');
const railEl = $('boxes');
const railNote = $('rail-note');
const ticksEl = $('ticks');
const goalNum = $('goal-num');
const listEl = $('list');
const filterEl = $('filter');

let currentKey = null;
let view = 'learn';

// ---------------------------------------------------------------------------
// занятие
// ---------------------------------------------------------------------------

// Настройки живут только в памяти: занятие — это «что учу прямо сейчас»,
// после перезагрузки логично начинать с обычного повторения.
const session = {
  source: 'due', // 'due' — что созрело, 'random' — случайные, 'picked' — выбранные руками
  cats: new Set(), // коды тем; пусто — все темы
  size: 0, // 0 — сколько наберётся
  modes: new Set(), // режимы; пусто — авто, по лестнице коробок
  picked: new Set(),
};

const SOURCE_LABEL = { due: 'к повторению', random: 'случайные', picked: 'выбранные' };
const SIZES = [0, 10, 20, 30];

// Цель дня празднуем один раз: дальше пользователь сам решает, продолжать или нет.
// Флаг сбрасывается вместе со счётчиком — при смене дня и при сборке нового занятия.
let goalCelebrated = false;

// Очередь пачек для режима «Пары», выбранного руками: он работает не карточками,
// а группами по шесть, поэтому идёт мимо обычной очереди.
let matchPacks = [];

// Русское склонение после числа: 1 карточка, 2 карточки, 5 карточек, 21 карточка.
function plural(n, one, few, many) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function catLabel(code) {
  const found = categories().find(([c]) => c === code);
  return found ? found[1] : code;
}

function listOf(set, label, fallback) {
  if (!set.size) return fallback;
  return [...set].map((v) => label(v).toLowerCase()).join(' + ');
}

function sessionSummary() {
  return [
    SOURCE_LABEL[session.source],
    listOf(session.cats, catLabel, 'все темы'),
    session.size ? session.size + ' слов' : 'все',
    listOf(session.modes, (m) => srs.MODE_LABEL[m], 'авто'),
  ].join(' · ');
}

function renderSessionBar() {
  $('session-summary').textContent = sessionSummary();
}

// ---------------------------------------------------------------------------
// тема
// ---------------------------------------------------------------------------

const BG = { light: '#F7F7F6', dark: '#121312' };

function isDark(theme) {
  return theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // На Android шапка браузера красится этим мета-тегом и сама за темой не следит.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = isDark(theme) ? BG.dark : BG.light;
  for (const btn of document.querySelectorAll('[data-theme-choice]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeChoice === theme));
  }
}

function setTheme(theme) {
  state.settings.theme = theme;
  save();
  // Зеркало для инлайн-скрипта в index.html: он ставит тему до первой отрисовки,
  // а IndexedDB синхронно не прочитать.
  try {
    localStorage.setItem('palabras.theme', theme);
  } catch (e) {
    /* приватный режим — обойдёмся без мгновенной темы */
  }
  applyTheme(theme);
}

function bindTheme() {
  for (const btn of document.querySelectorAll('[data-theme-choice]')) {
    btn.addEventListener('click', () => setTheme(btn.dataset.themeChoice));
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'auto') applyTheme('auto');
  });
  applyTheme(state.settings.theme || 'auto');
}

// ---------------------------------------------------------------------------
// карточка
// ---------------------------------------------------------------------------

function nextCard() {
  // Пачки «Пар» идут вперёд карточек: пока они не кончились, занятие состоит из них.
  if (matchPacks.length) {
    renderMatchPack(matchPacks.shift());
    return;
  }
  // Правило показываем вместо карточки, а не поверх неё: одна вещь на экране за раз.
  if (notes.shouldShow()) {
    renderNote();
    return;
  }
  currentKey = srs.nextKey();
  renderStage();
  renderRail();
  renderGoal();
}

// ---------------------------------------------------------------------------
// настройка занятия
// ---------------------------------------------------------------------------

function chooserBox(label, buttons) {
  return el(
    'div',
    { class: 'chooser' },
    el('span', { class: 'cap', text: label }),
    el('div', { class: 'chooser-row' }, buttons),
  );
}

// Группа кнопок с одним выбранным вариантом.
function chooser(label, options, current, onPick) {
  return chooserBox(
    label,
    options.map(([value, text, disabled]) =>
      el('button', {
        class: 'pill',
        text,
        disabled: disabled || undefined,
        'aria-pressed': String(value === current),
        onclick: () => {
          onPick(value);
          renderSetup();
        },
      }),
    ),
  );
}

// Группа с множественным выбором: можно взять и квиз, и карточки сразу.
// Пустой набор — это «всё»/«авто», поэтому первая кнопка просто его очищает.
function multiChooser(label, allText, options, selected) {
  const buttons = [
    el('button', {
      class: 'pill',
      text: allText,
      'aria-pressed': String(selected.size === 0),
      onclick: () => {
        selected.clear();
        renderSetup();
      },
    }),
  ];
  for (const [value, text, disabled] of options) {
    buttons.push(
      el('button', {
        class: 'pill',
        text,
        disabled: disabled || undefined,
        'aria-pressed': String(selected.has(value)),
        onclick: () => {
          if (selected.has(value)) selected.delete(value);
          else selected.add(value);
          renderSetup();
        },
      }),
    );
  }
  return chooserBox(label, buttons);
}

function renderSetup() {
  const picked = session.picked.size;
  const cats = categories();
  replace(
    stage,
    el(
      'div',
      { class: 'mode setup' },
      el('div', { class: 'dir' }, el('span', { text: 'Настройка занятия' })),

      chooser(
        'Какие слова',
        [
          ['due', 'К повторению'],
          ['random', 'Случайные'],
          ['picked', picked ? 'Выбранные · ' + picked : 'Выбранные', picked === 0],
        ],
        session.source,
        (v) => {
          session.source = v;
        },
      ),

      cats.length ? multiChooser('Тема', 'Все темы', cats, session.cats) : null,

      chooser(
        'Сколько слов',
        SIZES.map((n) => [n, n === 0 ? 'Все' : String(n)]),
        session.size,
        (v) => {
          session.size = v;
        },
      ),

      multiChooser(
        'Формат',
        'Авто',
        Object.keys(srs.MODE_LABEL).map((m) => [m, srs.MODE_LABEL[m]]),
        session.modes,
      ),

      session.source === 'picked' && picked === 0
        ? el('p', { class: 'hint', text: 'Слова отмечаются галочками на вкладке «Слова».' })
        : null,

      el(
        'div',
        { class: 'row' },
        el(
          'button',
          { class: 'btn', dataset: { key: 'enter' }, onclick: startSession },
          'Начать',
          el('kbd', { text: 'Enter' }),
        ),
        el('button', { class: 'btn ghost', onclick: () => nextCard() }, 'Отмена'),
      ),
    ),
  );
}

function startSession() {
  srs.setSession({
    source: session.source,
    cats: session.cats,
    size: session.size,
    modes: session.modes,
    picked: session.picked,
  });
  renderSessionBar();
  matchPacks = [];
  goalCelebrated = state.stats.done >= state.settings.goal;

  const wantsMatch = session.modes.has('match');
  const onlyMatch = wantsMatch && session.modes.size === 1;

  // «Пары» — единственный режим, который работает не карточками, а пачками по шесть.
  // Выбран один — занятие целиком из пачек. Выбран вместе с другими — одна пачка
  // как разминка, дальше обычная очередь.
  if (wantsMatch) {
    const words = srs.sessionWords();
    const limit = onlyMatch ? words.length : srs.MATCH_PAIRS;
    for (let i = 0; i + 1 < Math.min(words.length, limit); i += srs.MATCH_PAIRS) {
      matchPacks.push(words.slice(i, i + srs.MATCH_PAIRS));
    }
  }
  if (onlyMatch) {
    nextCard();
    return;
  }

  srs.buildQueue();
  // В обычном занятии разминка приходит сама, если карточек хватает.
  if (!matchPacks.length && session.source === 'due' && !session.modes.size) {
    const warmup = srs.pickMatchWords();
    if (warmup) matchPacks.push(warmup);
  }
  nextCard();
}

function renderStage() {
  if (!currentKey) {
    renderEmpty();
    return;
  }
  const word = srs.wordOf(currentKey);
  const card = state.cards[currentKey];
  if (!word || !card) {
    // Очередь собирается только из живых карточек, попадать сюда нечему.
    currentKey = null;
    renderEmpty();
    return;
  }
  const mode = srs.pickMode(currentKey, session.modes);
  replace(
    stage,
    MODES[mode]({
      key: currentKey,
      word,
      card,
      dir: currentKey.slice(currentKey.lastIndexOf('|') + 1),
      onAnswer: (ok) => answer(mode, ok),
      onArchive: card.arch
        ? null
        : () => {
            srs.archiveWord(word.id, true);
            nextCard();
          },
    }),
  );
}

// Пачка из шести пар — и разминка в начале обычного занятия, и единица работы
// в режиме «Пары», выбранном руками.
function renderMatchPack(words) {
  replace(
    stage,
    renderMatch({
      words,
      // Верную пару в прогресс не пишем вообще: соединить два столбца — не то же самое,
      // что вспомнить слово, и срок повтора за это сдвигать нечестно.
      onMiss: (wordId) => srs.grade(wordId + '|es', 'match', false),
      onDone: () => {
        renderRail();
        nextCard();
      },
    }),
  );
  renderRail();
  renderGoal();
}

function renderNote() {
  const note = notes.pick();
  if (!note) {
    currentKey = srs.nextKey();
    renderStage();
    return;
  }
  notes.markSeen(note.id);
  replace(
    stage,
    notes.render({
      note,
      onDone: () => nextCard(),
    }),
  );
}

function renderEmpty() {
  const hasWords = activeWords().length > 0;
  const custom = session.source !== 'due' || session.modes.size > 0 || session.cats.size > 0;

  if (!hasWords) {
    replace(
      stage,
      el(
        'div',
        { class: 'empty' },
        el('h2', { text: 'Колода пуста' }),
        el('p', { text: 'Добавь слова на вкладке «Слова».' }),
      ),
    );
    return;
  }

  replace(
    stage,
    el(
      'div',
      { class: 'empty' },
      el('h2', { text: custom ? 'Занятие закончено' : 'На сегодня всё' }),
      el('p', {
        text: custom
          ? 'Можно собрать ещё одно или вернуться к обычному повторению.'
          : 'Все карточки повторены. Следующие придут завтра.',
      }),
      el(
        'div',
        { class: 'row row-inline' },
        el('button', { class: 'btn', onclick: renderSetup }, 'Собрать занятие'),
        el(
          'button',
          {
            class: 'btn ghost',
            onclick: () => {
              srs.setSession({});
              srs.buildExtraQueue();
              nextCard();
            },
          },
          'Повторить ещё раз',
        ),
      ),
    ),
  );
}

function answer(mode, correct) {
  const res = srs.grade(currentKey, mode, correct);
  notes.countCard();

  // Дневная цель должна быть точкой, а не цифрой, которая молча уезжает в 21, 22, 23.
  // Останавливаемся один раз и спрашиваем, продолжать ли.
  if (!goalCelebrated && res && res.counted && state.stats.done >= state.settings.goal) {
    goalCelebrated = true;
    renderGoal();
    renderRail();
    renderGoalReached();
    return;
  }

  nextCard();
  if (res) pulseSeg(res.arch ? 'arch' : String(res.box));
}

function renderGoalReached() {
  const left = srs.queueLength();
  replace(
    stage,
    el(
      'div',
      { class: 'empty' },
      el('div', { class: 'cap', text: 'Цель дня' }),
      el('h2', { text: state.stats.done + ' из ' + state.settings.goal }),
      el('p', {
        text: left
          ? 'Можно остановиться. Осталось ещё ' +
            left +
            ' ' +
            plural(left, 'карточка', 'карточки', 'карточек') +
            ', если хочется дальше.'
          : 'Можно остановиться — на сегодня всё повторено.',
      }),
      el(
        'div',
        { class: 'row row-inline' },
        left
          ? el(
              'button',
              { class: 'btn', dataset: { key: 'enter' }, onclick: () => nextCard() },
              'Продолжить',
              el('kbd', { text: 'Enter' }),
            )
          : null,
        el('button', { class: 'btn ghost', onclick: renderSetup }, 'Собрать занятие'),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// дневная цель и шкала коробок
// ---------------------------------------------------------------------------

function renderGoal() {
  const goal = state.settings.goal;
  const done = Math.min(state.stats.done, goal);
  const ticks = [];
  for (let i = 0; i < goal; i++) ticks.push(el('div', { class: 'tick' + (i < done ? ' on' : '') }));
  replace(ticksEl, ticks);
  goalNum.textContent = state.stats.done + ' / ' + goal;
}

// Шесть сегментов шириной пропорционально числу карточек. Подпись не висит постоянно —
// появляется по тапу, иначе шкала превращается в таблицу и перестаёт быть тихой.
function renderRail() {
  const { boxes, arch } = srs.boxCounts();
  const segments = boxes.map((count, i) => ({
    key: String(i + 1),
    count,
    label: 'Коробка ' + (i + 1),
    sub: srs.BOX_LABEL[i],
  }));
  segments.push({ key: 'arch', count: arch, label: 'Архив', sub: 'изредка' });

  replace(
    railEl,
    segments.map((s) =>
      el('button', {
        class:
          'seg' + (s.key === 'arch' ? ' seg-arch' : '') + (s.count === 0 ? ' is-empty' : ''),
        dataset: { box: s.key },
        style: 'flex-grow:' + s.count,
        'aria-label': s.label + ': ' + s.count,
        onclick: () => {
          railNote.textContent = s.label + ' · ' + s.count + ' · ' + s.sub;
        },
      }),
    ),
  );
}

function pulseSeg(box) {
  const node = railEl.querySelector('[data-box="' + box + '"]');
  if (!node) return;
  node.classList.add('pulse');
  setTimeout(() => node.classList.remove('pulse'), 420);
}

// ---------------------------------------------------------------------------
// список слов
// ---------------------------------------------------------------------------

// Список тем в фильтре пересобираем только когда набор изменился: иначе выбранное
// значение сбрасывается при каждой перерисовке списка.
function syncCatFilter() {
  const select = $('filter-cat');
  const cats = categories();
  const signature = cats.map(([c]) => c).join(',');
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;
  const current = select.value;
  replace(
    select,
    el('option', { value: '', text: 'Все темы' }),
    cats.map(([code, label]) => el('option', { value: code, text: label })),
  );
  select.value = current;
}

function renderList() {
  syncCatFilter();
  const q = (filterEl.value || '').toLowerCase().trim();
  const cat = $('filter-cat').value;
  const items = activeWords()
    .filter((w) => !cat || w.cat === cat)
    .filter((w) => !q || (w.es + ' ' + w.ru).toLowerCase().includes(q))
    .map((w) => {
      const arch = srs.isArchived(w.id);
      const check = el('input', { type: 'checkbox', class: 'pick', 'aria-label': 'Учить ' + w.es });
      check.checked = session.picked.has(w.id);
      check.addEventListener('change', () => {
        if (check.checked) session.picked.add(w.id);
        else session.picked.delete(w.id);
        renderPickedBar();
      });

      return el(
        'div',
        { class: 'item' + (arch ? ' arch' : '') },
        check,
        el('div', { class: 'es', text: w.es }),
        el('div', { class: 'box-tag', text: arch ? 'архив' : 'коробка ' + srs.wordBox(w.id) }),
        el(
          'button',
          {
            class: 'mini',
            onclick: () => {
              srs.archiveWord(w.id, !arch);
              renderList();
              renderRail();
            },
          },
          arch ? 'вернуть' : 'в архив',
        ),
        el('div', { class: 'ru', text: w.ru }),
        el(
          'button',
          {
            class: 'mini danger',
            onclick: () => {
              if (!confirm('Удалить «' + w.es + '»? Прогресс по слову тоже исчезнет.')) return;
              deleteWord(w.id);
              srs.buildQueue();
              renderList();
              renderRail();
            },
          },
          'удалить',
        ),
      );
    });

  replace(
    listEl,
    items.length ? items : el('div', { class: 'item' }, el('div', { class: 'ru', text: 'Ничего не нашлось.' })),
  );
}

function renderPickedBar() {
  const bar = $('picked-bar');
  bar.classList.toggle('hidden', session.picked.size === 0);
  $('picked-count').textContent = 'Выбрано: ' + session.picked.size;
}

function bindWordsView() {
  filterEl.addEventListener('input', renderList);

  $('btn-learn-picked').addEventListener('click', () => {
    session.source = 'picked';
    showView('learn');
    startSession();
  });

  $('btn-clear-picked').addEventListener('click', () => {
    session.picked.clear();
    if (session.source === 'picked') session.source = 'due';
    renderPickedBar();
    renderList();
  });

  $('filter-cat').addEventListener('change', renderList);

  $('btn-add').addEventListener('click', () => {
    const es = $('new-es').value.trim();
    const ru = $('new-ru').value.trim();
    if (!es || !ru) {
      setNote('Нужны испанское слово и перевод.');
      return;
    }
    addWord({ es, ru });
    $('new-es').value = '';
    $('new-ru').value = '';
    setNote('Слово добавлено.');
    srs.buildQueue();
    renderList();
    renderRail();
  });

  $('btn-export').addEventListener('click', exportDeck);
  $('btn-import').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', importDeck);
  $('btn-reset').addEventListener('click', resetProgress);
}

function setNote(text) {
  $('words-note').textContent = text;
}

// Выгружаем только слова и прогресс. Настройки устройства в файл не кладём —
// позже там будет токен синхронизации, и ему в скачанном файле не место.
function exportDeck() {
  const dump = { v: state.v, exported: now(), words: state.words, cards: state.cards };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }),
  );
  const a = el('a', { href: url, download: 'palabras-' + today() + '.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importDeck(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.words) || !data.cards) throw new Error('не колода');
      state.words = data.words;
      state.cards = data.cards;
      // Индекс слов живёт в state.js, а мы подменили массив целиком — перечитываем всё.
      // Перезагружаемся только после того, как запись действительно легла на диск.
      save().then(() => location.reload());
    } catch (err) {
      setNote('Файл не похож на колоду Palabras.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function resetProgress() {
  if (!confirm('Сбросить все коробки и начать заново? Слова останутся, прогресс — нет.')) return;
  for (const w of activeWords()) {
    for (const dir of DIRS) {
      state.cards[w.id + '|' + dir] = { box: 1, due: today(), arch: false, updated: now() };
    }
  }
  state.stats.done = 0;
  save();
  srs.buildQueue();
  renderList();
  nextCard();
  setNote('Прогресс сброшен.');
}

// ---------------------------------------------------------------------------
// вкладки и клавиатура
// ---------------------------------------------------------------------------

function showView(which) {
  view = which;
  const learn = which === 'learn';
  $('view-learn').classList.toggle('hidden', !learn);
  $('view-words').classList.toggle('hidden', learn);
  $('tab-learn').setAttribute('aria-current', String(learn));
  $('tab-words').setAttribute('aria-current', String(!learn));
  if (!learn) {
    renderList();
    renderPickedBar();
  }
}

// Клавиши не разбираются в режимах: каждый режим просто помечает свою кнопку
// через data-key, а оболочка находит её и нажимает. Новый режим ничего тут не меняет.
function keyName(e) {
  if (e.key === 'Enter') return 'enter';
  if (e.code === 'Space') return 'space';
  if (e.key === '1' || e.key === '2' || e.key === '3') return e.key;
  return null;
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (view !== 'learn' || e.metaKey || e.ctrlKey || e.altKey) return;
    const name = keyName(e);
    if (!name) return;

    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea') return;
    if (tag === 'input' && name !== 'enter') return; // цифры и пробел нужны для ответа

    const btn = stage.querySelector('[data-key="' + name + '"]');
    if (!btn) return;
    e.preventDefault();
    btn.click();
  });
}

// ---------------------------------------------------------------------------
// запуск
// ---------------------------------------------------------------------------

function warnAboutStorage() {
  if (db.storageKind === 'idb') return;
  const warn = $('storage-warn');
  warn.textContent =
    db.storageKind === 'ls'
      ? 'IndexedDB недоступна — прогресс сохраняется в localStorage. Скачай колоду на всякий случай.'
      : 'Браузер заблокировал хранилище — прогресс исчезнет при закрытии вкладки.';
  warn.classList.remove('hidden');
}

async function init() {
  await load();
  bindTheme();

  // Первый запуск: без колоды показывать нечего, поэтому ждём её.
  // На последующих запусках пополняем в фоне, чтобы не задерживать первую карточку.
  const firstRun = state.words.length === 0;
  if (firstRun) await mergeSeed();

  warnAboutStorage();
  bindWordsView();
  bindKeyboard();
  $('tab-learn').addEventListener('click', () => showView('learn'));
  $('tab-words').addEventListener('click', () => showView('words'));
  $('btn-session').addEventListener('click', renderSetup);

  renderSessionBar();
  startSession();

  notes.loadNotes();

  if (!firstRun) {
    mergeSeed().then((added) => {
      if (!added) return;
      srs.buildQueue();
      renderRail();
      if (!currentKey) nextCard();
      if (view === 'words') renderList();
    });
  }
}

if ('serviceWorker' in navigator) {
  // Воркер забирает управление сразу (skipWaiting в sw.js), поэтому страница может
  // остаться с модулями старой версии в памяти, а получать файлы уже от новой.
  // Перезагружаемся ровно один раз, когда управление сменилось. Прогресс лежит
  // в IndexedDB и переживает это без потерь.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // первая установка — перезагружать нечего
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .catch((e) => console.warn('service worker не зарегистрировался:', e));
  });
}

init().catch((e) => {
  console.error('не удалось запустить приложение:', e);
  replace(
    stage,
    el(
      'div',
      { class: 'empty' },
      el('h2', { text: 'Что-то сломалось' }),
      el('p', { text: String(e && e.message ? e.message : e) }),
    ),
  );
});
