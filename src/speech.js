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

function supported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

// iPhone, iPad (в том числе iPad, который притворяется Маком) и Мак. На них испанский голос
// есть в системе всегда, а getVoices() в Safari бывает пустым (iOS 18) или перечисляет
// голоса, которые не скачаны: такая фраза молчит без ошибки.
function isApple() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return true; // любой браузер на iOS — это WebKit
  if (!/Macintosh/.test(ua)) return false;
  // iPad в режиме «как на компьютере» называет себя Маком, и Chrome на нём — тоже WebKit.
  // Отличает его тачскрин: у Мака его нет.
  if (navigator.maxTouchPoints > 1) return true;
  return !/Chrome|Chromium|Firefox|Edg/.test(ua);
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
}

function notify() {
  for (const fn of listeners) fn();
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
  u.onend = () => trace('end');
  u.onerror = (e) => {
    trace('error: ' + e.error);
    // interrupted и canceled — это мы сами оборвали прошлую фразу, не ошибка.
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    lastError = ERRORS[e.error] || 'ошибка синтеза: ' + e.error;
    notify();
  };
  u.onstart = () => {
    trace('start');
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
  clearTimeout(pendingTimer);
  current = utter(text, rate);
  const u = current;
  // Chrome после ухода со вкладки и долгого простоя застревает на паузе и молчит.
  if (synth.paused) synth.resume();
  const busy = synth.speaking || synth.pending;
  trace('speak' + (busy ? ' (занят)' : ''));
  if (busy) synth.cancel();
  // iOS пускает звук только из обработчика нажатия: отложенная фраза выпадает из жеста
  // и молчит. Поэтому на Apple — сразу, даже после cancel(): Safari после него теряет
  // только события фразы, а не звук.
  if (!busy || isApple()) {
    synth.speak(u);
    return;
  }
  // Chrome и Firefox теряют speak() сразу после cancel() — нужен зазор.
  // Без жеста им можно: им хватает того, что на странице уже нажимали.
  pendingTimer = setTimeout(() => {
    if (current === u) synth.speak(u);
  }, 120);
}

// Журнал последних событий синтеза — для «Проверить звук». Отличает «фраза прозвучала,
// а звука нет» (началась и кончилась — значит, беззвучный режим или громкость)
// от «браузер проглотил фразу» (ни начала, ни ошибки).
let log = [];
let logStart = 0;
function trace(what) {
  log.push(((performance.now() - logStart) / 1000).toFixed(1) + ' с ' + what);
}

export function testSpeech(done) {
  log = [];
  logStart = performance.now();
  speak('Hola, ¿qué tal?');
  setTimeout(() => {
    const synth = window.speechSynthesis;
    const voices = synth.getVoices();
    const ua = navigator.userAgent || '';
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const started = log.some((l) => l.endsWith('start'));
    const failed = log.find((l) => l.includes('error'));
    const verdict = failed
      ? 'фраза не прозвучала: ' + (ERRORS[failed.replace(/^.* error: /, '')] || failed)
      : started
        ? 'фраза прозвучала — если звука не было, дело в беззвучном режиме или громкости'
        : 'браузер проглотил фразу: ни начала, ни ошибки';
    done({
      verdict,
      details: [
        'события: ' + (log.join(', ') || 'нет'),
        'голосов ' + voices.length + ', испанских ' + voices.filter((v) => /^es([-_]|$)/i.test(v.lang)).length,
        'выбран: ' + voiceName(),
        'Apple: ' + (isApple() ? 'да' : 'нет') + ', ' + (standalone ? 'с экрана «Домой»' : 'в браузере'),
        'speaking ' + synth.speaking + ', pending ' + synth.pending + ', paused ' + synth.paused,
        ua.replace(/^Mozilla\/5\.0 /, ''),
      ].join(' · '),
    });
  }, 3000);
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
