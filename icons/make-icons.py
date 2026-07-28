#!/usr/bin/env python3
"""Генератор иконок приложения. Разовая утилита, к сборке сайта отношения не имеет —
запускается руками, когда надо перерисовать иконки, а результат коммитится как PNG.

Зависимостей нет специально: PNG пишется вручную через zlib, как и всё остальное
в этом проекте. Мотив — ромб с точкой, тот же, что в фоновой плитке интерфейса.

    python3 icons/make-icons.py
"""

import os
import struct
import zlib

COBALT = (0x25, 0x57, 0x8C)
CREAM = (0xFC, 0xFA, 0xF5)

SS = 3  # суперсэмплинг: рисуем в SS раз крупнее и усредняем, иначе края рваные
MASTER = 512


def write_png(path, width, height, rows):
    """rows — список строк, каждая строка список кортежей (r, g, b)."""
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def render(size, scale):
    """Кобальтовый квадрат, кремовый ромб, кобальтовая точка в центре.
    scale — доля холста под мотив: для maskable её уменьшаем, чтобы пережить обрезку."""
    big = size * SS
    cx = cy = (big - 1) / 2
    arm = big * 0.30 * scale  # половина диагонали ромба
    dot = big * 0.085 * scale

    rows = []
    for y in range(big):
        row = []
        dy = abs(y - cy)
        for x in range(big):
            dx = abs(x - cx)
            if dx * dx + dy * dy <= dot * dot:
                row.append(COBALT)
            elif dx + dy <= arm:
                row.append(CREAM)
            else:
                row.append(COBALT)
        rows.append(row)
    return downsample(rows, big, size)


def downsample(rows, big, size):
    """Усреднение блоками SS×SS — дешёвое сглаживание."""
    out = []
    area = SS * SS
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = 0
            for sy in range(SS):
                src = rows[y * SS + sy]
                for sx in range(SS):
                    px = src[x * SS + sx]
                    r += px[0]
                    g += px[1]
                    b += px[2]
            row.append((r // area, g // area, b // area))
        out.append(row)
    return out


def box_resize(rows, src, dst):
    """Уменьшение готовой картинки, чтобы не рендерить каждый размер заново."""
    out = []
    for y in range(dst):
        y0 = y * src // dst
        y1 = max(y0 + 1, (y + 1) * src // dst)
        row = []
        for x in range(dst):
            x0 = x * src // dst
            x1 = max(x0 + 1, (x + 1) * src // dst)
            r = g = b = n = 0
            for sy in range(y0, y1):
                for sx in range(x0, x1):
                    px = rows[sy][sx]
                    r += px[0]
                    g += px[1]
                    b += px[2]
                    n += 1
            row.append((r // n, g // n, b // n))
        out.append(row)
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))

    master = render(MASTER, 1.0)
    write_png(os.path.join(here, "icon-512.png"), MASTER, MASTER, master)
    for size in (192, 180):
        small = box_resize(master, MASTER, size)
        write_png(os.path.join(here, "icon-%d.png" % size), size, size, small)

    # Maskable: система может обрезать иконку до круга, поэтому мотив ужимаем в безопасную зону.
    masked = render(MASTER, 0.72)
    write_png(os.path.join(here, "icon-maskable-512.png"), MASTER, MASTER, masked)

    print("готово:", ", ".join(sorted(f for f in os.listdir(here) if f.endswith(".png"))))


if __name__ == "__main__":
    main()
