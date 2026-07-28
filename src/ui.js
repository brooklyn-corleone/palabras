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
  const mode = srs.pickMode(currentKey);
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

// Разминка идёт один раз за сессию и только если карточек к повторению хватает:
// иначе шесть пар превратятся в весь день занятий.
function renderMatchWarmup(words) {
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
  replace(
    stage,
    el(
      'div',
      { class: 'empty' },
      el('h2', { text: hasWords ? 'На сегодня всё' : 'Колода пуста' }),
      el('p', {
        text: hasWords
          ? 'Все карточки повторены. Следующие придут завтра.'
          : 'Добавь слова на вкладке «Слова».',
      }),
      hasWords
        ? el(
            'button',
            {
              class: 'btn ghost',
              onclick: () => {
                srs.buildExtraQueue();
                nextCard();
              },
            },
            'Повторить ещё раз',
          )
        : null,
    ),
  );
}

function answer(mode, correct) {
  const res = srs.grade(currentKey, mode, correct);
  notes.countCard();
  nextCard();
  if (res) pulseSeg(res.arch ? 'arch' : String(res.box));
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

function renderList() {
  const q = (filterEl.value || '').toLowerCase().trim();
  const items = activeWords()
    .filter((w) => !q || (w.es + ' ' + w.ua).toLowerCase().includes(q))
    .map((w) => {
      const arch = srs.isArchived(w.id);
      return el(
        'div',
        { class: 'item' + (arch ? ' arch' : '') },
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
        el('div', { class: 'ua', text: w.ua }),
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
    items.length ? items : el('div', { class: 'item' }, el('div', { class: 'ua', text: 'Ничего не нашлось.' })),
  );
}

function bindWordsView() {
  filterEl.addEventListener('input', renderList);

  $('btn-add').addEventListener('click', () => {
    const es = $('new-es').value.trim();
    const ua = $('new-ua').value.trim();
    if (!es || !ua) {
      setNote('Нужны испанское слово и перевод.');
      return;
    }
    addWord({ es, ua });
    $('new-es').value = '';
    $('new-ua').value = '';
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
  if (!learn) renderList();
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

  srs.buildQueue();
  const warmup = srs.pickMatchWords();
  if (warmup) renderMatchWarmup(warmup);
  else nextCard();

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
