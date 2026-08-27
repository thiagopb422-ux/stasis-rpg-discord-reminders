"""Import and normalize a complete custom dice set without cropping its artwork."""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

from PIL import Image, ImageDraw


EXPECTED = {"d4": 4, "d6": 6, "d8": 8, "d10": 10, "d12": 12, "d20": 20}
FACE_MAX_SIZE = 84
SOURCE_PATTERN = re.compile(r"^d(20|12|10|8|6|4)(\d{2})\.png$", re.IGNORECASE)


def normalize_face(source: Image.Image) -> Image.Image:
    face = source.convert("RGBA")
    # Keep the complete source canvas: several Redpill faces contain smoke,
    # accessories or unusually wide geometry that must not be cropped away.
    face.thumbnail((FACE_MAX_SIZE, FACE_MAX_SIZE), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    canvas.alpha_composite(face, ((100 - face.width) // 2, (100 - face.height) // 2))
    return canvas


def parse_source(path: Path) -> tuple[str, int]:
    match = SOURCE_PATTERN.fullmatch(path.name)
    if not match:
        raise ValueError(f"Nome Redpill fora do padrão: {path.name}")
    die = f"d{match.group(1)}"
    face = int(match.group(2))
    if face < 1 or face > EXPECTED[die]:
        raise ValueError(f"Face inválida em {path.name}: {die} não possui o valor {face}.")
    return die, face


def save_face(face: Image.Image, die: str, value: int, root: Path, style: str) -> None:
    png_dir = root / "public" / "dice" / "source" / f"{style}-compact" / die
    raw_dir = root / "public" / "dice" / "raw" / style / die
    png_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)
    face.save(png_dir / f"{die}s{value}.png", optimize=True)
    (raw_dir / f"{die}s{value}.rgba").write_bytes(face.tobytes())


def save_preview(faces: dict[tuple[str, int], Image.Image], path: Path, style: str) -> None:
    columns = 10
    cell_width = 112
    cell_height = 126
    rows = sum((count + columns - 1) // columns for count in EXPECTED.values())
    backgrounds = {
        "redpill": (12, 5, 7, 255),
        "eniripsa": (13, 8, 20, 255),
        "begins": (6, 10, 17, 255),
    }
    preview = Image.new("RGBA", (columns * cell_width, rows * cell_height), backgrounds.get(style, (8, 8, 14, 255)))
    draw = ImageDraw.Draw(preview)
    row = 0
    for die, count in EXPECTED.items():
        for index in range(count):
            column = index % columns
            if index and column == 0:
                row += 1
            value = index + 1
            x = column * cell_width + 6
            y = row * cell_height + 20
            preview.alpha_composite(faces[(die, value)], (x, y))
            draw.text((x + 2, row * cell_height + 4), f"{die.upper()} · {value}", fill=(255, 224, 205, 255))
        row += 1
    path.parent.mkdir(parents=True, exist_ok=True)
    preview.save(path, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--style", default="redpill")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--preview", type=Path)
    args = parser.parse_args()
    style = args.style.strip().lower()
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,31}", style):
        raise ValueError("O identificador visual deve usar apenas letras minúsculas, números ou hífen.")

    source_paths = sorted(args.source.glob("*.png"))
    parsed: dict[tuple[str, int], Path] = {}
    for path in source_paths:
        key = parse_source(path)
        if key in parsed:
            raise ValueError(f"Face Redpill duplicada: {key[0]}={key[1]}.")
        parsed[key] = path

    expected_keys = {(die, value) for die, count in EXPECTED.items() for value in range(1, count + 1)}
    missing = sorted(expected_keys - set(parsed))
    if missing or len(parsed) != len(expected_keys):
        raise ValueError(f"O conjunto Redpill precisa de 60 faces. Ausentes: {missing}")

    archive = args.root / "source-art" / style
    archive.mkdir(parents=True, exist_ok=True)
    faces: dict[tuple[str, int], Image.Image] = {}
    for (die, value), path in parsed.items():
        archived = archive / path.name
        if path.resolve() != archived.resolve():
            shutil.copy2(path, archived)
        face = normalize_face(Image.open(path))
        save_face(face, die, value, args.root, style)
        faces[(die, value)] = face

    if args.preview:
        save_preview(faces, args.preview, style)
    print(f"Importadas 60 faces {style} em PNG/RGBA 100x100, sem corte e com proporção preservada.")


if __name__ == "__main__":
    main()
