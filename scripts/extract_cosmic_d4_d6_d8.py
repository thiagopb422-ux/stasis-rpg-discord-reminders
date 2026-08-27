"""Extract the Stasis Cosmic D4, D6 and D8 faces from their transparent sheet."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from PIL import Image

from extract_cosmic_d10_d12 import DICE_SHEET_HEIGHT, DICE_SHEET_WIDTH, extract_grid, scaled_edges


# Exact transparent-gap cuts from the original 1672 x 941 sheet. The former
# estimated grid clipped the left side of D6 faces 4-6 and the later D8 faces.
D4_X = (0, 472, 835, 1198, 1672)
D4_Y = (0, 312)
D6_X = (0, 300, 570, 834, 1099, 1369, 1672)
D6_Y = (312, 598)
D8_X = (0, 224, 432, 636, 837, 1041, 1245, 1450, 1672)
D8_Y = (598, 941)


def save_preview(groups: list[list[Image.Image]], path: Path) -> None:
    preview = Image.new("RGBA", (820, 360), (8, 8, 18, 255))
    for index, face in enumerate(groups[0]):
        preview.alpha_composite(face, (80 + (index * 180), 10))
    for index, face in enumerate(groups[1]):
        preview.alpha_composite(face, (50 + (index * 130), 130))
    for index, face in enumerate(groups[2]):
        preview.alpha_composite(face, (10 + (index * 100), 250))
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
    saved_source = source_dir / "cosmic-d4-d6-d8.png"
    if args.sheet.resolve() != saved_source.resolve():
        shutil.copy2(args.sheet, saved_source)

    specs = [
        ("d4", D4_X, D4_Y, list(range(1, 5))),
        ("d6", D6_X, D6_Y, list(range(1, 7))),
        ("d8", D8_X, D8_Y, list(range(1, 9))),
    ]
    groups = []
    for die, x_edges, y_edges, values in specs:
        groups.append(extract_grid(
            sheet,
            die,
            scaled_edges(x_edges, sheet.width, DICE_SHEET_WIDTH),
            scaled_edges(y_edges, sheet.height, DICE_SHEET_HEIGHT),
            values,
            args.root,
        ))
    if args.preview:
        save_preview(groups, args.preview)
    print("Extraídas 4 faces de D4, 6 faces de D6 e 8 faces de D8 em PNG/RGBA 100x100.")


if __name__ == "__main__":
    main()
