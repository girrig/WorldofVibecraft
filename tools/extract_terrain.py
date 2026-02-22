#!/usr/bin/env python3
"""
Extract WoW 3.3.5a ADT terrain data from MPQ archives.

Outputs heightmap binary + baked terrain textures for Northshire Valley.
Reuses StormLib wrapper pattern from extract_model.py.

Usage:
    python extract_terrain.py
    python extract_terrain.py --center-x 32 --center-y 48 --radius 1
    python extract_terrain.py --debug
"""

import argparse
import ctypes
import struct
import sys
import json
import numpy as np
from pathlib import Path
from PIL import Image
import io

SCRIPT_DIR = Path(__file__).parent
STORMLIB_DLL = SCRIPT_DIR / "stormlib" / "x64" / "StormLib.dll"

DEFAULT_DATA_DIR = r"C:\Program Files\Ascension Launcher\resources\epoch_live\Data"
DEFAULT_OUTPUT_DIR = str(SCRIPT_DIR.parent / "client" / "public" / "assets" / "terrain")

# MPQ archives in priority order (lowest to highest)
MPQ_LOAD_ORDER = [
    "common.MPQ",
    "common-2.MPQ",
    "expansion.MPQ",
    "lichking.MPQ",
    "patch.MPQ",
    "patch-2.MPQ",
    "patch-3.MPQ",
    "patch-A.MPQ",
    "patch-B.MPQ",
    "patch-C.MPQ",
    "patch-Y.MPQ",
    "patch-Z.MPQ",
]

# ── StormLib ctypes wrapper ────────────────────────────────────────────────

class StormLib:
    def __init__(self, dll_path):
        self.lib = ctypes.WinDLL(str(dll_path))
        self._setup_functions()

    def _setup_functions(self):
        self.lib.SFileOpenArchive.argtypes = [
            ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_uint,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        self.lib.SFileOpenArchive.restype = ctypes.c_bool

        self.lib.SFileCloseArchive.argtypes = [ctypes.c_void_p]
        self.lib.SFileCloseArchive.restype = ctypes.c_bool

        self.lib.SFileHasFile.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        self.lib.SFileHasFile.restype = ctypes.c_bool

        self.lib.SFileOpenFileEx.argtypes = [
            ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        self.lib.SFileOpenFileEx.restype = ctypes.c_bool

        self.lib.SFileGetFileSize.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint),
        ]
        self.lib.SFileGetFileSize.restype = ctypes.c_uint

        self.lib.SFileReadFile.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint,
            ctypes.POINTER(ctypes.c_uint), ctypes.c_void_p,
        ]
        self.lib.SFileReadFile.restype = ctypes.c_bool

        self.lib.SFileCloseFile.argtypes = [ctypes.c_void_p]
        self.lib.SFileCloseFile.restype = ctypes.c_bool

    def open_archive(self, path):
        handle = ctypes.c_void_p()
        ok = self.lib.SFileOpenArchive(str(path), 0, 0x100, ctypes.byref(handle))
        return handle if ok else None

    def close_archive(self, handle):
        self.lib.SFileCloseArchive(handle)

    def has_file(self, handle, filename):
        return self.lib.SFileHasFile(handle, filename.encode("ascii"))

    def read_file(self, handle, filename):
        file_handle = ctypes.c_void_p()
        ok = self.lib.SFileOpenFileEx(
            handle, filename.encode("ascii"), 0, ctypes.byref(file_handle)
        )
        if not ok:
            return None
        high = ctypes.c_uint(0)
        size = self.lib.SFileGetFileSize(file_handle, ctypes.byref(high))
        if size == 0xFFFFFFFF:
            self.lib.SFileCloseFile(file_handle)
            return None
        buf = ctypes.create_string_buffer(size)
        read = ctypes.c_uint(0)
        ok = self.lib.SFileReadFile(file_handle, buf, size, ctypes.byref(read), None)
        self.lib.SFileCloseFile(file_handle)
        if not ok and read.value == 0:
            return None
        return buf.raw[: read.value]


def extract_from_mpq(storm, data_dir, filepath):
    """Try to extract a file from MPQ archives (highest priority first)."""
    for mpq_name in reversed(MPQ_LOAD_ORDER):
        mpq_path = data_dir / mpq_name
        if not mpq_path.exists():
            continue
        handle = storm.open_archive(mpq_path)
        if handle is None:
            continue
        try:
            if storm.has_file(handle, filepath):
                data = storm.read_file(handle, filepath)
                if data:
                    return data
        finally:
            storm.close_archive(handle)
    return None


# ── IFF Chunk Scanner ──────────────────────────────────────────────────────

def scan_chunks(data, start=0, end=None):
    """Yield (magic, data_offset, size) for IFF-style chunks.
    WoW stores chunk IDs in reversed byte order (little-endian uint32),
    so 'MVER' appears as b'REVM' in the file. We reverse to human-readable."""
    if end is None:
        end = len(data)
    pos = start
    while pos + 8 <= end:
        magic = data[pos:pos + 4][::-1]  # reverse to human-readable
        size = struct.unpack_from("<I", data, pos + 4)[0]
        yield magic, pos + 8, size
        pos += 8 + size


# ── WDT Parser ────────────────────────────────────────────────────────────

def parse_wdt(data):
    """Parse WDT file. Return (mphd_flags, set of (tx, ty) tiles that exist)."""
    mphd_flags = 0
    existing = set()

    for magic, data_ofs, size in scan_chunks(data):
        if magic == b"MPHD":
            mphd_flags = struct.unpack_from("<I", data, data_ofs)[0]
        elif magic == b"MAIN":
            # 64x64 entries, 8 bytes each: (flags u32, asyncId u32)
            for ty in range(64):
                for tx in range(64):
                    entry_ofs = data_ofs + (ty * 64 + tx) * 8
                    flags = struct.unpack_from("<I", data, entry_ofs)[0]
                    if flags & 1:
                        existing.add((tx, ty))

    return mphd_flags, existing


# ── ADT Parser ────────────────────────────────────────────────────────────

def parse_adt(data):
    """Parse ADT file. Return (mtex_list, mcnk_list)."""
    mtex_list = []
    mcnk_list = []

    for magic, data_ofs, size in scan_chunks(data):
        if magic == b"MTEX":
            # Concatenated null-terminated texture filenames
            tex_data = data[data_ofs:data_ofs + size]
            names = tex_data.split(b"\x00")
            mtex_list = [n.decode("ascii", errors="replace") for n in names if n]

        elif magic == b"MCNK":
            mcnk = parse_mcnk(data, data_ofs, size)
            if mcnk:
                mcnk_list.append(mcnk)

    return mtex_list, mcnk_list


def parse_mcnk(data, data_ofs, size):
    """Parse a single MCNK chunk. Returns dict with heights, layers, alpha."""
    if size < 128:
        return None

    # ── MCNK header (128 bytes) ──
    flags    = struct.unpack_from("<I", data, data_ofs + 0x00)[0]
    indexX   = struct.unpack_from("<I", data, data_ofs + 0x04)[0]
    indexY   = struct.unpack_from("<I", data, data_ofs + 0x08)[0]
    nLayers  = struct.unpack_from("<I", data, data_ofs + 0x0C)[0]
    ofsHeight = struct.unpack_from("<I", data, data_ofs + 0x14)[0]
    ofsLayer = struct.unpack_from("<I", data, data_ofs + 0x1C)[0]
    ofsAlpha = struct.unpack_from("<I", data, data_ofs + 0x24)[0]
    sizeAlpha = struct.unpack_from("<I", data, data_ofs + 0x28)[0]
    areaId   = struct.unpack_from("<I", data, data_ofs + 0x34)[0]

    # Position at offset 0x68: C3Vector (x, y, z)
    # In ADT: pos[0] = WoW X (N-S), pos[1] = WoW Y (E-W), pos[2] = height
    pos = struct.unpack_from("<3f", data, data_ofs + 0x68)

    # MCNK sub-offsets are relative to the chunk START (including 8-byte preamble),
    # but data_ofs is already past the preamble, so subtract 8.
    chunk_base = data_ofs - 8

    # ── MCVT: Height map (145 floats) ──
    mcvt_ofs = chunk_base + ofsHeight
    outer_heights = None

    if mcvt_ofs + 8 <= len(data):
        mcvt_magic = data[mcvt_ofs:mcvt_ofs + 4][::-1]
        if mcvt_magic == b"MCVT":
            mcvt_data_ofs = mcvt_ofs + 8
            if mcvt_data_ofs + 145 * 4 <= len(data):
                heights_145 = struct.unpack_from("<145f", data, mcvt_data_ofs)
                # Extract 9x9 outer grid (skip inner 8x8 vertices)
                outer_heights = []
                for row in range(9):
                    start = row * 17  # 9 outer + 8 inner = 17 per row pair
                    outer_heights.extend(heights_145[start:start + 9])

    # ── MCLY: Texture layers ──
    layers = []
    if nLayers > 0 and ofsLayer > 0:
        mcly_ofs = chunk_base + ofsLayer
        if mcly_ofs + 4 <= len(data) and data[mcly_ofs:mcly_ofs + 4][::-1] == b"MCLY":
            mcly_data_ofs = mcly_ofs + 8
            for i in range(min(nLayers, 4)):  # max 4 layers
                lo = mcly_data_ofs + i * 16
                if lo + 16 > len(data):
                    break
                tex_id, lflags, alpha_ofs, effect_id = struct.unpack_from(
                    "<IIIi", data, lo
                )
                layers.append({
                    "textureId": tex_id,
                    "flags": lflags,
                    "alphaOffset": alpha_ofs,
                    "effectId": effect_id,
                })

    # ── MCAL: Alpha map raw data ──
    alpha_raw = None
    if sizeAlpha > 0 and ofsAlpha > 0:
        mcal_ofs = chunk_base + ofsAlpha
        if mcal_ofs + 4 <= len(data) and data[mcal_ofs:mcal_ofs + 4][::-1] == b"MCAL":
            mcal_data_ofs = mcal_ofs + 8
            mcal_size = struct.unpack_from("<I", data, mcal_ofs + 4)[0]
            alpha_raw = data[mcal_data_ofs:mcal_data_ofs + mcal_size]

    return {
        "indexX": indexX,
        "indexY": indexY,
        "flags": flags,
        "position": pos,
        "areaId": areaId,
        "nLayers": nLayers,
        "outerHeights": outer_heights,  # 81 floats (9x9) or None
        "layers": layers,
        "alphaRaw": alpha_raw,
    }


# ── Alpha Map Decompression ───────────────────────────────────────────────

def read_alpha_map(alpha_raw, offset, layer_flags, big_alpha):
    """Read a 64x64 alpha layer. Returns numpy uint8 array (64,64) or None."""
    if alpha_raw is None:
        return None

    compressed = bool(layer_flags & 0x200)

    if compressed:
        # RLE decompression
        result = bytearray()
        pos = offset
        while len(result) < 4096 and pos < len(alpha_raw):
            info = alpha_raw[pos]
            pos += 1
            count = info & 0x7F
            if info & 0x80:  # fill
                val = alpha_raw[pos] if pos < len(alpha_raw) else 0
                pos += 1
                result.extend([val] * count)
            else:  # copy
                end = min(pos + count, len(alpha_raw))
                result.extend(alpha_raw[pos:end])
                pos = end
        if len(result) < 4096:
            result.extend([0] * (4096 - len(result)))
        return np.frombuffer(bytes(result[:4096]), dtype=np.uint8).reshape(64, 64)

    elif big_alpha:
        # Uncompressed 64x64 = 4096 bytes
        end = offset + 4096
        if end <= len(alpha_raw):
            return np.frombuffer(alpha_raw[offset:end], dtype=np.uint8).reshape(64, 64)

    else:
        # Uncompressed 32x64 (half-byte packed) or 63x64
        # Try 4096 bytes first, fall back to 2048
        end = offset + 4096
        if end <= len(alpha_raw):
            return np.frombuffer(alpha_raw[offset:end], dtype=np.uint8).reshape(64, 64)
        end = offset + 2048
        if end <= len(alpha_raw):
            # 4-bit packed: 2 pixels per byte
            packed = np.frombuffer(alpha_raw[offset:end], dtype=np.uint8)
            low = (packed & 0x0F) * 17   # scale 0-15 to 0-255
            high = (packed >> 4) * 17
            interleaved = np.empty(4096, dtype=np.uint8)
            interleaved[0::2] = low
            interleaved[1::2] = high
            return interleaved.reshape(64, 64)

    return None


# ── Texture Baking ─────────────────────────────────────────────────────────

def bake_tile_texture(chunks_grid, mtex_list, storm, data_dir, mphd_flags,
                      chunk_px=64):
    """
    Bake terrain texture for one ADT tile.
    chunks_grid: 16x16 list-of-lists of MCNK dicts (indexed [row][col]).
    Returns PIL Image of size (chunk_px*16, chunk_px*16).
    """
    tile_size = chunk_px * 16
    tile_img = Image.new("RGBA", (tile_size, tile_size), (80, 140, 60, 255))

    big_alpha = bool(mphd_flags & 0x4)
    texture_cache = {}

    def get_texture(tex_path):
        if tex_path in texture_cache:
            return texture_cache[tex_path]
        try:
            blp_data = extract_from_mpq(storm, data_dir, tex_path)
            if blp_data:
                img = Image.open(io.BytesIO(blp_data)).convert("RGBA")
                # Tile the texture and resize to chunk resolution
                # Terrain textures repeat ~4 times per chunk visually
                repeats = 4
                big_w = img.width * repeats
                big_h = img.height * repeats
                big = Image.new("RGBA", (big_w, big_h))
                for i in range(repeats):
                    for j in range(repeats):
                        big.paste(img, (i * img.width, j * img.height))
                resized = big.resize((chunk_px, chunk_px), Image.LANCZOS)
                texture_cache[tex_path] = resized
                return resized
        except Exception as e:
            print(f"    Warning: texture load failed for {tex_path}: {e}")
        texture_cache[tex_path] = None
        return None

    for row in range(16):
        for col in range(16):
            chunk = chunks_grid[row][col]
            if chunk is None:
                continue

            layers = chunk["layers"]
            if not layers:
                continue

            # Layer 0: opaque base
            tex_idx = layers[0]["textureId"]
            tex_path = mtex_list[tex_idx] if tex_idx < len(mtex_list) else None
            base_tex = get_texture(tex_path) if tex_path else None

            if base_tex:
                chunk_img = base_tex.copy()
            else:
                chunk_img = Image.new("RGBA", (chunk_px, chunk_px), (80, 140, 60, 255))

            # Layers 1+: alpha-blended overlays
            for li in range(1, len(layers)):
                layer = layers[li]
                tex_idx = layer["textureId"]
                tex_path = mtex_list[tex_idx] if tex_idx < len(mtex_list) else None
                if tex_path is None:
                    continue

                overlay = get_texture(tex_path)
                if overlay is None:
                    continue

                # Read alpha map
                alpha_64 = read_alpha_map(
                    chunk["alphaRaw"], layer["alphaOffset"], layer["flags"], big_alpha
                )
                if alpha_64 is None:
                    continue

                # Resize alpha to chunk pixel size
                alpha_img = Image.fromarray(alpha_64).resize(
                    (chunk_px, chunk_px), Image.LANCZOS
                )

                # Alpha-composite
                overlay_copy = overlay.copy()
                overlay_copy.putalpha(alpha_img)
                chunk_img = Image.alpha_composite(chunk_img, overlay_copy)

            # Paste into tile texture
            tile_img.paste(chunk_img, (col * chunk_px, row * chunk_px))

    return tile_img.convert("RGB")


# ── Heightmap Grid ─────────────────────────────────────────────────────────

def build_heightmap_grid(all_tile_data, start_tx, start_ty, num_tx, num_ty):
    """
    Build unified heightmap from all tile data.
    Returns (grid, pos_info) where grid is (gh, gw) float32 array,
    and pos_info has the WoW coordinate mapping.
    """
    # Each tile = 16 chunks * 8 intervals + 1 = 129 verts per axis
    # N tiles sharing edges = N * 128 + 1 per axis
    gw = num_tx * 128 + 1
    gh = num_ty * 128 + 1
    grid = np.zeros((gh, gw), dtype=np.float32)

    # Track position data for coordinate mapping
    all_positions = []

    for (tx, ty), (mtex_list, mcnk_list) in all_tile_data.items():
        tile_col = tx - start_tx  # 0-based tile column
        tile_row = ty - start_ty  # 0-based tile row

        for chunk in mcnk_list:
            if chunk["outerHeights"] is None:
                continue

            cx = chunk["indexX"]
            cy = chunk["indexY"]
            pos = chunk["position"]
            all_positions.append((tx, ty, cx, cy, pos))

            # Base height is position[2] (3rd component = Z/height in ADT)
            # pos[0] = WoW X (north-south), pos[1] = WoW Y (east-west)
            base_height = pos[2]

            for row in range(9):
                for col in range(9):
                    gx = tile_col * 128 + cx * 8 + col
                    gy = tile_row * 128 + cy * 8 + row
                    if 0 <= gx < gw and 0 <= gy < gh:
                        h = base_height + chunk["outerHeights"][row * 9 + col]
                        grid[gy, gx] = h

    # Determine world coordinate mapping from MCNK positions
    # pos = (x_adt, y_adt, z_adt) - need to figure out which is which
    pos_info = analyze_positions(all_positions)

    return grid, pos_info


def analyze_positions(positions):
    """
    Analyze MCNK positions to determine coordinate mapping.
    Returns dict with axis info.
    """
    if not positions:
        return {}

    # Collect position components grouped by tile/chunk indices
    pos_by_index = {}
    for tx, ty, cx, cy, pos in positions:
        pos_by_index[(tx, ty, cx, cy)] = pos

    # Find the ranges of each position component
    p0 = [p[0] for _, _, _, _, p in positions]
    p1 = [p[1] for _, _, _, _, p in positions]
    p2 = [p[2] for _, _, _, _, p in positions]

    info = {
        "pos0_range": (min(p0), max(p0)),
        "pos1_range": (min(p1), max(p1)),
        "pos2_range": (min(p2), max(p2)),
    }

    # The height component has small range (terrain elevation variation)
    # The horizontal components span ~533 yards per tile
    ranges = [
        (max(p0) - min(p0), 0, "pos[0]"),
        (max(p1) - min(p1), 1, "pos[1]"),
        (max(p2) - min(p2), 2, "pos[2]"),
    ]
    ranges.sort(key=lambda x: x[0])

    # Smallest range = height, other two = horizontal
    info["height_index"] = ranges[0][1]
    info["horiz_indices"] = [ranges[1][1], ranges[2][1]]

    print(f"  Position analysis:")
    for r, idx, name in ranges:
        vals = [p0, p1, p2][idx]
        print(f"    {name}: range={r:.1f}, min={min(vals):.1f}, max={max(vals):.1f}")
    print(f"    -> height axis: pos[{info['height_index']}]")

    # Check correlation of pos components with chunk indexX/indexY
    # to determine axis orientation
    sample = positions[:256]  # first tile
    if len(sample) >= 16:
        # Find two chunks in same row (same cy) but different cx
        by_cy = {}
        for tx, ty, cx, cy, pos in sample:
            by_cy.setdefault(cy, []).append((cx, pos))
        for cy, chunks in by_cy.items():
            if len(chunks) >= 2:
                chunks.sort(key=lambda x: x[0])
                c0, p_a = chunks[0]
                c1, p_b = chunks[-1]
                diff = [p_b[i] - p_a[i] for i in range(3)]
                info["cx_increases"] = diff
                print(f"    indexX {c0}->{c1}: dpos = ({diff[0]:.1f}, {diff[1]:.1f}, {diff[2]:.1f})")
                break

        by_cx = {}
        for tx, ty, cx, cy, pos in sample:
            by_cx.setdefault(cx, []).append((cy, pos))
        for cx, chunks in by_cx.items():
            if len(chunks) >= 2:
                chunks.sort(key=lambda x: x[0])
                c0, p_a = chunks[0]
                c1, p_b = chunks[-1]
                diff = [p_b[i] - p_a[i] for i in range(3)]
                info["cy_increases"] = diff
                print(f"    indexY {c0}->{c1}: dpos = ({diff[0]:.1f}, {diff[1]:.1f}, {diff[2]:.1f})")
                break

    return info


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Extract Northshire terrain")
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--center-x", type=int, default=32,
                        help="Center tile X index")
    parser.add_argument("--center-y", type=int, default=48,
                        help="Center tile Y index")
    parser.add_argument("--radius", type=int, default=1,
                        help="Tile radius (1 = 3x3, 2 = 5x5)")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Data dir: {data_dir}")
    print(f"Output dir: {output_dir}")

    storm = StormLib(STORMLIB_DLL)

    # ── Step 1: Parse WDT ──
    print("\n== Reading WDT ==")
    wdt_path = r"World\Maps\Azeroth\Azeroth.wdt"
    wdt_data = extract_from_mpq(storm, data_dir, wdt_path)
    if not wdt_data:
        print(f"ERROR: Could not find {wdt_path}")
        sys.exit(1)

    mphd_flags, existing_tiles = parse_wdt(wdt_data)
    print(f"  MPHD flags: 0x{mphd_flags:08X}")
    print(f"  Big alpha: {bool(mphd_flags & 0x4)}")
    print(f"  Total existing tiles: {len(existing_tiles)}")

    # ── Step 2: Determine tiles to extract ──
    r = args.radius
    cx, cy = args.center_x, args.center_y
    start_tx = cx - r
    start_ty = cy - r
    num_tx = 2 * r + 1
    num_ty = 2 * r + 1

    tiles_to_extract = []
    for ty in range(start_ty, start_ty + num_ty):
        for tx in range(start_tx, start_tx + num_tx):
            if (tx, ty) in existing_tiles:
                tiles_to_extract.append((tx, ty))
            else:
                print(f"  Warning: tile ({tx}, {ty}) does not exist in WDT")

    print(f"  Extracting {len(tiles_to_extract)} tiles: {tiles_to_extract}")

    if not tiles_to_extract:
        print("ERROR: No tiles to extract!")
        sys.exit(1)

    # ── Step 3: Extract all ADT tiles ──
    all_tile_data = {}  # (tx, ty) -> (mtex_list, mcnk_list)

    for tx, ty in tiles_to_extract:
        adt_path = f"World\\Maps\\Azeroth\\Azeroth_{tx}_{ty}.adt"
        print(f"\n== Reading ADT ({tx}, {ty}) ==")
        adt_data = extract_from_mpq(storm, data_dir, adt_path)
        if not adt_data:
            print(f"  ERROR: Could not read {adt_path}")
            continue

        print(f"  File size: {len(adt_data)} bytes")
        mtex_list, mcnk_list = parse_adt(adt_data)
        print(f"  Textures: {len(mtex_list)}")
        print(f"  Chunks: {len(mcnk_list)}")

        if mcnk_list:
            # Print some debug info
            areas = set(c["areaId"] for c in mcnk_list)
            print(f"  Area IDs: {sorted(areas)}")

            if args.debug:
                for i in [0, 1, 16, 255]:
                    if i < len(mcnk_list):
                        c = mcnk_list[i]
                        print(f"    Chunk[{i}]: idx=({c['indexX']},{c['indexY']}), "
                              f"pos=({c['position'][0]:.1f}, {c['position'][1]:.1f}, {c['position'][2]:.1f}), "
                              f"area={c['areaId']}, layers={c['nLayers']}")
                if mtex_list:
                    print(f"  First textures: {mtex_list[:5]}")

        all_tile_data[(tx, ty)] = (mtex_list, mcnk_list)

    # ── Step 4: Build heightmap grid ──
    print(f"\n== Building heightmap grid ==")
    grid, pos_info = build_heightmap_grid(
        all_tile_data, start_tx, start_ty, num_tx, num_ty
    )
    print(f"  Grid size: {grid.shape[1]}x{grid.shape[0]}")
    print(f"  Height range: {grid.min():.1f} to {grid.max():.1f}")

    # Compute the center position in WoW coordinates for the meta file
    # Use the center tile's center chunk position as reference
    center_chunks = []
    center_key = (cx, cy)
    if center_key in all_tile_data:
        _, chunks = all_tile_data[center_key]
        for c in chunks:
            if c["indexX"] == 8 and c["indexY"] == 8:
                center_chunks.append(c)
    if not center_chunks:
        # Fallback: use first chunk of center tile
        if center_key in all_tile_data:
            _, chunks = all_tile_data[center_key]
            if chunks:
                center_chunks.append(chunks[0])

    center_pos = center_chunks[0]["position"] if center_chunks else (0, 0, 0)

    # ── Step 5: Write heightmap binary ──
    heightmap_path = output_dir / "northshire_heightmap.bin"
    grid.tofile(str(heightmap_path))
    print(f"\n== Output ==")
    print(f"  Heightmap: {heightmap_path} ({heightmap_path.stat().st_size} bytes)")

    # ── Step 6: Write metadata ──
    cell_size = 33.33333 / 8  # yards per cell

    meta = {
        "gridWidth": int(grid.shape[1]),
        "gridHeight": int(grid.shape[0]),
        "cellSize": cell_size,
        "tiles": {
            "startX": start_tx,
            "startY": start_ty,
            "countX": num_tx,
            "countY": num_ty,
        },
        "centerTile": {"x": cx, "y": cy},
        "centerPosition": {
            "pos0": float(center_pos[0]),
            "pos1": float(center_pos[1]),
            "pos2": float(center_pos[2]),
        },
        "positionAnalysis": {
            k: v for k, v in pos_info.items()
            if k in ("pos0_range", "pos1_range", "pos2_range",
                     "height_index", "horiz_indices")
        },
        "worldExtent": num_tx * 533.33333,
        "heightRange": {"min": float(grid.min()), "max": float(grid.max())},
    }

    meta_path = output_dir / "northshire_meta.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"  Meta: {meta_path}")

    # ── Step 7: Bake terrain textures ──
    print(f"\n== Baking terrain textures ==")
    tex_idx = 0
    for ty in range(start_ty, start_ty + num_ty):
        for tx in range(start_tx, start_tx + num_tx):
            if (tx, ty) not in all_tile_data:
                tex_idx += 1
                continue

            print(f"  Baking texture for tile ({tx}, {ty})...")
            mtex_list, mcnk_list = all_tile_data[(tx, ty)]

            # Organize chunks into 16x16 grid
            chunks_grid = [[None] * 16 for _ in range(16)]
            for chunk in mcnk_list:
                row = chunk["indexY"]
                col = chunk["indexX"]
                if 0 <= row < 16 and 0 <= col < 16:
                    chunks_grid[row][col] = chunk

            tile_img = bake_tile_texture(
                chunks_grid, mtex_list, storm, data_dir, mphd_flags
            )

            tex_path = output_dir / f"northshire_tex_{tex_idx}.png"
            tile_img.save(str(tex_path), "PNG")
            print(f"    -> {tex_path} ({tile_img.size[0]}x{tile_img.size[1]})")
            tex_idx += 1

    print(f"\n== Done! ==")
    print(f"  {len(tiles_to_extract)} tiles extracted")
    print(f"  Heightmap: {grid.shape[1]}x{grid.shape[0]} ({cell_size:.2f} yards/cell)")
    print(f"  Height range: {grid.min():.1f} to {grid.max():.1f}")
    print(f"  Output directory: {output_dir}")


if __name__ == "__main__":
    main()
