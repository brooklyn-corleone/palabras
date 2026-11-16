// Произношение через speechSynthesis — встроенный синтез речи браузера.
// Ни файлов, ни сети: голос берётся из системы. На iOS испанский голос обычно есть,
// а голос с localService работает и офлайн. Нет испанского голоса — нет и кнопки:
// английский голос, читающий «la llave», учит неправильному произношению.

import { el } from './dom.js';
import { state } from './state.js';

let voice = null;
let lastError = '';
const listeners = new Set();

// Ссылка на текущую фразу. Chrome держит SpeechSynthesisUtterance слабо: собранная
// сборщиком мусора фраза обрывается или не начинается вовсе — отсюда «работает через раз».
let current = null;
let pendingTimer = 0;
let unlocked = false;

function supported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

// iPhone, iPad (в том числе iPad, который притворяется Маком) и Мак. На них испанский голос
// есть в системе всегда, а getVoices() в Safari бывает пустым (iOS 18) или перечисляет
// голоса, которые не скачаны: такая фраза молчит без ошибки.
function isApple() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return true; // любой браузер на iOS — это WebKit
  return /Macintosh/.test(ua) && !/Chrome|Chromium|Firefox|Edg/.test(ua);
}

// Голоса-игрушки Apple (Eloquence и «новинки»): работают, но учат не тому произношению.
const NOVELTY = /^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Albert|Fred|Junior|Kathy|Ralph)\b/i;

// Предпочтения по порядку: не игрушка, локальный (работает офлайн), испанский из Испании
// (колода — кастильский вариант), голос по умолчанию, любой es-*.
function pickVoice() {
  const all = window.speechSynthesis.getVoices().filter((v) => /^es([-_]|$)/i.test(v.lang));
  if (!all.length) return null;
  const score = (v) =>
    (NOVELTY.test(v.name) ? -10 : 0) +
    (v.localService ? 4 : 0) +
    (/^es[-_]ES$/i.test(v.lang) ? 2 : 0) +
    (v.default ? 1 : 0);
  return all.sort((a, b) => score(b) - score(a))[0];
}

// Голос «системный испанский» без объекта голоса: фраза уходит с одним lang,
// и система сама берёт установленный голос.
const SYSTEM_VOICE = { name: 'системный', lang: 'es-ES', system: true };

// Список голосов приходит не сразу: в Chrome — событием voiceschanged, а Safari это событие
// присылает не всегда, поэтому ещё и опрос в первые секунды.
// Кто рисует кнопки, подписывается и перерисовывается, когда голос нашёлся.
export function initSpeech(onChange) {
  if (onChange) listeners.add(onChange);
  if (!supported()) return;
  const update = () => {
    const before = voice;
    voice = pickVoice() || (isApple() ? SYSTEM_VOICE : null);
    if (!!before !== !!voice || before?.name !== voice?.name) notify();
  };
  update();
  window.speechSynthesis.addEventListener('voiceschanged', update);
  for (const ms of [250, 1000, 3000]) setTimeout(update, ms);
  unlockOnFirstTouch();
}

function notify() {
  for (const fn of listeners) fn();
}

// iOS пускает звук синтеза, только если первая фраза сказана прямо в обработчике нажатия.
// Диктант и автоозвучка говорят при показе карточки — не всегда внутри жеста. Поэтому
// первое нажатие где угодно произносит беззвучную фразу: дальше iOS разрешает говорить
// без жеста. Слушаем click во всплытии, а не pointerdown: если нажали 🔊, speak() уже
// сработал внутри жеста и сам отметил unlocked — лишняя фраза его бы оборвала.
function unlockOnFirstTouch() {
  const unlock = () => {
    document.removeEventListener('click', unlock);
    document.removeEventListener('keydown', unlock);
    if (unlocked || !voice) return;
    unlocked = true;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.lang = 'es-ES';
    current = u;
    window.speechSynthesis.speak(u);
  };
  document.addEventListener('click', unlock);
  document.addEventListener('keydown', unlock);
}

export function canSpeak() {
  return !!voice;
}

export function voiceName() {
  if (!voice) return '';
  return voice.system ? 'системный испанский' : voice.name + ' · ' + voice.lang;
}

// Последняя ошибка синтеза — строкой в «Настройках». Молчащая кнопка без объяснения
// выглядит поломкой приложения, а причина чаще в устройстве.
export function speechError() {
  return lastError;
}

const ERRORS = {
  'not-allowed': 'браузер не дал говорить без нажатия — нажмите 🔊 ещё раз',
  'audio-busy': 'звук занят другим приложением',
  'audio-hardware': 'нет устройства вывода звука',
  'synthesis-unavailable': 'голос недоступен — проверьте, что он скачан',
  'voice-unavailable': 'голос недоступен — проверьте, что он скачан',
  'synthesis-failed': 'синтез речи не сработал',
  network: 'сетевой голос не ответил — нужен интернет или локальный голос',
};

function utter(text, rate) {
  const u = new SpeechSynthesisUtterance(text);
  // На Apple — только язык: объект голоса там бывает «нескачанным» и молчит.
  if (voice && !voice.system && !isApple()) u.voice = voice;
  u.lang = voice.lang.replace('_', '-');
  u.rate = rate;
  u.onerror = (e) => {
    // interrupted и canceled — это мы сами оборвали прошлую фразу, не ошибка.
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    lastError = ERRORS[e.error] || 'ошибка синтеза: ' + e.error;
    notify();
  };
  u.onstart = () => {
    if (lastError) {
      lastError = '';
      notify();
    }
  };
  return u;
}

// rate — для «медленно» в диктанте: на обычной скорости ll/y и b/v на слух сливаются.
// По умолчанию чуть медленнее обычного: слушают, чтобы разобрать звуки.
export function speak(text, rate = 0.9) {
  if (!voice || !text) return;
  const synth = window.speechSynthesis;
  unlocked = true;
  clearTimeout(pendingTimer);
  current = utter(text, rate);
  const u = current;
  // Chrome после ухода со вкладки и долгого простоя застревает на паузе и молчит.
  if (synth.paused) synth.resume();
  if (synth.speaking || synth.pending) {
    // Новое слово обрывает недоговорённое, иначе быстрые ответы копят очередь фраз.
    // Но speak() сразу после cancel() Chrome и Safari теряют — нужен зазор.
    // Сюда попадаем, только когда уже что-то звучало, то есть iOS звук уже разрешил.
    synth.cancel();
    pendingTimer = setTimeout(() => {
      if (current === u) synth.speak(u);
    }, 120);
    return;
  }
  // Ничего не звучит — говорим сразу, внутри нажатия: так iOS пускает первую фразу.
  synth.speak(u);
}

// Сам по себе, без нажатия, — только если включено в настройках. По умолчанию выключено:
// звук из телефона в транспорте неожиданно и неловко.
export function autoSpeak(text) {
  if (state.settings.autoSpeak) speak(text);
}

export const ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/>' +
  '<path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';

// Испанский текст и кнопка рядом. Без голоса — просто текст, без пустого места под кнопку.
export function sayable(node, text) {
  if (!voice) return node;
  const btn = el('button', {
    class: 'speak',
    type: 'button',
    'aria-label': 'Произнести: ' + text,
    onclick: (e) => {
      e.stopPropagation();
      speak(text);
    },
  });
  btn.innerHTML = ICON;
  return el('div', { class: 'say' }, node, btn);
}
