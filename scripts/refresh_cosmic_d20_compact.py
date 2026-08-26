"""Rebuild compact Cosmic D20 faces with the shared safe margin."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from extract_cosmic_d10_d12 import compact_face, save_face


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    source_dir = root / "public" / "dice" / "source" / "cosmic" / "d20"
    faces = sorted(source_dir.glob("d20s*.png"), key=lambda path: int(path.stem.removeprefix("d20s")))
    if len(faces) != 20:
        raise ValueError(f"Esperadas 20 faces Cósmicas de D20, mas foram encontradas {len(faces)}.")
    for source in faces:
        value = int(source.stem.removeprefix("d20s"))
        save_face(compact_face(Image.open(source).convert("RGBA")), "d20", value, root)
    print("Regeneradas 20 faces de D20 com margem segura em PNG/RGBA 100x100.")


if __name__ == "__main__":
    main()
