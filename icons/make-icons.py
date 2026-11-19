#!/usr/bin/env python3
"""Генератор иконок приложения. Разовая утилита, к сборке сайта отношения не имеет —
запускается руками, когда надо перерисовать иконки, а результат коммитится как PNG.

Зависимостей нет специально: PNG пишется вручную через zlib, как и всё остальное
в этом проекте.

Мотив — облачко реплики с буквой «ñ»: самая испанская буква алфавита и разговор.
Зелёный — акцент приложения (`--accent` в styles.css), тильда — терракота,
единственное тёплое пятно. Та же картинка векторно лежит в `icons/icon.svg`
(фавикон и знак в шапке) — геометрия ниже и там должна совпадать.

Рисуется через функции расстояния (SDF): у каждой фигуры считается расстояние
от пикселя до края, и сглаживание получается из него само, без суперсэмплинга.

    python3 icons/make-icons.py
"""

import math
import os
import struct
import zlib

BG_TOP = (0x4E, 0x73, 0x55)
BG_BOTTOM = (0x2C, 0x45, 0x31)
CREAM = (0xFB, 0xF8, 0xF1)
INK = (0x2F, 0x4A, 0x34)
TILDE = (0xE0, 0x6E, 0x3C)

MASTER = 512

# Геометрия в долях холста — те же числа, что во viewBox="0 0 100 100" у icon.svg, делённые на 100.
BUBBLE = dict(x0=0.17, y0=0.16, x1=0.83, y1=0.74, r=0.17)
TAIL = [(0.27, 0.66), (0.47, 0.70), (0.22, 0.86)]
TAIL_ROUND = 0.012        # скругление углов хвостика, иначе кончик колется
STROKE = 0.085            # толщина буквы n
N_LEFT, N_RIGHT = 0.345, 0.655   # внешние края стоек
N_TOP, N_BOTTOM = 0.385, 0.64    # верх левой стойки и низ стоек
SPUR = 0.03               # на сколько стойка выше плеча арки
TILDE_Y, TILDE_A, TILDE_W, TILDE_STROKE = 0.298, 0.028, 0.14, 0.062


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


# ---------- функции расстояния: < 0 внутри фигуры, > 0 снаружи ----------

def sd_round_box(x, y, b):
    cx, cy = (b["x0"] + b["x1"]) / 2, (b["y0"] + b["y1"]) / 2
    hx, hy = (b["x1"] - b["x0"]) / 2 - b["r"], (b["y1"] - b["y0"]) / 2 - b["r"]
    qx, qy = abs(x - cx) - hx, abs(y - cy) - hy
    outside = math.hypot(max(qx, 0), max(qy, 0))
    return outside + min(max(qx, qy), 0) - b["r"]


def sd_segment(x, y, ax, ay, bx, by):
    px, py, ex, ey = x - ax, y - ay, bx - ax, by - ay
    t = max(0.0, min(1.0, (px * ex + py * ey) / (ex * ex + ey * ey)))
    return math.hypot(px - ex * t, py - ey * t)


def sd_triangle(x, y, pts):
    """Точное расстояние до треугольника: до ближайшей стороны, со знаком «внутри»."""
    d = min(sd_segment(x, y, *pts[i], *pts[(i + 1) % 3]) for i in range(3))
    inside = True
    sign = None
    for i in range(3):
        (ax, ay), (bx, by) = pts[i], pts[(i + 1) % 3]
        cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
        s = cross > 0
        if sign is None:
            sign = s
        elif s != sign:
            inside = False
    return -d if inside else d


def smooth_min(a, b, k):
    """Слияние без острого угла — хвостик вырастает из облачка, а не приклеен к нему."""
    h = max(k - abs(a - b), 0.0) / k
    return min(a, b) - h * h * k / 4


def sd_bubble(x, y):
    return smooth_min(sd_round_box(x, y, BUBBLE), sd_triangle(x, y, TAIL) - TAIL_ROUND, 0.06)


def sd_n(x, y):
    """Строчная n как в округлых гротесках: арка-«∩» и левая стойка, поднятая выше плеча.
    Если верх стойки и верх арки совпадают, в развилке остаётся щель в пару пикселей,
    и она выглядит браком; поднятая стойка делает развилку явной — так её и читают как n."""
    w = STROKE
    xl, xr = N_LEFT + w / 2, N_RIGHT - w / 2      # оси стоек
    rc = (xr - xl) / 2                            # радиус оси арки
    xm = (xl + xr) / 2
    ya = N_TOP + SPUR + w / 2 + rc                # центр арки: плечо ниже верха стойки
    foot = N_BOTTOM - w / 2

    # арка: кольцо, обрезанное по горизонтали центра; ниже — правая стойка
    arch = max(abs(math.hypot(x - xm, y - ya) - rc) - w / 2, y - ya)
    left = sd_segment(x, y, xl, N_TOP + w / 2, xl, foot) - w / 2
    right = sd_segment(x, y, xr, ya, xr, foot) - w / 2
    return min(arch, left, right)


def tilde_points(steps=48):
    """Один период синуса: левый горб вверх, правый вниз — так «~» пишется рукой."""
    pts = []
    for i in range(steps + 1):
        t = -1 + 2 * i / steps
        pts.append((0.5 + TILDE_W * t, TILDE_Y + TILDE_A * math.sin(math.pi * t)))
    return pts


TILDE_PTS = tilde_points()


def sd_tilde(x, y):
    if abs(x - 0.5) > TILDE_W + TILDE_STROKE or abs(y - TILDE_Y) > TILDE_A + TILDE_STROKE:
        return 1.0
    d = min(
        sd_segment(x, y, *TILDE_PTS[i], *TILDE_PTS[i + 1]) for i in range(len(TILDE_PTS) - 1)
    )
    return d - TILDE_STROKE / 2


# ---------- отрисовка ----------

def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def coverage(d, px):
    """Доля пикселя внутри фигуры по расстоянию до края: линейный спуск шириной в пиксель."""
    return max(0.0, min(1.0, 0.5 - d / px))


def render(size, scale):
    """scale — доля холста под мотив: для maskable её уменьшаем, чтобы пережить обрезку."""
    px = 1.0 / size / scale
    rows = []
    for j in range(size):
        v = (j + 0.5) / size
        bg = mix(BG_TOP, BG_BOTTOM, v)
        y = 0.5 + (v - 0.5) / scale
        row = []
        for i in range(size):
            x = 0.5 + ((i + 0.5) / size - 0.5) / scale
            c = bg
            a = coverage(sd_bubble(x, y), px)
            if a > 0:
                c = mix(c, CREAM, a)
                a = coverage(sd_n(x, y), px)
                if a > 0:
                    c = mix(c, INK, a)
                a = coverage(sd_tilde(x, y), px)
                if a > 0:
                    c = mix(c, TILDE, a)
            row.append(tuple(int(round(ch)) for ch in c))
        rows.append(row)
    return rows


def main():
    here = os.path.dirname(os.path.abspath(__file__))

    # Каждый размер рисуется заново, а не уменьшается из 512: SDF даёт чёткий край на любом.
    for size in (512, 192, 180):
        write_png(os.path.join(here, "icon-%d.png" % size), size, size, render(size, 1.0))

    # Maskable: система может обрезать иконку до круга (безопасная зона — круг 80 %),
    # поэтому облачко с хвостиком ужимаем, чтобы хвостик не срезался.
    write_png(
        os.path.join(here, "icon-maskable-512.png"), MASTER, MASTER, render(MASTER, 0.78)
    )

    print("готово:", ", ".join(sorted(f for f in os.listdir(here) if f.endswith(".png"))))


if __name__ == "__main__":
    main()
