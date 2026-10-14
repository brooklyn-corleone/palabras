#!/bin/sh
# Запуск всех проверок. Отдельный скрипт, потому что node --test требует package.json
# с {"type":"module"}, а класть его в репозиторий нельзя — он выглядит как шаг к npm
# (см. «Жёсткие правила» в CLAUDE.md). Поэтому копируем проект во временную папку,
# кладём package.json туда и запускаем оттуда. Сайта это не касается никак.
#
#   sh tests/run.sh              — все проверки, читаемым списком
#   sh tests/run.sh tests/deck.test.js   — только данные колоды
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

# Без аргументов — читаемый список галочек вместо сырого TAP. С аргументами
# (отдельный файл, свой --test-reporter) передаём их как есть.
cd "$tmp"
if [ $# -eq 0 ]; then
  node --test --test-reporter=spec
else
  node --test "$@"
fi
