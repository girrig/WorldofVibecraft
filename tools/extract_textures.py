#!/usr/bin/env python3
"""
Extract terrain textures from northshire_chunks.json to WebP format.

Reads the unique texture list and extracts each BLP from MPQ archives.
"""

import json
import sys
from pathlib import Path
from PIL import Image
import io

# Import from extract_terrain.py
SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

from extract_terrain import (
    StormLib, MPQArchivePool, STORMLIB_DLL, MPQ_LOAD_ORDER
)

DEFAULT_DATA_DIR = r"C:\Program Files\Ascension Launcher\resources\epoch_live\Data"
DEFAULT_TERRAIN_DIR = str(SCRIPT_DIR.parent / "client" / "public" / "assets" / "terrain")
DEFAULT_OUTPUT_DIR = str(SCRIPT_DIR.parent / "client" / "public" / "assets" / "terrain" / "textures")


def main():
    data_dir = Path(DEFAULT_DATA_DIR)
    terrain_dir = Path(DEFAULT_TERRAIN_DIR)
    output_dir = Path(DEFAULT_OUTPUT_DIR)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Reading chunk data from: {terrain_dir / 'northshire_chunks.json'}")

    # Load chunk data to get unique textures
    with open(terrain_dir / "northshire_chunks.json", "r") as f:
        chunk_data = json.load(f)

    unique_textures = chunk_data["uniqueTextures"]
    print(f"Found {len(unique_textures)} unique textures to extract")

    # Open MPQ archives
    storm = StormLib(STORMLIB_DLL)
    archive_pool = MPQArchivePool(storm, data_dir, MPQ_LOAD_ORDER)

    print(f"\n== Extracting Textures ==")

    extracted = 0
    failed = []

    for tex_path in unique_textures:
        # Convert path for MPQ (backslashes)
        mpq_path = tex_path.replace("/", "\\")

        # Try multiple path formats
        paths_to_try = [
            mpq_path,
            f"TEXTURES\\{mpq_path}",
        ]

        blp_data = None
        successful_path = None

        for try_path in paths_to_try:
            blp_data = archive_pool.read_file(try_path)
            if blp_data:
                successful_path = try_path
                break

        if not blp_data:
            print(f"  [FAIL] Not found: {tex_path}")
            failed.append(tex_path)
            continue

        # Convert BLP to image
        try:
            img = Image.open(io.BytesIO(blp_data)).convert("RGB")

            # Generate output filename from texture path
            # tileset/elwynn/grass.blp -> elwynn_grass.webp
            parts = tex_path.replace("\\", "/").split("/")
            if len(parts) >= 2:
                # Use last two parts: folder + filename
                folder = parts[-2]
                filename = Path(parts[-1]).stem
                output_name = f"{folder}_{filename}.webp"
            else:
                # Fallback: just use filename
                output_name = f"{Path(tex_path).stem}.webp"

            output_path = output_dir / output_name

            # Save as WebP with good quality
            img.save(str(output_path), "WEBP", quality=90, method=6)

            print(f"  [OK] {tex_path}")
            print(f"       -> {output_name} ({img.width}x{img.height})")
            extracted += 1

        except Exception as e:
            print(f"  [ERROR] Failed to decode {tex_path}: {e}")
            failed.append(tex_path)

    archive_pool.close_all()

    print(f"\n== Summary ==")
    print(f"  Extracted: {extracted}/{len(unique_textures)}")
    if failed:
        print(f"  Failed: {len(failed)}")
        for f in failed:
            print(f"    - {f}")
    print(f"  Output: {output_dir}")


if __name__ == "__main__":
    main()
