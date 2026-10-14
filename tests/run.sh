#!/bin/sh
# Запуск всех проверок. Отдельный скрипт, потому что node --test требует package.json
# с {"type":"module"}, а класть его в репозиторий нельзя — он выглядит как шаг к npm
# (см. «Жёсткие правила» в CLAUDE.md). Поэтому копируем проект во временную папку,
# кладём package.json туда и запускаем оттуда. Сайта это не касается никак.
#
#   sh tests/run.sh
#
# Папку tests в копии сохраняем: тесты импортируют ../src/*.js, и из корня
# временной папки путь уехал бы наружу.

set -e
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/tests"
cp -R "$root/src" "$tmp/"
cp "$root/deck.seed.json" "$root/notes.seed.json" "$tmp/"
cp "$root"/tests/*.test.js "$tmp/tests/"
echo '{"type":"module"}' > "$tmp/package.json"

cd "$tmp" && node --test "$@"
