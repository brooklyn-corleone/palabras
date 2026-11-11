// Произношение через speechSynthesis — встроенный синтез речи браузера.
// Ни файлов, ни сети: голос берётся из системы. На iOS испанский голос обычно есть,
// а голос с localService работает и офлайн. Нет испанского голоса — нет и кнопки:
// английский голос, читающий «la llave», учит неправильному произношению.

import { el } from './dom.js';
import { state } from './state.js';

let voice = null;
const listeners = new Set();

function supported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

// Предпочтения по порядку: локальный (работает офлайн), испанский из Испании
// (колода — кастильский вариант), любой es-*.
function pickVoice() {
  const all = window.speechSynthesis.getVoices().filter((v) => /^es([-_]|$)/i.test(v.lang));
  if (!all.length) return null;
  const score = (v) => (v.localService ? 2 : 0) + (/^es[-_]ES$/i.test(v.lang) ? 1 : 0);
  return all.sort((a, b) => score(b) - score(a))[0];
}

// Список голосов в Chrome приходит не сразу, а событием voiceschanged.
// Поэтому кто рисует кнопки, подписывается и перерисовывается, когда голос нашёлся.
export function initSpeech(onChange) {
  if (onChange) listeners.add(onChange);
  if (!supported()) return;
  const update = () => {
    const before = voice;
    voice = pickVoice();
    if (!!before !== !!voice) for (const fn of listeners) fn();
  };
  update();
  window.speechSynthesis.addEventListener('voiceschanged', update);
}

export function canSpeak() {
  return !!voice;
}

export function voiceName() {
  return voice ? voice.name + ' · ' + voice.lang : '';
}

export function speak(text) {
  if (!voice || !text) return;
  const synth = window.speechSynthesis;
  // Новое слово обрывает недоговорённое: иначе быстрые ответы копят очередь фраз.
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = 0.9; // чуть медленнее обычного: слушают, чтобы разобрать звуки
  synth.speak(u);
}

// Сам по себе, без нажатия, — только если включено в настройках. По умолчанию выключено:
// звук из телефона в транспорте неожиданно и неловко.
export function autoSpeak(text) {
  if (state.settings.autoSpeak) speak(text);
}

const ICON =
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
