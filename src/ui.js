// Оболочка: тема, вкладки, дневная цель, шкала коробок, список слов, клавиатура.
// Про логику повторений здесь знают ровно столько, сколько нужно для отрисовки.

import * as db from './db.js';
import * as srs from './srs.js';
import * as notes from './notes.js';
import * as speech from './speech.js';
import { el, replace, announce } from './dom.js';
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
  undeleteWord,
  flagWord,
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

// Что сейчас на экране «Учить»: 'home' — старт, 'card' | 'match' | 'note' | 'goal' —
// идёт занятие, 'setup' — настройка, 'end' — итог. От этого зависит фокус-режим
// (см. setFocus) и что вернёт «Продолжить» после выхода по ✕.
let screen = 'home';
let currentPack = null; // пачка «Пар», которая сейчас на экране
let resume = null; // как вернуться в прерванное занятие; null — занятие не начато

// Новые слова, с которыми уже познакомились в этом занятии (см. renderIntro).
const introduced = new Set();
// Слова, на которых ошиблись в этом занятии, последнее — в конце. По ним всплывающее
// правило выбирается к ошибке, а не наугад (notes.pick).
let recentMisses = [];
const MISSES_KEPT = 10;

// ---------------------------------------------------------------------------
// занятие
// ---------------------------------------------------------------------------

// Настройки живут только в памяти: занятие — это «что учу прямо сейчас»,
// после перезагрузки логично начинать с обычного повторения.
const session = {
  source: 'due', // 'due' — что созрело, 'random' — случайные, 'picked' — выбранные руками
  cats: new Set(), // коды тем; пусто — все темы
  // Потолок занятия по словам. Не «сколько наберётся»: на свежей колоде созревают разом
  // все карточки — на двухстах сорока словах это четыреста восемьдесят штук в одном
  // занятии, и оно просто не кончается. По той же причине Anki по умолчанию даёт
  // двадцать новых карточек в день: каждая вернётся на повторение, и долг копится.
  // Двадцать слов — это сорок карточек, то есть две цели по двадцать ответов: цель
  // успевает сработать в середине, а занятие всё равно кончается. «Все» остаётся
  // в настройке занятия, если хочется марафон.
  size: 20,
  modes: new Set(), // режимы; пусто — авто, по лестнице коробок
  picked: new Set(),
};

const SOURCE_LABEL = { due: 'к повторению', random: 'случайные', picked: 'выбранные', hard: 'трудные' };
const SIZES = [0, 10, 20, 30, 40];

// Длина урока — сколько верных ответов он занимает (state.settings.goal). У слова два
// направления, то есть две карточки, и каждая верная даёт один шаг: урок на двадцать
// шагов — это десять слов. Считаем размер занятия отсюда, чтобы урок заканчивался
// там же, где счётчик: иначе «урок на 10» означал бы цель на десятом шаге
// и ещё тридцать карточек следом.
const GOALS = [10, 20, 30, 40];

function lessonWords() {
  return Math.max(1, Math.ceil(state.settings.goal / 2));
}

// Пока размер занятия не выбран руками, он едет за длиной урока.
let sizeFromGoal = true;

function applyLessonSize() {
  if (sizeFromGoal) session.size = lessonWords();
}

// Цель дня празднуем один раз: дальше пользователь сам решает, продолжать или нет.
// Флаг сбрасывается вместе со счётчиком — при смене дня и при сборке нового занятия.
let goalCelebrated = false;

// Очередь пачек для режима «Пары», выбранного руками: он работает не карточками,
// а группами по шесть, поэтому идёт мимо обычной очереди.
let matchPacks = [];

// Итог занятия по слову: id → верно ли отвечено. Нужен экрану в конце, который
// предлагает убрать выученное в архив.
//
// Одного промаха хватает, чтобы слово перестало считаться верным, даже если со второго
// раза оно вспомнилось: архив — это «знаю наизусть», а слово, которое пришлось
// вытаскивать дважды, к нему не готово. Поэтому false всегда перебивает true,
// в каком порядке ни приходи, — а у слова направлений два, и порядок не предсказать.
const sessionRight = new Map();

// Сколько слов ушло в архив с экрана конца занятия. Держим счёт только затем, чтобы
// после нажатия на экране осталась строчка о том, что произошло: список отмеченных
// сжимается, и без неё непонятно, сработало ли.
let archivedAtEnd = 0;

function recordAnswer(wordId, ok) {
  if (!ok) sessionRight.set(wordId, false);
  else if (!sessionRight.has(wordId)) sessionRight.set(wordId, true);
}

function resetSessionResults() {
  sessionRight.clear();
  archivedAtEnd = 0;
}

function wordIdOf(key) {
  return key.slice(0, key.lastIndexOf('|'));
}

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
    session.size ? session.size + ' слов' : 'все слова',
    listOf(session.modes, (m) => srs.MODE_LABEL[m], 'авто'),
  ].join(' · ');
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

// ---------------------------------------------------------------------------
// длина урока
// ---------------------------------------------------------------------------

function applyGoalChoice() {
  for (const btn of document.querySelectorAll('[data-goal-choice]')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.goalChoice) === state.settings.goal));
  }
}

function setGoal(n) {
  if (!GOALS.includes(n) || n === state.settings.goal) return;
  state.settings.goal = n;
  save();
  // Новая длина применяется со следующего занятия, но знаменатель в счётчике
  // и подпись занятия честнее поменять сразу — иначе непонятно, сработал ли выбор.
  applyLessonSize();
  applyGoalChoice();
  renderGoal();
  if (screen === 'home') renderHome();
}

// ---------------------------------------------------------------------------
// новых в день и произношение
// ---------------------------------------------------------------------------

function applyNewChoice() {
  for (const btn of document.querySelectorAll('[data-new-choice]')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.newChoice) === srs.newPerDay()));
  }
}

function setNewPerDay(n) {
  if (!srs.NEW_PER_DAY.includes(n) || n === srs.newPerDay()) return;
  state.settings.newPerDay = n;
  save();
  applyNewChoice();
  // Занятие ещё не начато — пересобрать с новым лимитом. Начатое не трогаем.
  if (screen === 'home' && !resume) {
    prepareSession();
    renderHome();
  }
}

function applySpeakChoice() {
  const on = !!state.settings.autoSpeak;
  for (const btn of document.querySelectorAll('[data-speak-choice]')) {
    btn.setAttribute('aria-pressed', String((btn.dataset.speakChoice === 'on') === on));
  }
  // Голоса нет — так и сказать, и где его взять. Иначе пропавшая кнопка выглядит поломкой.
  $('voice-note').textContent = speech.canSpeak()
    ? 'Голос: ' + speech.voiceName() + '. Кнопка 🔊 стоит рядом с испанским словом.'
    : 'Испанского голоса на устройстве нет, поэтому кнопки 🔊 не будет. На iPhone голос ставится в Настройках: Универсальный доступ → Устный контент → Голоса → Испанский.';
}

function bindSpeech() {
  for (const btn of document.querySelectorAll('[data-new-choice]')) {
    btn.addEventListener('click', () => setNewPerDay(Number(btn.dataset.newChoice)));
  }
  applyNewChoice();
  for (const btn of document.querySelectorAll('[data-speak-choice]')) {
    btn.addEventListener('click', () => {
      state.settings.autoSpeak = btn.dataset.speakChoice === 'on';
      save();
      applySpeakChoice();
    });
  }
  speech.initSpeech(applySpeakChoice);
  applySpeakChoice();
}

// ---------------------------------------------------------------------------
// тост «Отменить»
// ---------------------------------------------------------------------------

// Шесть секунд, а не четыре: успеть прочитать, понять и дотянуться. Пока фокус
// внутри тоста — с клавиатуры или VoiceOver, — он не исчезает.
const TOAST_MS = 6000;
let toastTimer = null;

function toast(text, onUndo) {
  const box = $('toast');
  clearTimeout(toastTimer);
  replace(
    box,
    el('span', { class: 'toast-text', text }),
    onUndo
      ? el(
          'button',
          {
            class: 'toast-undo',
            onclick: () => {
              hideToast();
              onUndo();
            },
          },
          'Отменить',
        )
      : null,
  );
  box.classList.remove('hidden');
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('toast').classList.add('hidden');
}

function bindToast() {
  const box = $('toast');
  box.addEventListener('focusin', () => clearTimeout(toastTimer));
  box.addEventListener('focusout', () => {
    toastTimer = setTimeout(hideToast, TOAST_MS);
  });
}

function bindGoalChoice() {
  for (const btn of document.querySelectorAll('[data-goal-choice]')) {
    btn.addEventListener('click', () => setGoal(Number(btn.dataset.goalChoice)));
  }
  applyGoalChoice();
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
  if (notes.shouldShow(recentMisses)) {
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
  screen = 'setup';
  setFocus(false);
  const picked = session.picked.size;
  const hard = srs.hardWordIds().size;
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
          ['hard', hard ? 'Трудные · ' + hard : 'Трудные', hard === 0],
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
          // Выбрал руками — дальше размер живёт сам по себе и за длиной урока не ходит.
          sizeFromGoal = false;
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
      session.source === 'hard'
        ? el('p', {
            class: 'hint',
            text: 'Трудное — слово, забытое в ' + srs.LEECH + ' разных днях. Уходит из списка, когда дойдёт до архива.',
          })
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
        el('button', { class: 'btn ghost', onclick: renderHome }, 'Отмена'),
      ),
    ),
  );
}

// Собрать занятие и сразу начать.
function startSession() {
  prepareSession();
  nextCard();
}

// Собрать занятие, не начиная: очередь, пачки «Пар», обнулённый счёт цели.
// При запуске приложения занятие готовится, а показывается стартовый экран.
function prepareSession() {
  resume = null;
  srs.setSession({
    source: session.source,
    cats: session.cats,
    size: session.size,
    modes: session.modes,
    picked: session.picked,
  });
  matchPacks = [];
  resetSessionResults();
  introduced.clear();
  recentMisses = [];

  // Счёт цели начинается заново с каждым занятием — и при сборке нового, и при запуске
  // приложения (init тоже идёт сюда). Раньше он был дневным и после двадцати продолжал
  // расти: на экране висело «49 / 20», и понять, сколько сделано в этом занятии,
  // было нельзя. Смена даты по-прежнему обнуляет его сама (state.js) — на случай
  // приложения с домашнего экрана, которое не перезагружается неделями.
  state.stats.done = 0;
  save();

  goalCelebrated = state.stats.done >= state.settings.goal;

  // Очередь собираем один раз и до всего остального. Раньше sessionWords() собирал её
  // сам, а потом buildQueue() собирал заново — и пачки «Пар» оказывались составлены
  // из другой очереди, чем то занятие, которое шло следом.
  srs.buildQueue();

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
  if (onlyMatch) return;

  // В обычном занятии разминка приходит сама, если карточек хватает.
  if (!matchPacks.length && session.source === 'due' && !session.modes.size) {
    const warmup = srs.pickMatchWords();
    if (warmup) matchPacks.push(warmup);
  }
}

// ---------------------------------------------------------------------------
// стартовый экран и фокус-режим
// ---------------------------------------------------------------------------

// Во время занятия на экране только карточка, прогресс и ✕: шапка, вкладки и шкала
// коробок съедали 41–49 % высоты, и на iPhone SE восемь из двенадцати кнопок «Пар»
// уезжали под панель кнопок. Так же устроены Duolingo, Anki и Quizlet.
function setFocus(on) {
  document.body.classList.toggle('in-session', on);
}

// Старт вкладки «Учить»: что будет в занятии, шкала коробок и одна главная кнопка.
// Сводка занятия раньше жила строкой над карточкой и обрезалась многоточием.
function renderHome() {
  screen = 'home';
  setFocus(false);
  renderRail();
  renderGoal();

  if (!activeWords().length) {
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

  const words = srs.sessionWords().length;
  const counts = srs.todayCounts();
  const hard = srs.hardWordIds().size;
  const hasWork = !!resume || srs.queueLength() > 0 || matchPacks.length > 0;

  let title = 'На сегодня всё';
  let text = 'Все карточки повторены. Можно собрать занятие из случайных или выбранных слов.';
  if (resume) {
    title = 'Занятие на паузе';
    text = 'Верных ответов: ' + Math.min(state.stats.done, state.settings.goal) + ' из ' + state.settings.goal + '.';
  } else if (hasWork) {
    title = words + ' ' + plural(words, 'слово', 'слова', 'слов') + ' в занятии';
    text = counts.review || counts.fresh ? '' : 'Повторять по сроку нечего — занятие собрано по настройке.';
  }
  // Новые кончились по лимиту, а не по колоде, — сказать, где лимит меняется.
  // Иначе «на сегодня всё» при двухстах невыученных словах выглядит как поломка.
  if (!resume && !counts.fresh && srs.newLeftToday() === 0 && hasNewWords()) {
    text = (text ? text + ' ' : '') + 'Новых на сегодня больше нет: лимит ' + srs.newPerDay() + ' в день, он меняется в «Настройках».';
  }

  // Счётчик как в Anki: что ждёт сегодня, повторение и новое отдельно.
  const stats = el(
    'div',
    { class: 'home-stats' },
    stat(counts.review, 'к повторению'),
    stat(counts.fresh, 'новых сегодня'),
    hard ? stat(hard, plural(hard, 'трудное', 'трудных', 'трудных')) : null,
  );

  const start = () => {
    const go = resume || nextCard;
    resume = null;
    go();
  };

  replace(
    stage,
    el(
      'div',
      { class: 'home' },
      el('div', { class: 'cap home-summary', text: sessionSummary() }),
      el('h2', { text: title }),
      text ? el('p', { text }) : null,
      stats,
      renderProgress(),
      el(
        'div',
        { class: 'row' },
        hasWork
          ? el(
              'button',
              { class: 'btn', dataset: { key: 'enter' }, onclick: start },
              resume ? 'Продолжить' : 'Начать',
              el('kbd', { text: 'Enter' }),
            )
          : null,
        el('button', { class: hasWork ? 'btn ghost' : 'btn', onclick: renderSetup }, 'Настроить занятие'),
      ),
    ),
  );
}

// Прогресс под счётчиком дня: серия, точность, прогноз. Цифры — то, что Anki и WaniKani
// показывают на главном экране: видно, что занятия к чему-то ведут, и сколько ждёт завтра.
function renderProgress() {
  const st = srs.streak();
  const acc = srs.accuracy(7);
  const fc = srs.forecast();
  const done = srs.todayLog().r;
  const notesText = [];
  if (!st.todayDone) {
    notesText.push(
      'Сегодня засчитается после ' + srs.STREAK_MIN + ' верных ответов' +
        (done ? ' (уже ' + done + ')' : '') + ' или когда повторишь всё.',
    );
  }
  if (st.frozen) notesText.push('Пропуск ' + dayName(st.frozen) + ' не сбросил серию: один в неделю прощается.');
  return el(
    'div',
    { class: 'home-progress' },
    el(
      'div',
      { class: 'home-stats small' },
      stat(st.days, plural(st.days, 'день подряд', 'дня подряд', 'дней подряд')),
      stat(acc === null ? '—' : acc + ' %', 'точность за 7 дней'),
      stat(fc.tomorrow, 'придёт завтра'),
      stat(fc.week, 'за 7 дней'),
    ),
    notesText.length ? el('p', { class: 'hint', text: notesText.join(' ') }) : null,
  );
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function dayName(iso) {
  if (iso === srs.shiftIso(today(), -1)) return 'вчера';
  const [, m, d] = iso.split('-').map(Number);
  return d + ' ' + MONTHS[m - 1];
}

function stat(n, label) {
  return el('div', { class: 'stat' }, el('b', { text: String(n) }), el('span', { class: 'cap', text: label }));
}

function hasNewWords() {
  return activeWords().some((w) => srs.isNewWord(w.id));
}

// ✕ во время занятия: ставим на паузу и возвращаемся на старт. Неотвеченная карточка
// и недособранная пачка «Пар» не теряются — «Продолжить» покажет их снова.
function exitSession() {
  if (screen === 'card' && currentKey) {
    resume = () => renderStage();
  } else if (screen === 'match' && currentPack) {
    matchPacks.unshift(currentPack);
    resume = () => nextCard();
  } else {
    resume = () => nextCard();
  }
  renderHome();
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
  if (!card.arch && !introduced.has(word.id) && srs.isNewWord(word.id)) {
    renderIntro(word);
    return;
  }
  const mode = srs.pickMode(currentKey, session.modes);
  screen = 'card';
  setFocus(true);
  replace(
    stage,
    MODES[mode]({
      key: currentKey,
      word,
      card,
      dir: currentKey.slice(currentKey.lastIndexOf('|') + 1),
      onAnswer: (ok, opts) => answer(mode, ok, opts),
      onArchive: card.arch ? null : () => archiveFromCard(word),
      // Переключатель живёт в самом режиме и правит DOM точечно (см. modes/*),
      // поэтому здесь только пишем состояние — экран из-за жалобы не перерисовываем.
      onFlag: (on) => flagWord(word.id, on),
      flagged: !!word.flagged,
      rule: notes.ruleFor(word),
    }),
  );
}

// Знакомство с новым словом — до первой проверки. Спрашивать то, чего ни разу не видел, —
// гадание: на свежей колоде первый ответ почти всегда промах, и слово с порога копит
// «трудность», которой у него нет. Так устроены уроки WaniKani и Memrise.
// screen остаётся 'card': ✕ и «Продолжить» вернут сюда же через renderStage.
function renderIntro(word) {
  screen = 'card';
  setFocus(true);
  const cat = word.cat ? catLabel(word.cat).toLowerCase() : '';
  const knownStage = srs.STAGES[srs.KNOWN_BOX - 1];
  const knownWhen = srs.BOX_LABEL[srs.KNOWN_BOX - 1];
  replace(
    stage,
    el(
      'div',
      { class: 'mode intro' },
      el('div', { class: 'dir' }, el('span', { text: 'Новое слово' + (cat ? ' · ' + cat : '') })),
      speech.sayable(el('div', { class: 'prompt', lang: 'es', text: word.es }), word.es),
      el('div', { class: 'intro-ru', text: word.ru }),
      notes.ruleLink(notes.ruleFor(word)),
      el('p', {
        class: 'hint intro-hint',
        text: '«Уже знаю» — сразу в «' + knownStage + '»: слово вернётся через ' + knownWhen + ' обычной карточкой.',
      }),
      el(
        'div',
        { class: 'row' },
        el(
          'button',
          {
            class: 'btn',
            dataset: { key: 'enter' },
            onclick: () => {
              introduced.add(word.id);
              renderStage();
            },
          },
          'Учить',
          el('kbd', { text: 'Enter' }),
        ),
        el('button', { class: 'btn ghost', onclick: () => knownFromIntro(word) }, 'Уже знаю'),
      ),
    ),
  );
  announce('Новое слово: ' + word.es + ' — ' + word.ru);
  speech.autoSpeak(word.es);
  stage.querySelector('[data-key="enter"]').focus();
}

// «Уже знаю» — без вопроса, но с «Отменить», как и архив с карточки.
function knownFromIntro(word) {
  const key = currentKey;
  const snap = srs.snapshotWord(word.id);
  const dropped = srs.markKnown(word.id).filter((k) => k !== key);
  introduced.add(word.id);
  nextCard();
  pulseSeg(String(srs.KNOWN_BOX));
  toast('«' + word.es + '» — уже знаю', () => {
    introduced.delete(word.id);
    undoWord(word.id, snap, key, dropped);
  });
}

// Общая отмена для действий с карточки: вернуть записи карточек, ту же карточку —
// на экран, а успевшую показаться следом — сразу за ней.
function undoWord(id, snap, key, dropped) {
  srs.restoreWord(id, snap);
  const back = [key];
  if (screen === 'card' && currentKey && currentKey !== key) back.push(currentKey);
  srs.unshiftKeys(back);
  for (const k of dropped) srs.requeue(k);
  renderRail();
  if (screen === 'card' || screen === 'end') nextCard();
  renderScope();
  if (view === 'words') renderList();
}

// «В архив» посреди занятия — одно касание рядом с «проблема», и промахнуться легко.
// Поэтому без вопроса, но с тостом «Отменить»: вопрос перед каждым архивом раздражал бы
// тех, кто нажал нарочно, а отмена спасает тех, кто промахнулся (HIG, Undo).
function archiveFromCard(word) {
  const key = currentKey;
  const snap = srs.snapshotWord(word.id);
  const dropped = srs.archiveWord(word.id, true).filter((k) => k !== key);
  nextCard();
  pulseSeg('arch');
  toast('«' + word.es + '» в архиве', () => undoWord(word.id, snap, key, dropped));
}

// Пачка из шести пар — и разминка в начале обычного занятия, и единица работы
// в режиме «Пары», выбранном руками.
function renderMatchPack(words) {
  screen = 'match';
  currentPack = words;
  setFocus(true);
  replace(
    stage,
    renderMatch({
      words,
      // Верную пару в прогресс не пишем вообще: соединить два столбца — не то же самое,
      // что вспомнить слово, и срок повтора за это сдвигать нечестно. А промах пишем —
      // и в прогресс, и в итоги занятия, чтобы слово не предлагалось в архив.
      onMiss: (wordId) => {
        srs.grade(wordId + '|es', 'match', false);
        recordAnswer(wordId, false);
      },
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
  const picked = notes.pick(recentMisses);
  if (!picked) {
    currentKey = srs.nextKey();
    renderStage();
    return;
  }
  notes.markSeen(picked.note.id);
  screen = 'note';
  setFocus(true);
  replace(
    stage,
    notes.render({
      note: picked.note,
      word: picked.word,
      onDone: () => nextCard(),
    }),
  );
}

// Блок в конце занятия: отметить галочками то, что и так знаешь наизусть, и убрать
// пачкой в архив. Кнопка «в архив» есть и на самой карточке, но там решение приходится
// принимать в момент ответа и по одному слову; здесь весь список сразу и на свежую голову.
//
// Показываем только отвеченное верно и ни разу не промаханное — см. recordAnswer.
// Галочка 20×20 при HIG-минимуме 44×44: на двухстах сорока строках по ней промахивались.
// Сама галочка не растёт — растёт label вокруг, а отрицательные поля держат вёрстку на месте.
function pickHit(check) {
  return el('label', { class: 'pick-hit' }, check);
}

function renderArchiveOffer() {
  const byId = new Map(activeWords().map((w) => [w.id, w]));
  const words = [...sessionRight.keys()]
    .filter((id) => sessionRight.get(id) && !srs.isArchived(id))
    .map((id) => byId.get(id))
    .filter(Boolean);

  const note = archivedAtEnd
    ? el('p', {
        class: 'hint',
        text:
          'Убрано в архив: ' +
          archivedAtEnd +
          ' ' +
          plural(archivedAtEnd, 'слово', 'слова', 'слов') +
          '.',
      })
    : null;

  // Убрали всё, что предлагалось: список пуст, но строчку об этом оставляем —
  // и внутри той же рамки, иначе она читается как часть текста экрана.
  if (!words.length) return note && el('div', { class: 'end-archive' }, note);

  const chosen = new Set();
  const checks = [];

  const apply = el('button', { class: 'btn' });
  const toggleAll = el('button', { class: 'mini' });

  function sync() {
    apply.disabled = chosen.size === 0;
    apply.textContent = chosen.size ? 'В архив · ' + chosen.size : 'В архив';
    toggleAll.textContent = chosen.size === words.length ? 'Снять все' : 'Выбрать все';
  }

  const items = words.map((w) => {
    const check = el('input', {
      type: 'checkbox',
      class: 'pick',
      'aria-label': 'В архив: ' + w.es,
    });
    check.addEventListener('change', () => {
      if (check.checked) chosen.add(w.id);
      else chosen.delete(w.id);
      sync();
    });
    checks.push(check);
    return el(
      'div',
      { class: 'item' },
      pickHit(check),
      el('div', { class: 'es', lang: 'es', text: w.es }),
      el('div', { class: 'ru', text: w.ru }),
    );
  });

  toggleAll.addEventListener('click', () => {
    const on = chosen.size < words.length;
    chosen.clear();
    checks.forEach((check, i) => {
      check.checked = on;
      if (on) chosen.add(words[i].id);
    });
    sync();
  });

  apply.addEventListener('click', () => {
    if (!chosen.size) return;
    archivedAtEnd += chosen.size;
    srs.archiveWords([...chosen], true);
    renderRail();
    pulseSeg('arch');
    renderScope();
    renderList();
    // Перерисовываем экран целиком: убранные слова должны из списка исчезнуть,
    // а состояние галочек живёт в замыкании и переживать перерисовку не должно.
    renderEmpty();
  });

  sync();

  return el(
    'div',
    { class: 'end-archive' },
    el(
      'div',
      { class: 'end-archive-head' },
      el('span', { class: 'cap', text: 'Ответил верно · ' + words.length }),
      toggleAll,
    ),
    el('p', { class: 'hint', text: 'Отметь то, что уже знаешь наизусть, — уйдёт в архив.' }),
    items,
    note,
    el('div', { class: 'row row-inline' }, apply),
  );
}

function renderEmpty() {
  screen = 'end';
  setFocus(false);
  const hasWords = activeWords().length > 0;
  const custom = session.source !== 'due' || session.modes.size > 0 || session.cats.size > 0;
  // «Занятие закончено» и «на сегодня всё» — разные вещи. Занятие ограничено по словам,
  // и после него обычно остаётся ещё созревшее: обещать «следующие придут завтра»,
  // когда ждут ещё двести карточек, нельзя.
  const left = srs.dueWordCount();
  // Разобрал всё, что созрело, — день в серии засчитан, даже если верных меньше десяти.
  if (!left && sessionRight.size) srs.noteDayClear();

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
      el('h2', { text: left ? 'Занятие закончено' : 'На сегодня всё' }),
      el('p', {
        text: left
          ? 'Ждут повторения ещё ' +
            left +
            ' ' +
            plural(left, 'слово', 'слова', 'слов') +
            '. Можно взять следующее занятие или остановиться.'
          : custom
            ? 'Можно собрать ещё одно или вернуться к обычному повторению.'
            : 'Все карточки повторены. Следующие придут завтра.',
      }),
      el(
        'div',
        { class: 'row row-inline' },
        left
          ? el(
              'button',
              { class: 'btn', dataset: { key: 'enter' }, onclick: startSession },
              'Следующее занятие',
              el('kbd', { text: 'Enter' }),
            )
          : null,
        el(
          'button',
          { class: left ? 'btn ghost' : 'btn' , onclick: renderSetup },
          'Собрать занятие',
        ),
        // Повторять нечего, если занятие кончилось, не начавшись, — кнопка бы собрала
        // пустую очередь и вернула на этот же экран.
        sessionRight.size === 0
          ? null
          : el(
          'button',
          {
            class: 'btn ghost',
            onclick: () => {
              // Прогоняем ровно те слова, что были в занятии, а не всю колоду.
              // sessionRight помнит каждое отвеченное слово — это и есть занятие.
              const again = [...sessionRight.keys()];
              resetSessionResults();
              srs.buildExtraQueue(again);
              nextCard();
            },
          },
          'Повторить ещё раз',
        ),
      ),
      // Итог занятия — тот момент, когда серия и точность только что изменились.
      renderProgress(),
      renderArchiveOffer(),
    ),
  );
}

function answer(mode, correct, opts) {
  const res = srs.grade(currentKey, mode, correct, opts);
  notes.countCard();

  // Слово, которое уже в архиве и там же осталось, в итоги не пишем: предлагать
  // архив тому, что в нём лежит, нечего. А вот выпавшее из архива — это промах,
  // и он записывается как промах.
  if (res && !res.arch) recordAnswer(wordIdOf(currentKey), correct);
  if (!correct) {
    const id = wordIdOf(currentKey);
    recentMisses = recentMisses.filter((x) => x !== id).concat(id).slice(-MISSES_KEPT);
  }

  // Цель должна быть точкой, а не цифрой, которая молча уезжает в 21, 22, 23.
  // Останавливаемся один раз и спрашиваем, продолжать ли.
  //
  // Но только если занятие ещё не кончилось: когда цель берётся последней карточкой,
  // экран цели — это тупик вместо экрана конца занятия, и предложение убрать выученное
  // в архив до пользователя просто не доезжает.
  if (
    !goalCelebrated &&
    res &&
    res.counted &&
    state.stats.done >= state.settings.goal &&
    srs.queueLength() > 0
  ) {
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
  screen = 'goal';
  setFocus(true);
  const left = srs.queueLength();
  replace(
    stage,
    el(
      'div',
      { class: 'empty' },
      // Цель считается за занятие, а не за день.
      el('div', { class: 'cap', text: 'Урок пройден' }),
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
  // Число обрезаем по цели, как и полоску: цель достигнута — значит «20 / 20», а не
  // «49 / 20». Занятие после этого можно продолжать, но счётчик уже ничего не измеряет.
  goalNum.textContent = done + ' / ' + goal;
}

// Шесть сегментов шириной пропорционально числу карточек. Подпись не висит постоянно —
// появляется по тапу, иначе шкала превращается в таблицу и перестаёт быть тихой.
function renderRail() {
  const { boxes, arch } = srs.boxCounts();
  // Имя стадии вместо «коробки N», номер и срок — в подписи по тапу.
  const segments = boxes.map((count, i) => ({
    key: String(i + 1),
    count,
    label: srs.STAGES[i][0].toUpperCase() + srs.STAGES[i].slice(1),
    sub: 'коробка ' + (i + 1) + ', через ' + srs.BOX_LABEL[i],
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

// Активные и выученные вперемешку — это терпимо на семидесяти словах и каша на пятистах.
// Поэтому список всегда показывает что-то одно, а «Все» остаётся отдельным выбором.
let listScope = 'active'; // 'active' | 'hard' | 'arch' | 'all'

const SCOPE_LABEL = { active: 'Активные', hard: 'Трудные', arch: 'Архив', all: 'Все' };

function renderScope() {
  const words = activeWords();
  const archived = words.filter((w) => srs.isArchived(w.id)).length;
  const hard = srs.hardWordIds();
  const hardCount = words.filter((w) => hard.has(w.id)).length;
  const counts = { active: words.length - archived, hard: hardCount, arch: archived, all: words.length };
  // Трудных обычно нет, и пустая кнопка была бы шумом. Последнее трудное ушло,
  // пока список был открыт на них, — возвращаемся к активным.
  if (listScope === 'hard' && !hardCount) listScope = 'active';

  replace(
    $('list-scope'),
    Object.keys(SCOPE_LABEL)
      .filter((key) => key !== 'hard' || hardCount)
      .map((key) =>
      el('button', {
        class: 'pill',
        text: SCOPE_LABEL[key] + ' · ' + counts[key],
        'aria-pressed': String(listScope === key),
        onclick: () => {
          listScope = key;
          renderScope();
          renderList();
        },
      }),
    ),
  );
}

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

// Строка в стиле iOS: слово и перевод слева, коробка справа, действия — за свайпом влево.
// Раньше «в архив» и «удалить» стояли на каждой строке, и слово переносилось в три ряда:
// двести сорок слов — это около ста двадцати экранов прокрутки. И удалить можно было
// промахнувшись мимо галочки.
//
// Свайп — не единственный путь: нажатие на строку раскрывает те же действия. Свайп
// не найти ни мышью, ни экранным чтецом, ни просто не зная о нём.
function renderList() {
  syncCatFilter();
  openItem = null;
  const q = (filterEl.value || '').toLowerCase().trim();
  const cat = $('filter-cat').value;
  const hard = srs.hardWordIds();
  const items = activeWords()
    .filter((w) => inScope(w, hard))
    .filter((w) => !cat || w.cat === cat)
    .filter((w) => !q || (w.es + ' ' + w.ru).toLowerCase().includes(q))
    .map((w) => listRow(w, hard.has(w.id)));

  replace(listEl, items.length ? items : el('p', { class: 'list-empty', text: 'Ничего не нашлось.' }));
}

function inScope(w, hard) {
  if (listScope === 'all') return true;
  const arch = srs.isArchived(w.id);
  if (listScope === 'arch') return arch;
  if (listScope === 'hard') return hard.has(w.id);
  return !arch;
}

function listRow(w, hard) {
  const arch = srs.isArchived(w.id);
  const check = el('input', { type: 'checkbox', class: 'pick', 'aria-label': 'Учить ' + w.es });
  check.checked = session.picked.has(w.id);
  check.addEventListener('change', () => {
    if (check.checked) session.picked.add(w.id);
    else session.picked.delete(w.id);
    renderPickedBar();
  });

  const actions = el(
    'div',
    { class: 'item-actions' },
    w.flagged
      ? el('button', { class: 'act act-plain', onclick: () => listUnflag(w) }, 'Снять пометку')
      : null,
    el('button', { class: 'act act-arch', onclick: () => listArchive(w, !arch) }, arch ? 'Вернуть' : 'В архив'),
    el('button', { class: 'act act-del', onclick: () => listDelete(w) }, 'Удалить'),
  );

  const tag = arch
    ? 'архив'
    : hard
      ? 'трудное'
      : srs.isNewWord(w.id)
        ? 'новое'
        : srs.STAGES[srs.wordBox(w.id) - 1];
  return el(
    'div',
    {
      class: 'item' + (arch ? ' arch' : '') + (w.flagged ? ' flagged' : '') + (hard ? ' hard' : ''),
      dataset: { id: w.id },
    },
    actions,
    el(
      'div',
      { class: 'item-main' },
      pickHit(check),
      el(
        'button',
        { class: 'item-body', 'aria-expanded': 'false' },
        el('span', { class: 'es', lang: 'es', text: (w.flagged ? '⚑ ' : '') + w.es }),
        el('span', { class: 'ru', text: w.ru }),
      ),
      el('span', { class: 'box-tag', text: tag }),
    ),
  );
}

// Открытой может быть одна строка за раз, как в iOS.
let openItem = null;

function setOpen(item, on) {
  if (on && openItem && openItem !== item) setOpen(openItem, false);
  const actions = item.querySelector('.item-actions');
  item.classList.toggle('open', on);
  item.querySelector('.item-body').setAttribute('aria-expanded', String(on));
  if (on) item.style.setProperty('--open', -actions.offsetWidth + 'px');
  if (on) {
    openItem = item;
    hideSwipeHint(true);
  }
  else if (openItem === item) openItem = null;
}

// Подсказка про свайп нужна, пока жест не найден. Открыл строку хоть раз — больше
// не показываем. Это удобство одного устройства, поэтому localStorage, а не состояние.
const HINT_KEY = 'palabras.swipeHint';

function hideSwipeHint(remember) {
  let seen = remember;
  try {
    if (remember) localStorage.setItem(HINT_KEY, '1');
    else seen = localStorage.getItem(HINT_KEY) === '1';
  } catch (e) {
    /* хранилище закрыто — подсказка просто останется */
  }
  if (seen) $('list-hint').classList.add('hidden');
}

// Свайп влево открывает действия, вправо — закрывает. Слушаем весь список, а не каждую
// строку: строк сотни. Мышью не тянем — у неё есть нажатие.
function bindSwipe() {
  const SLOP = 10; // столько пикселей движения ещё считается касанием, а не жестом
  let drag = null;
  let blockClickUntil = 0;
  let blockClickIn = null;

  listEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const main = e.target.closest('.item-main');
    if (!main) return;
    const item = main.parentNode;
    const width = item.querySelector('.item-actions').offsetWidth;
    drag = {
      item,
      main,
      width,
      x: e.clientX,
      y: e.clientY,
      base: item.classList.contains('open') ? -width : 0,
      offset: 0,
      active: false,
    };
  });

  listEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.active) {
      // Вертикальное движение — это прокрутка списка, её не трогаем.
      if (Math.abs(dy) > SLOP && Math.abs(dy) > Math.abs(dx)) {
        drag = null;
        return;
      }
      if (Math.abs(dx) < SLOP) return;
      drag.active = true;
      if (openItem && openItem !== drag.item) setOpen(openItem, false);
      drag.item.style.setProperty('--open', -drag.width + 'px');
      drag.item.classList.add('dragging');
    }
    // Чуть дальше кнопок тянется с сопротивлением, дальше не идёт.
    drag.offset = Math.min(0, Math.max(-drag.width * 1.25, drag.base + dx));
    drag.main.style.transform = 'translateX(' + drag.offset + 'px)';
  });

  const finish = () => {
    if (!drag) return;
    if (drag.active) {
      drag.item.classList.remove('dragging');
      drag.main.style.transform = '';
      setOpen(drag.item, drag.offset < -drag.width / 2);
      // За жестом браузер присылает click — он не должен тут же переключить строку обратно.
      // Только в самой строке: кнопки действий под ней должны нажиматься сразу.
      blockClickUntil = performance.now() + 400;
      blockClickIn = drag.main;
    }
    drag = null;
  };
  listEl.addEventListener('pointerup', finish);
  listEl.addEventListener('pointercancel', finish);

  listEl.addEventListener(
    'click',
    (e) => {
      if (performance.now() < blockClickUntil && blockClickIn && blockClickIn.contains(e.target)) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
  listEl.addEventListener('click', (e) => {
    const body = e.target.closest('.item-body');
    if (!body) return;
    const item = body.closest('.item');
    setOpen(item, !item.classList.contains('open'));
  });

  // Касание мимо открытой строки закрывает её.
  document.addEventListener('pointerdown', (e) => {
    if (openItem && !openItem.contains(e.target)) setOpen(openItem, false);
  });
}

// Действия из списка — без confirm, но с тостом «Отменить». Системный confirm
// выдёргивает из списка и на каждое удаление требует второго касания в другом месте экрана.
function listArchive(w, on) {
  const snap = srs.snapshotWord(w.id);
  srs.archiveWord(w.id, on);
  afterListChange();
  toast(on ? '«' + w.es + '» в архиве' : '«' + w.es + '» снова учится', () => {
    srs.restoreWord(w.id, snap);
    afterListChange();
  });
}

function listDelete(w) {
  deleteWord(w.id);
  srs.dropWord(w.id);
  afterListChange();
  toast('«' + w.es + '» удалено', () => {
    undeleteWord(w.id);
    afterListChange();
  });
}

function listUnflag(w) {
  flagWord(w.id, false);
  renderList();
}

function afterListChange() {
  renderScope();
  renderList();
  renderRail();
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

  $('btn-add-open').addEventListener('click', () => setAddOpen($('add-form').classList.contains('hidden')));

  // Enter в первом поле ведёт во второе, во втором — добавляет: без мыши и без
  // лишнего касания по кнопке.
  $('new-es').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('new-ru').focus();
  });
  $('new-ru').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-add').click();
  });

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
    // Форма остаётся открытой: слова обычно добавляют пачкой.
    $('new-es').focus();
    setNote('Добавлено: ' + es + '.');
    renderScope();
    renderList();
    renderRail();
  });

  bindSwipe();
  hideSwipeHint(false);

  $('btn-export').addEventListener('click', () => exportDeck());
  $('btn-import').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', importDeck);
  $('btn-reset').addEventListener('click', resetProgress);
}

function setAddOpen(on) {
  $('add-form').classList.toggle('hidden', !on);
  $('btn-add-open').setAttribute('aria-expanded', String(on));
  if (on) $('new-es').focus();
  else setNote('');
}

// Сообщения о колоде пишутся там, откуда нажали: добавление — в «Словах»,
// скачать / загрузить / сбросить — в «Настройках».
function setNote(text, where = 'words-note') {
  $(where).textContent = text;
}

// Выгружаем только слова и прогресс. Настройки устройства в файл не кладём —
// позже там будет токен синхронизации, и ему в скачанном файле не место.
function exportDeck(name = 'palabras-' + today() + '.json') {
  const dump = { v: state.v, exported: now(), words: state.words, cards: state.cards };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }),
  );
  const a = el('a', { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function liveCount(words) {
  return words.filter((w) => w && !w.deleted).length;
}

// Загрузка заменяет колоду и прогресс целиком, отмены нет. Раньше это происходило молча:
// старый файл, выбранный по ошибке, стирал месяцы прогресса одним касанием.
//
// Поэтому сначала скачиваем копию текущей колоды и только потом спрашиваем. Копия
// уходит до вопроса, а не после: после «да» сразу идёт перезагрузка, и на телефоне она
// обрывает начатое скачивание. Лишний файл при «нет» — дешёвая цена за то, что откатиться
// можно всегда.
function importDeck(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
      if (!Array.isArray(data.words) || !data.cards) throw new Error('не колода');
    } catch (err) {
      setNote('Файл не похож на колоду Palabras.', 'settings-note');
      return;
    }

    const incoming = liveCount(data.words);
    const current = liveCount(state.words);
    const backup = 'palabras-backup-' + today() + '.json';
    if (current) exportDeck(backup);

    const question =
      'В файле ' + incoming + ' ' + plural(incoming, 'слово', 'слова', 'слов') +
      ', сейчас в колоде ' + current + '. Слова и прогресс заменятся содержимым файла.' +
      (current ? '\n\nКопия текущей колоды скачана: ' + backup + '.' : '') +
      '\n\nЗаменить?';
    if (!confirm(question)) {
      setNote('Загрузка отменена, колода не тронута.', 'settings-note');
      return;
    }

    state.words = data.words;
    state.cards = data.cards;
    // Индекс слов живёт в state.js, а мы подменили массив целиком — перечитываем всё.
    // Перезагружаемся только после того, как запись действительно легла на диск.
    save().then(() => location.reload());
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
  renderScope();
  renderList();
  prepareSession();
  renderHome();
  setNote('Прогресс сброшен.', 'settings-note');
}

// ---------------------------------------------------------------------------
// вкладки и клавиатура
// ---------------------------------------------------------------------------

const VIEWS = ['learn', 'words', 'rules', 'settings'];

function showView(which) {
  view = which;
  for (const name of VIEWS) {
    $('view-' + name).classList.toggle('hidden', name !== which);
    $('tab-' + name).setAttribute('aria-current', String(name === which));
  }
  if (which === 'words') {
    renderScope();
    renderList();
    renderPickedBar();
    if (!activeWords().length) setAddOpen(true);
  }
  // Пока занятие не начато, его можно собрать заново: в «Словах» могли добавить,
  // удалить или убрать в архив. Начатое на паузе не трогаем — «Продолжить» вернёт его.
  if (which === 'learn' && screen === 'home') {
    if (!resume) prepareSession();
    renderHome();
  }
  if (which === 'rules') renderRules();
}

// ---------------------------------------------------------------------------
// раздел «Правила»
// ---------------------------------------------------------------------------

// Раздел — оглавление, а не простыня. Раньше здесь подряд стояли 32 правила в десяти
// группах, около четырёх экранов прокрутки, и открытое правило раздвигало список ещё
// на экран. Теперь группы свёрнуты в карточки с подписью, правило открывается окном
// поверх списка (место в списке не теряется), а поиск находит правило и по форме из таблицы.
//
// Что раскрыто и что набрано в поиске — в памяти: вернулся на вкладку — всё как было.
// После перезагрузки раскрыта первая группа: с неё и стоит начинать.
let rulesOpen = null;
let rulesQuery = '';

function renderRules() {
  const groups = notes.byGroup();
  if (!groups.length) {
    replace(
      $('rules'),
      el(
        'div',
        { class: 'empty' },
        el('h2', { text: 'Правил пока нет' }),
        el('p', { text: 'Они лежат в notes.seed.json и подтягиваются из репозитория.' }),
      ),
    );
    return;
  }
  if (!rulesOpen) rulesOpen = new Set([groups[0].code]);

  const results = el('div', { class: 'rules-results' });
  const search = el('input', {
    type: 'search',
    class: 'filter rules-search',
    placeholder: 'Найти правило или форму: tengo, hago',
    'aria-label': 'Найти правило',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    value: rulesQuery,
    oninput: (e) => {
      rulesQuery = e.target.value;
      renderRuleResults(results, groups);
    },
  });
  replace($('rules'), el('div', { class: 'rules-top' }, search), results);
  renderRuleResults(results, groups);
}

function renderRuleResults(box, groups) {
  const query = rulesQuery.trim();
  if (query) {
    const found = [];
    for (const group of groups) {
      for (const note of group.notes) if (notes.matches(note, query)) found.push({ note, group });
    }
    if (!found.length) {
      replace(
        box,
        el('p', { class: 'hint rules-empty', text: 'Ничего не нашлось. Попробуй форму глагола или слово по-испански без ударений.' }),
      );
      return;
    }
    // Найденное — одним списком, у каждой строки подпись группы: искали поперёк разделов.
    const list = found.map((f) => f.note);
    replace(
      box,
      el('p', { class: 'cap rules-count', text: plural(found.length, 'правило', 'правила', 'правил') }),
      el(
        'ul',
        { class: 'rule-rows is-flat' },
        found.map(({ note, group }) => renderRuleRow(note, list, group.label)),
      ),
    );
    return;
  }
  replace(box, groups.map((group) => renderRuleGroup(group)));
}

// Группа — карточка-гармошка: название, подпись и число правил видны всегда.
function renderRuleGroup(group) {
  const id = 'rg-' + (group.code || 'misc');
  const open = rulesOpen.has(group.code);
  const body = el(
    'ul',
    { class: 'rule-rows', id, hidden: !open },
    group.notes.map((note) => renderRuleRow(note, group.notes)),
  );
  const head = el(
    'button',
    {
      class: 'rule-group-head',
      type: 'button',
      'aria-expanded': String(open),
      'aria-controls': id,
      onclick: () => {
        const now = !rulesOpen.has(group.code);
        if (now) rulesOpen.add(group.code);
        else rulesOpen.delete(group.code);
        body.hidden = !now;
        head.setAttribute('aria-expanded', String(now));
      },
    },
    el(
      'span',
      { class: 'rule-group-text' },
      el('span', { class: 'rule-group-title', text: group.label }),
      group.about ? el('span', { class: 'rule-group-about', text: group.about }) : null,
    ),
    el('span', { class: 'rule-group-count', 'aria-label': plural(group.notes.length, 'правило', 'правила', 'правил'), text: String(group.notes.length) }),
    el('span', { class: 'rule-chevron', 'aria-hidden': 'true' }),
  );
  return el('section', { class: 'rule-group' + (open ? ' is-open' : '') }, head, body);
}

// Строка правила: название и суть одной строкой. Само правило — в окне поверх списка:
// раскрытое на месте, оно сдвигало всё остальное на экран-другой вниз.
function renderRuleRow(note, siblings, groupLabel = '') {
  return el(
    'li',
    null,
    el(
      'button',
      {
        class: 'rule-row-btn',
        type: 'button',
        'aria-haspopup': 'dialog',
        onclick: (e) => notes.openRule(note, e.currentTarget, siblings),
      },
      el(
        'span',
        { class: 'rule-row-text' },
        groupLabel ? el('span', { class: 'cap', text: groupLabel }) : null,
        el('span', { class: 'rule-row-title', text: note.title || note.id }),
        note.gist ? el('span', { class: 'rule-row-gist', text: note.gist }) : null,
      ),
      el('span', { class: 'rule-row-chevron', 'aria-hidden': 'true' }),
    ),
  );
}

// Клавиши не разбираются в режимах: каждый режим просто помечает свою кнопку
// через data-key, а оболочка находит её и нажимает. Новый режим ничего тут не меняет.
function keyName(e) {
  if (e.key === 'Escape') return 'escape';
  if (e.key === 'Enter') return 'enter';
  if (e.code === 'Space') return 'space';
  if (e.key === '1' || e.key === '2' || e.key === '3') return e.key;
  return null;
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (view !== 'learn' || e.metaKey || e.ctrlKey || e.altKey) return;
    // Открыто правило поверх карточки — Esc закрывает его сам (dialog), а Enter
    // не должен нажимать «Дальше» под ним.
    if (document.querySelector('dialog[open]')) return;
    const name = keyName(e);
    if (!name) return;
    if (name === 'escape') {
      if (document.body.classList.contains('in-session')) exitSession();
      return;
    }

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
  bindGoalChoice();
  applyLessonSize();
  bindWordsView();
  bindSpeech();
  bindToast();
  notes.bindSheet();
  bindKeyboard();
  for (const name of VIEWS) {
    $('tab-' + name).addEventListener('click', () => showView(name));
  }
  $('btn-exit').addEventListener('click', exitSession);

  prepareSession();
  renderHome();

  // Правила подтягиваются в фоне и не задерживают первую карточку.
  notes.loadNotes().then(() => {
    if (view === 'rules') renderRules();
  });

  if (!firstRun) {
    mergeSeed().then((added) => {
      if (!added) return;
      renderRail();
      // На несобранном старте — пересобрать с новыми словами. Посреди занятия и на паузе
      // очередь не трогаем: пересборка подменила бы оставшиеся слова другими.
      if (screen === 'home' && !resume) {
        prepareSession();
        renderHome();
      }
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
      // updateViaCache: 'none' — сам файл воркера всегда проверять на сервере.
      // GitHub Pages отдаёт его с max-age=600, и без этого браузер до десяти минут
      // не замечает, что вышла новая версия.
      .register('sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        // Приложение с домашнего экрана живёт неделями и страницу не перезагружает.
        // Проверяем обновление каждый раз, когда его открывают заново.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
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
