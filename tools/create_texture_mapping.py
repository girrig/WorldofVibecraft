#!/usr/bin/env python3
"""
Create texture mapping JSON from northshire_chunks.json unique textures.
Maps original BLP paths to extracted WebP filenames.
"""

import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
TERRAIN_DIR = SCRIPT_DIR.parent / "client" / "public" / "assets" / "terrain"
OUTPUT_FILE = TERRAIN_DIR / "texture_mapping.json"


def path_to_webp_name(tex_path):
    """Convert BLP path to WebP filename."""
    parts = tex_path.replace("\\", "/").split("/")
    if len(parts) >= 2:
        folder = parts[-2]
        filename = Path(parts[-1]).stem
        return f"{folder}_{filename}.webp"
    else:
        return f"{Path(tex_path).stem}.webp"


def main():
    # Load chunk data
    with open(TERRAIN_DIR / "northshire_chunks.json", "r") as f:
        chunk_data = json.load(f)

    # Create mapping
    mapping = {}
    for tex_path in chunk_data["uniqueTextures"]:
        webp_name = path_to_webp_name(tex_path)
        mapping[tex_path] = webp_name

    # Write mapping
    with open(OUTPUT_FILE, "w") as f:
        json.dump(mapping, f, indent=2)

    print(f"Created texture mapping: {OUTPUT_FILE}")
    print(f"  {len(mapping)} textures mapped")


if __name__ == "__main__":
    main()
