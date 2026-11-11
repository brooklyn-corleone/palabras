# Palabras

Spanish vocabulary trainer for Russian speakers. Static PWA, no backend, works offline.

## → [brooklyn-corleone.github.io/palabras](https://brooklyn-corleone.github.io/palabras/)

Open the link on your phone, then **Share → Add to Home Screen**. It launches without the
address bar and keeps working with no connection.

## What it does

- **287 words** in 16 themes, **32 grammar rules** with conjugation tables.
- Five card modes: quiz, typing, letter scramble, flip cards, matching pairs.
- Leitner boxes. The more hints a mode gives, the lower its ceiling — box 5 is reachable
  only by typing from memory.
- Learned words go to an archive and get mixed back in a few at a time, so they don't rot.
- Progress lives in IndexedDB on the device. Optional sync between your own devices through
  a private GitHub Gist — no accounts, no server.

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
