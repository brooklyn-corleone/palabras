// Профили: кто занимается на этом устройстве.
//
// Аккаунтов нет, поэтому «кто это» решает сам человек: при первом запуске на устройстве
// он выбирает себя из списка, и выбор запоминается. На общем ноутбуке профиль меняется
// кнопкой с именем в шапке. Пароля нет намеренно: профили разводят прогресс двух людей,
// а не прячут его друг от друга.
//
// У каждого профиля своё состояние в IndexedDB и свой файл в гисте синхронизации.
// Токен GitHub — один на устройство: оба файла лежат в одном приватном гисте.
//
// Добавить человека — дописать его сюда. `id` в ключах хранилища и в имени файла
// гиста, поэтому, как и `id` слова, он не меняется никогда.

import * as db from './db.js';

export const PROFILES = [
  { id: 'andrey', name: 'Андрей' },
  { id: 'diana', name: 'Диана' },
];

const CONFIG_KEY = 'profile';
// Ключ состояния до появления профилей. Его не переименовываем и не копируем: прогресс
// остаётся на месте и достаётся тому, кто первым выберет себя на этом устройстве.
export const LEGACY_KEY = 'state';

// Конфиг лежит в том же хранилище, что и состояние, а не в localStorage: проживут
// и пропадут они вместе. Иначе после очистки одного из них старый прогресс мог бы
// достаться не тому профилю.
let config = { current: null, legacy: null };

export async function loadConfig() {
  try {
    const c = await db.get(CONFIG_KEY);
    if (c && typeof c === 'object') config = { current: null, legacy: null, ...c };
  } catch (e) {
    console.warn('не удалось прочитать профиль:', e);
  }
  if (!byId(config.current)) config.current = null;
  return config;
}

export function byId(id) {
  return PROFILES.find((p) => p.id === id) || null;
}

export function current() {
  return byId(config.current);
}

// Где лежит состояние профиля. Чистая функция — проверяется в tests/profiles.test.js.
export function stateKeyFor(cfg, id) {
  return cfg && cfg.legacy === id ? LEGACY_KEY : LEGACY_KEY + ':' + id;
}

export function stateKey() {
  return stateKeyFor(config, config.current);
}

// Есть ли на устройстве прогресс до профилей, ещё никому не отданный.
export async function hasUnclaimedLegacy() {
  if (config.legacy) return false;
  try {
    const raw = await db.get(LEGACY_KEY);
    return !!(raw && typeof raw === 'object' && Array.isArray(raw.words) && raw.words.length);
  } catch (e) {
    return false;
  }
}

// Старый прогресс достаётся первому выбранному профилю, если у того ещё нет своего.
export async function choose(id) {
  if (!byId(id)) return;
  const next = { ...config, current: id };
  if (!next.legacy && (await hasUnclaimedLegacy())) {
    const own = await db.get(LEGACY_KEY + ':' + id).catch(() => null);
    if (!own) next.legacy = id;
  }
  config = next;
  await db.set(CONFIG_KEY, config);
}
