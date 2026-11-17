# Palabras

Spanish vocabulary trainer. Static PWA, no backend, works offline.
Spanish of Spain, not Latin America: `vosotros`, `el coche`, `el piso`.

## → [brooklyn-corleone.github.io/palabras](https://brooklyn-corleone.github.io/palabras/)

Open the link on your phone, then **Share → Add to Home Screen**. It launches without the
address bar and keeps working with no connection.

## What it does

- **726 words** in 24 themes, **46 grammar rules** in 9 groups — conjugation tables, irregular
  verbs grouped by type of change, gender and number, the future, prepositions, numbers and time.
- **Lesson lists**: the words a teacher assigned for each class (Lección 1–10 and daily routine so far). A session
  can be built from a list, a theme, hand-picked words or the hardest ones.
- Six card modes: quiz, typing, letter scramble, flip cards, dictation, matching pairs.
- Leitner boxes. The more hints a mode gives, the lower its ceiling — box 5 is reachable
  only by typing from memory. A new word is shown first; "I already know it" skips it ahead.
- Accents count but get highlighted; typos pass but cap the box at 4.
- After a mistake the related rule is one tap away, and rules pop up between cards.
- Spanish pronunciation via the system voice, including iPhone silent mode where supported.
- Learned words go to an archive and get mixed back in a few at a time, so they don't rot.
- Two profiles on one device. Progress lives in IndexedDB; optional sync between your own
  devices through a private GitHub Gist — no accounts, no server.

## Local development

```bash
python3 -m http.server 8000   # http:// is required — ES modules and the service worker
sh tests/run.sh               # won't load over file://
```

No build step, no npm, no dependencies. `git push` to `main` deploys.

## Docs

- `CLAUDE.md` — architecture, hard rules, data conventions. Read this first.
- `SETUP.md` — deploying, adding words and rules, setting up sync.
- `palabras-spec.md` — the original spec; some decisions changed since, see `CLAUDE.md`.
- `docs/` — UX audits.
