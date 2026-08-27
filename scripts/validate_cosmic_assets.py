"""Validate size, transparency, safe margins and raw derivatives of custom dice."""

from __future__ import annotations

from pathlib import Path

from PIL import Image


EXPECTED = {"d4": 4, "d6": 6, "d8": 8, "d10": 10, "d12": 12, "d20": 20}
STYLES = ("cosmic", "redpill")
MINIMUM_MARGIN = 8


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    validated = 0
    for style in STYLES:
        png_root = root / "public" / "dice" / "source" / f"{style}-compact"
        raw_root = root / "public" / "dice" / "raw" / style
        for die, count in EXPECTED.items():
            for value in range(1, count + 1):
                png_path = png_root / die / f"{die}s{value}.png"
                raw_path = raw_root / die / f"{die}s{value}.rgba"
                image = Image.open(png_path).convert("RGBA")
                if image.size != (100, 100):
                    raise ValueError(f"{png_path} não possui 100x100.")
                bounds = image.getchannel("A").point(lambda alpha: 255 if alpha > 12 else 0).getbbox()
                if bounds is None:
                    raise ValueError(f"{png_path} está transparente por completo.")
                margins = (bounds[0], bounds[1], 100 - bounds[2], 100 - bounds[3])
                if min(margins) < MINIMUM_MARGIN:
                    raise ValueError(f"{png_path} possui margem insegura {margins}.")
                if raw_path.stat().st_size != 40_000:
                    raise ValueError(f"{raw_path} não possui 40.000 bytes RGBA.")
                validated += 1
    print(f"Validadas {validated} faces personalizadas com margem mínima de {MINIMUM_MARGIN}px.")


if __name__ == "__main__":
    main()
