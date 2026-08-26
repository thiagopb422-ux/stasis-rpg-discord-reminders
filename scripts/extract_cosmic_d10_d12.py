"""Extract the Stasis Cosmic D10 and D12 faces from their transparent sheet."""

from __future__ import annotations

import argparse
import shutil
from collections import deque
from pathlib import Path

from PIL import Image


D10_X = (0, 372, 682, 989, 1302, 1640)
D10_Y = (0, 221, 432)
D12_X = (0, 309, 569, 833, 1102, 1366, 1640)
D12_Y = (432, 666, 920)


def visible_bounds(image: Image.Image, threshold: int = 12) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > threshold else 0)
    pixels = mask.load()
    visited = bytearray(image.width * image.height)
    largest: tuple[int, int, int, int, int] | None = None
    for y in range(image.height):
        for x in range(image.width):
            offset = (y * image.width) + x
            if visited[offset] or pixels[x, y] == 0:
                continue
            queue = deque([(x, y)])
            visited[offset] = 1
            size = 0
            left = right = x
            top = bottom = y
            while queue:
                current_x, current_y = queue.popleft()
                size += 1
                left = min(left, current_x)
                right = max(right, current_x)
                top = min(top, current_y)
                bottom = max(bottom, current_y)
                for next_y in range(max(0, current_y - 1), min(image.height, current_y + 2)):
                    for next_x in range(max(0, current_x - 1), min(image.width, current_x + 2)):
                        next_offset = (next_y * image.width) + next_x
                        if not visited[next_offset] and pixels[next_x, next_y] != 0:
                            visited[next_offset] = 1
                            queue.append((next_x, next_y))
            component = (size, left, top, right + 1, bottom + 1)
            if largest is None or component[0] > largest[0]:
                largest = component
    if largest is None:
        raise ValueError("A célula não contém pixels visíveis.")
    _, left, top, right, bottom = largest
    return max(0, left - 3), max(0, top - 3), min(image.width, right + 3), min(image.height, bottom + 3)


def compact_face(cell: Image.Image) -> Image.Image:
    face = cell.crop(visible_bounds(cell))
    face.thumbnail((96, 96), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    canvas.alpha_composite(face, ((100 - face.width) // 2, (100 - face.height) // 2))
    return canvas


def save_face(face: Image.Image, die: str, value: int, root: Path) -> None:
    png_dir = root / "public" / "dice" / "source" / "cosmic-compact" / die
    raw_dir = root / "public" / "dice" / "raw" / "cosmic" / die
    png_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)
    face.save(png_dir / f"{die}s{value}.png", optimize=True)
    (raw_dir / f"{die}s{value}.rgba").write_bytes(face.tobytes())


def extract_grid(
    sheet: Image.Image,
    die: str,
    x_edges: tuple[int, ...],
    y_edges: tuple[int, ...],
    values: list[int],
    root: Path,
) -> list[Image.Image]:
    faces: list[Image.Image] = []
    index = 0
    for row in range(len(y_edges) - 1):
        for column in range(len(x_edges) - 1):
            box = (x_edges[column], y_edges[row], x_edges[column + 1], y_edges[row + 1])
            face = compact_face(sheet.crop(box))
            save_face(face, die, values[index], root)
            faces.append(face)
            index += 1
    return faces


def scaled_edges(edges: tuple[int, ...], source_size: int, reference_size: int) -> tuple[int, ...]:
    return tuple(round(edge * source_size / reference_size) for edge in edges)


def save_preview(d10: list[Image.Image], d12: list[Image.Image], path: Path) -> None:
    preview = Image.new("RGBA", (620, 420), (8, 8, 18, 255))
    for index, face in enumerate(d10):
        preview.alpha_composite(face, (10 + ((index % 5) * 120), 10 + ((index // 5) * 120)))
    for index, face in enumerate(d12):
        preview.alpha_composite(face, (10 + ((index % 6) * 100), 230 + ((index // 6) * 90)))
    path.parent.mkdir(parents=True, exist_ok=True)
    preview.save(path, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("sheet", type=Path)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--preview", type=Path)
    args = parser.parse_args()

    sheet = Image.open(args.sheet).convert("RGBA")
    source_dir = args.root / "source-art"
    source_dir.mkdir(parents=True, exist_ok=True)
    saved_source = source_dir / "cosmic-d10-d12.png"
    if args.sheet.resolve() != saved_source.resolve():
        shutil.copy2(args.sheet, saved_source)

    d10_x = scaled_edges(D10_X, sheet.width, 1640)
    d10_y = scaled_edges(D10_Y, sheet.height, 920)
    d12_x = scaled_edges(D12_X, sheet.width, 1640)
    d12_y = scaled_edges(D12_Y, sheet.height, 920)
    d10 = extract_grid(sheet, "d10", d10_x, d10_y, [10, 1, 2, 3, 4, 5, 6, 7, 8, 9], args.root)
    d12 = extract_grid(sheet, "d12", d12_x, d12_y, list(range(1, 13)), args.root)
    if args.preview:
        save_preview(d10, d12, args.preview)
    print("Extraídas 10 faces de D10 e 12 faces de D12 em PNG/RGBA 100x100.")


if __name__ == "__main__":
    main()
