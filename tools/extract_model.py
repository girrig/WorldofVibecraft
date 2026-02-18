#!/usr/bin/env python3
"""
Extract WoW 3.3.5a models from MPQ archives to glTF (.glb) format.

Usage:
    python extract_model.py --data-dir "C:\Path\To\Data" --model "Character\Human\Male\HumanMale" --output "../client/assets/models/human_male.glb"
"""

import argparse
import ctypes
import ctypes.wintypes
import struct
import os
import sys
import numpy as np
from pathlib import Path
from PIL import Image
import io
import pygltflib

SCRIPT_DIR = Path(__file__).parent
STORMLIB_DLL = SCRIPT_DIR / "stormlib" / "x64" / "StormLib.dll"

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

# ── StormLib ctypes wrapper ──────────────────────────────────────────────────

class StormLib:
    def __init__(self, dll_path):
        self.lib = ctypes.WinDLL(str(dll_path))
        self._setup_functions()

    def _setup_functions(self):
        # SFileOpenArchive (Unicode build uses wchar_t*)
        self.lib.SFileOpenArchive.argtypes = [
            ctypes.c_wchar_p,  # szMpqName (wide string for Unicode DLL)
            ctypes.c_uint,     # dwPriority
            ctypes.c_uint,     # dwFlags
            ctypes.POINTER(ctypes.c_void_p),  # phMpq
        ]
        self.lib.SFileOpenArchive.restype = ctypes.c_bool

        # SFileCloseArchive
        self.lib.SFileCloseArchive.argtypes = [ctypes.c_void_p]
        self.lib.SFileCloseArchive.restype = ctypes.c_bool

        # SFileHasFile
        self.lib.SFileHasFile.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        self.lib.SFileHasFile.restype = ctypes.c_bool

        # SFileOpenFileEx
        self.lib.SFileOpenFileEx.argtypes = [
            ctypes.c_void_p,  # hMpq
            ctypes.c_char_p,  # szFileName
            ctypes.c_uint,    # dwSearchScope
            ctypes.POINTER(ctypes.c_void_p),  # phFile
        ]
        self.lib.SFileOpenFileEx.restype = ctypes.c_bool

        # SFileGetFileSize
        self.lib.SFileGetFileSize.argtypes = [
            ctypes.c_void_p,  # hFile
            ctypes.POINTER(ctypes.c_uint),  # pdwFileSizeHigh
        ]
        self.lib.SFileGetFileSize.restype = ctypes.c_uint

        # SFileReadFile
        self.lib.SFileReadFile.argtypes = [
            ctypes.c_void_p,  # hFile
            ctypes.c_void_p,  # lpBuffer
            ctypes.c_uint,    # dwToRead
            ctypes.POINTER(ctypes.c_uint),  # pdwRead
            ctypes.c_void_p,  # lpOverlapped
        ]
        self.lib.SFileReadFile.restype = ctypes.c_bool

        # SFileCloseFile
        self.lib.SFileCloseFile.argtypes = [ctypes.c_void_p]
        self.lib.SFileCloseFile.restype = ctypes.c_bool

    def open_archive(self, path):
        handle = ctypes.c_void_p()
        # Use wide string path, 0x100 = MPQ_OPEN_READ_ONLY
        ok = self.lib.SFileOpenArchive(str(path), 0, 0x100, ctypes.byref(handle))
        if not ok:
            return None
        return handle

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


# ── MPQ file extraction ─────────────────────────────────────────────────────

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
                    print(f"  Found {filepath} in {mpq_name}")
                    return data
        finally:
            storm.close_archive(handle)
    return None


# ── M2 parser ───────────────────────────────────────────────────────────────

def read_m2array(data, offset):
    """Read an M2Array (count, offset) from data at the given offset."""
    count, ofs = struct.unpack_from("<II", data, offset)
    return count, ofs


def parse_m2_vertices(data, header_offset=0x03C):
    """Parse M2 vertex data. Returns list of vertex dicts."""
    count, offset = read_m2array(data, header_offset)
    vertices = []
    fmt = "<3f4B4B3f2f2f"  # 48 bytes per vertex
    for i in range(count):
        v = struct.unpack_from(fmt, data, offset + i * 48)
        vertices.append({
            "position": (v[0], v[1], v[2]),
            "bone_weights": v[3:7],
            "bone_indices": v[7:11],
            "normal": (v[11], v[12], v[13]),
            "uv0": (v[14], v[15]),
            "uv1": (v[16], v[17]),
        })
    return vertices


def parse_m2_textures(data, header_offset=0x050):
    """Parse M2 texture definitions. Returns list of texture info."""
    count, offset = read_m2array(data, header_offset)
    textures = []
    for i in range(count):
        tex_type, flags, name_count, name_offset = struct.unpack_from(
            "<IIII", data, offset + i * 16
        )
        filename = ""
        if tex_type == 0 and name_count > 0:
            filename = data[name_offset : name_offset + name_count].rstrip(b"\x00").decode("ascii", errors="replace")
        textures.append({
            "type": tex_type,
            "flags": flags,
            "filename": filename,
        })
    return textures


def parse_m2_texture_combos(data, header_offset=0x080):
    """Parse texture lookup table (array of uint16)."""
    count, offset = read_m2array(data, header_offset)
    if count == 0:
        return []
    return list(struct.unpack_from(f"<{count}H", data, offset))


# ── .skin parser ─────────────────────────────────────────────────────────────

def parse_skin(data):
    """Parse a .skin file and return vertices, indices, submeshes, batches."""
    magic = data[0:4]
    if magic != b"SKIN":
        raise ValueError(f"Invalid .skin magic: {magic}")

    vert_count, vert_offset = read_m2array(data, 0x04)
    idx_count, idx_offset = read_m2array(data, 0x0C)
    # skip bones at 0x14
    sub_count, sub_offset = read_m2array(data, 0x1C)
    batch_count, batch_offset = read_m2array(data, 0x24)

    # Local-to-global vertex index lookup
    local_to_global = list(struct.unpack_from(f"<{vert_count}H", data, vert_offset))

    # Triangle indices (into local vertex list)
    indices = list(struct.unpack_from(f"<{idx_count}H", data, idx_offset))

    # Submeshes
    submeshes = []
    for i in range(sub_count):
        s = struct.unpack_from("<10H3f3ff", data, sub_offset + i * 48)
        submeshes.append({
            "id": s[0],
            "level": s[1],
            "vertex_start": s[2],
            "vertex_count": s[3],
            "index_start": s[4],
            "index_count": s[5],
            "bone_count": s[6],
            "bone_combo_index": s[7],
            "bone_influences": s[8],
            "center_bone_index": s[9],
        })

    # Batches
    batches = []
    for i in range(batch_count):
        b = struct.unpack_from("<Bb10H", data, batch_offset + i * 24)
        batches.append({
            "flags": b[0],
            "priority_plane": b[1],
            "shader_id": b[2],
            "skin_section_index": b[3],
            "geoset_index": b[4],
            "color_index": b[5],
            "material_index": b[6],
            "material_layer": b[7],
            "texture_count": b[8],
            "texture_combo_index": b[9],
        })

    return local_to_global, indices, submeshes, batches


# ── BLP texture handling ─────────────────────────────────────────────────────

def blp_to_png_bytes(blp_data):
    """Convert BLP texture data to PNG bytes using Pillow."""
    try:
        img = Image.open(io.BytesIO(blp_data))
        img = img.convert("RGBA")
        print(f"  Texture: {img.width}x{img.height}")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        print(f"  Warning: Failed to convert BLP texture: {e}")
        return None


# ── glTF construction ────────────────────────────────────────────────────────

def build_glb(m2_vertices, local_to_global, indices, submeshes, texture_pngs=None, geoset_filter=None):
    """
    Build a GLB file from parsed M2 + skin data.
    geoset_filter: set of submesh IDs to include. If None, includes all.
    Splits mesh into body (skin texture) and hair (solid color) primitives.
    Returns bytes of the .glb file.
    """
    # Shared vertex buffer
    all_positions = []
    all_normals = []
    all_uvs = []

    # Separate index lists: body vs hair
    body_indices = []
    hair_indices = []

    global_to_output = {}
    output_idx = 0

    for sub in submeshes:
        if sub["level"] != 0:
            continue
        if geoset_filter is not None and sub["id"] not in geoset_filter:
            continue

        # Hairstyles are group 0 IDs 1-99
        is_hair = 1 <= sub["id"] <= 99
        target = hair_indices if is_hair else body_indices

        for i in range(sub["index_start"], sub["index_start"] + sub["index_count"]):
            local_idx = indices[i]
            global_idx = local_to_global[local_idx]
            if global_idx not in global_to_output:
                v = m2_vertices[global_idx]
                pos = v["position"]
                norm = v["normal"]
                all_positions.append([pos[0], pos[2], -pos[1]])
                all_normals.append([norm[0], norm[2], -norm[1]])
                all_uvs.append([v["uv0"][0], v["uv0"][1]])
                global_to_output[global_idx] = output_idx
                output_idx += 1
            target.append(global_to_output[global_idx])

    positions = np.array(all_positions, dtype=np.float32)
    normals = np.array(all_normals, dtype=np.float32)
    uvs = np.array(all_uvs, dtype=np.float32)
    idx_type = np.uint16 if output_idx < 65536 else np.uint32
    body_idx_arr = np.array(body_indices, dtype=idx_type)
    hair_idx_arr = np.array(hair_indices, dtype=idx_type) if hair_indices else None

    print(f"  Body: {len(body_idx_arr) // 3} tris, Hair: {len(hair_indices) // 3} tris, Verts: {len(positions)}")

    def pad4(b):
        rem = len(b) % 4
        return b + b"\x00" * (4 - rem) if rem else b

    # Binary layout: body_indices | hair_indices | positions | normals | uvs | [texture]
    body_idx_bytes = pad4(body_idx_arr.tobytes())
    hair_idx_bytes = pad4(hair_idx_arr.tobytes()) if hair_idx_arr is not None else b""
    pos_bytes = pad4(positions.tobytes())
    norm_bytes = pad4(normals.tobytes())
    uv_bytes = pad4(uvs.tobytes())

    body_idx_offset = 0
    hair_idx_offset = body_idx_offset + len(body_idx_bytes)
    pos_offset = hair_idx_offset + len(hair_idx_bytes)
    norm_offset = pos_offset + len(pos_bytes)
    uv_offset = norm_offset + len(norm_bytes)

    total_bin = body_idx_bytes + hair_idx_bytes + pos_bytes + norm_bytes + uv_bytes

    # Texture
    tex_offset = len(total_bin)
    has_texture = texture_pngs and len(texture_pngs) > 0 and texture_pngs[0] is not None
    if has_texture:
        total_bin += pad4(texture_pngs[0])

    pos_min = positions.min(axis=0).tolist()
    pos_max = positions.max(axis=0).tolist()
    idx_ct = 5123 if idx_type == np.uint16 else 5125

    # --- Buffer views ---
    # 0: body indices
    # 1: hair indices (if present)
    # 2: positions
    # 3: normals
    # 4: uvs
    bv_list = [
        pygltflib.BufferView(buffer=0, byteOffset=body_idx_offset,
                             byteLength=len(body_idx_arr) * body_idx_arr.itemsize, target=34963),
    ]
    hair_idx_bv = None
    if hair_idx_arr is not None and len(hair_idx_arr) > 0:
        hair_idx_bv = len(bv_list)
        bv_list.append(
            pygltflib.BufferView(buffer=0, byteOffset=hair_idx_offset,
                                 byteLength=len(hair_idx_arr) * hair_idx_arr.itemsize, target=34963),
        )
    pos_bv = len(bv_list)
    bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=pos_offset,
                   byteLength=len(positions) * 12, target=34962, byteStride=12))
    norm_bv = len(bv_list)
    bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=norm_offset,
                   byteLength=len(normals) * 12, target=34962, byteStride=12))
    uv_bv = len(bv_list)
    bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=uv_offset,
                   byteLength=len(uvs) * 8, target=34962, byteStride=8))

    # --- Accessors ---
    # 0: body indices
    acc_list = [
        pygltflib.Accessor(bufferView=0, componentType=idx_ct,
                           count=len(body_idx_arr), type="SCALAR",
                           max=[int(body_idx_arr.max())], min=[int(body_idx_arr.min())]),
    ]
    hair_idx_acc = None
    if hair_idx_arr is not None and len(hair_idx_arr) > 0:
        hair_idx_acc = len(acc_list)
        acc_list.append(
            pygltflib.Accessor(bufferView=hair_idx_bv, componentType=idx_ct,
                               count=len(hair_idx_arr), type="SCALAR",
                               max=[int(hair_idx_arr.max())], min=[int(hair_idx_arr.min())]),
        )
    pos_acc = len(acc_list)
    acc_list.append(pygltflib.Accessor(bufferView=pos_bv, componentType=5126,
                    count=len(positions), type="VEC3", max=pos_max, min=pos_min))
    norm_acc = len(acc_list)
    acc_list.append(pygltflib.Accessor(bufferView=norm_bv, componentType=5126,
                    count=len(normals), type="VEC3"))
    uv_acc = len(acc_list)
    acc_list.append(pygltflib.Accessor(bufferView=uv_bv, componentType=5126,
                    count=len(uvs), type="VEC2"))

    # --- Primitives ---
    attrs = pygltflib.Attributes(POSITION=pos_acc, NORMAL=norm_acc, TEXCOORD_0=uv_acc)
    primitives = [
        pygltflib.Primitive(attributes=attrs, indices=0, material=0),  # body
    ]
    if hair_idx_acc is not None:
        primitives.append(
            pygltflib.Primitive(attributes=attrs, indices=hair_idx_acc, material=1),  # hair
        )

    gltf = pygltflib.GLTF2(
        scene=0,
        scenes=[pygltflib.Scene(nodes=[0])],
        nodes=[pygltflib.Node(mesh=0)],
        meshes=[pygltflib.Mesh(primitives=primitives)],
        accessors=acc_list,
        bufferViews=bv_list,
        buffers=[pygltflib.Buffer(byteLength=len(total_bin))],
        materials=[], textures=[], images=[], samplers=[],
    )

    # Material 0: body with skin texture
    if has_texture:
        gltf.bufferViews.append(
            pygltflib.BufferView(buffer=0, byteOffset=tex_offset,
                                 byteLength=len(texture_pngs[0])))
        gltf.images.append(pygltflib.Image(bufferView=len(gltf.bufferViews) - 1, mimeType="image/png"))
        gltf.samplers.append(pygltflib.Sampler(magFilter=9729, minFilter=9987, wrapS=10497, wrapT=10497))
        gltf.textures.append(pygltflib.Texture(source=0, sampler=0))
        gltf.materials.append(pygltflib.Material(
            pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
                baseColorTexture=pygltflib.TextureInfo(index=0),
                metallicFactor=0.0, roughnessFactor=0.8),
            doubleSided=True))
    else:
        gltf.materials.append(pygltflib.Material(
            pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
                baseColorFactor=[0.76, 0.60, 0.47, 1.0],
                metallicFactor=0.0, roughnessFactor=0.8),
            doubleSided=True))

    # Material 1: hair (dark brown)
    gltf.materials.append(pygltflib.Material(
        pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
            baseColorFactor=[0.20, 0.12, 0.06, 1.0],
            metallicFactor=0.0, roughnessFactor=0.9),
        doubleSided=True))

    gltf.set_binary_blob(total_bin)
    return gltf


# ── Default geoset selections for character models ───────────────────────────

# WoW character submesh IDs: hundreds = geoset group, ones = variation.
# Only one variation per group should be visible at a time.
# Group 0 (0-99): Body/skin base
# Group 1 (1xx): Facial hair style 1
# Group 2 (2xx): Facial hair style 2
# Group 3 (3xx): Facial hair style 3
# Group 4 (4xx): Bracers/gloves
# Group 5 (5xx): Boots
# Group 7 (7xx): Ears
# Group 8 (8xx): Wristbands/sleeves
# Group 9 (9xx): Kneepads/legs
# Group 10 (10xx): Chest
# Group 11 (11xx): Pants/tabard lower
# Group 13 (13xx): Trousers
# Group 15 (15xx): Loincloth/robe
# Group 16 (16xx): Belt
DEFAULT_GEOSETS = {
    "Character\\Human\\Male\\HumanMale": {
        0,      # Body base (torso, head, limbs)
        3,      # Hairstyle 3 (standard hair, 115 verts)
        101,    # Facial hair group 1 - "none" (closes jaw/chin gaps)
        201,    # Facial hair group 2 - "none" (closes cheek gaps)
        301,    # Facial hair group 3 - "none" (closes upper lip gaps)
        401,    # Bare hands
        501,    # Bare feet
        702,    # Ears shown
        1301,   # Legs (not dress mode)
        1501,   # No cloak (fills upper back gap)
    },
}


# ── Default skin textures for character models ───────────────────────────────

# Character models use runtime textures (type != 0), so the BLP paths aren't
# in the M2 file. These are common default skin texture paths.
DEFAULT_SKIN_TEXTURES = {
    "Character\\Human\\Male\\HumanMale": [
        "Character\\Human\\Male\\HumanMaleSkin00_00.blp",
        "Character\\Human\\Male\\HumanMaleSkin00_01.blp",
        "Character\\Human\\Male\\HumanMaleSkin00_02.blp",
    ],
    "Character\\Human\\Female\\HumanFemale": [
        "Character\\Human\\Female\\HumanFemaleSkin00_00.blp",
    ],
}


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Extract WoW 3.3.5a M2 models to glTF")
    parser.add_argument(
        "--data-dir",
        required=True,
        help="Path to WoW Data directory containing MPQ files",
    )
    parser.add_argument(
        "--model",
        required=True,
        help="Model path inside MPQ (e.g. Character\\Human\\Male\\HumanMale)",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output .glb file path",
    )
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    model_path = args.model
    output_path = Path(args.output)

    # Ensure output directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Loading StormLib from {STORMLIB_DLL}")
    storm = StormLib(STORMLIB_DLL)

    # Extract M2 file
    m2_filepath = model_path + ".m2"
    print(f"\nExtracting {m2_filepath}...")
    m2_data = extract_from_mpq(storm, data_dir, m2_filepath)
    if m2_data is None:
        print(f"ERROR: Could not find {m2_filepath} in any MPQ archive")
        sys.exit(1)

    # Verify M2 magic
    magic = m2_data[0:4]
    if magic != b"MD20":
        print(f"ERROR: Invalid M2 magic: {magic}")
        sys.exit(1)

    version = struct.unpack_from("<I", m2_data, 4)[0]
    print(f"  M2 version: {version}")

    # Parse M2 data
    print("  Parsing vertices...")
    m2_vertices = parse_m2_vertices(m2_data)
    print(f"  Found {len(m2_vertices)} vertices")

    print("  Parsing textures...")
    m2_textures = parse_m2_textures(m2_data)
    for tex in m2_textures:
        print(f"    Type {tex['type']}: {tex['filename'] or '(runtime)'}")

    texture_combos = parse_m2_texture_combos(m2_data)

    # Extract .skin file (LOD 0)
    model_name = model_path.rsplit("\\", 1)[-1]
    skin_filepath = model_path + "00.skin"
    print(f"\nExtracting {skin_filepath}...")
    skin_data = extract_from_mpq(storm, data_dir, skin_filepath)
    if skin_data is None:
        print(f"ERROR: Could not find {skin_filepath} in any MPQ archive")
        sys.exit(1)

    print("  Parsing skin data...")
    local_to_global, indices, submeshes, batches = parse_skin(skin_data)
    print(f"  Submeshes: {len(submeshes)}, Batches: {len(batches)}")
    for sub in submeshes:
        if sub["level"] == 0:
            print(f"    Submesh {sub['id']}: {sub['vertex_count']} verts, {sub['index_count'] // 3} tris")

    # Try to extract a texture
    texture_pngs = []
    # For character models, prefer the body skin texture over M2-referenced ones
    if model_path in DEFAULT_SKIN_TEXTURES:
        for tex_path in DEFAULT_SKIN_TEXTURES[model_path]:
            print(f"\nTrying skin texture {tex_path}...")
            blp_data = extract_from_mpq(storm, data_dir, tex_path)
            if blp_data:
                png_data = blp_to_png_bytes(blp_data)
                if png_data:
                    texture_pngs.append(png_data)
                    break

    # Fall back to textures referenced directly in M2
    if not texture_pngs:
        for tex in m2_textures:
            if tex["type"] == 0 and tex["filename"]:
                print(f"\nExtracting texture {tex['filename']}...")
                blp_data = extract_from_mpq(storm, data_dir, tex["filename"])
                if blp_data:
                    png_data = blp_to_png_bytes(blp_data)
                    if png_data:
                        texture_pngs.append(png_data)
                        break

    # Determine geoset filter
    geoset_filter = DEFAULT_GEOSETS.get(model_path)
    if geoset_filter:
        print(f"\nUsing geoset filter: {sorted(geoset_filter)}")
    else:
        print("\nNo geoset filter defined, including all submeshes")

    # Build glTF
    print("Building glTF...")
    gltf = build_glb(m2_vertices, local_to_global, indices, submeshes, texture_pngs, geoset_filter)

    # Save
    print(f"Saving to {output_path}...")
    gltf.save(str(output_path))
    file_size = output_path.stat().st_size
    print(f"Done! Output: {output_path} ({file_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
