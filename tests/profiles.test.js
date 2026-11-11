// Профили (src/profiles.js) и их файлы в гисте (src/sync.js): где лежит чей прогресс.
//
//   sh tests/run.sh tests/profiles.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, stateKeyFor, LEGACY_KEY } from '../src/profiles.js';
import { fileFor, isOurGist } from '../src/sync.js';

test('прогресс до профилей остаётся на месте у того, кто его забрал', () => {
  const cfg = { current: 'andrey', legacy: 'andrey' };
  assert.equal(stateKeyFor(cfg, 'andrey'), LEGACY_KEY);
  assert.equal(stateKeyFor(cfg, 'diana'), 'state:diana');
  assert.equal(stateKeyFor({ current: 'diana', legacy: null }, 'diana'), 'state:diana');
});

test('у профилей разные ключи и разные файлы в гисте', () => {
  const keys = new Set(PROFILES.map((p) => stateKeyFor({}, p.id)));
  const files = new Set(PROFILES.map((p) => fileFor(p.id)));
  assert.equal(keys.size, PROFILES.length);
  assert.equal(files.size, PROFILES.length);
  for (const p of PROFILES) assert.match(p.id, /^[a-z0-9]+$/, 'id идёт в имя файла гиста');
});

test('свой гист узнаётся по файлу любого профиля', () => {
  assert.ok(isOurGist({ files: { 'palabras-diana.json': {} } }));
  assert.ok(isOurGist({ files: { 'palabras.json': {} } }));
  assert.ok(!isOurGist({ files: { 'notes.md': {} } }));
  assert.ok(!isOurGist({ files: { 'palabras-backup.json.bak': {} } }));
  assert.ok(!isOurGist(null));
});
