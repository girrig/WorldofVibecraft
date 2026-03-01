#!/usr/bin/env python3
"""
Extract WoW 3.3.5a WMO (World Map Object) buildings to glTF (.glb) format.

Reads the doodad placement JSON (from extract_terrain.py), finds all unique WMO model
paths, extracts root + group files from MPQ archives, and converts to GLB meshes.

Usage:
    python extract_wmo.py
    python extract_wmo.py --data-dir "C:\Path\To\Data" --output-dir "../client/public/assets/models"
"""

import argparse
import json
import struct
import sys
import numpy as np
from pathlib import Path
import io

from extract_model import (
    StormLib, extract_from_mpq, MPQ_LOAD_ORDER, STORMLIB_DLL,
    blp_to_png_bytes, wow_to_gltf_pos, read_m2array,
)

import pygltflib

SCRIPT_DIR = Path(__file__).parent
DEFAULT_DATA_DIR = Path(r"C:\Program Files\Ascension Launcher\resources\epoch_live\Data")
DEFAULT_DOODAD_JSON = SCRIPT_DIR / ".." / "client" / "public" / "assets" / "terrain" / "northshire_doodads.json"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / ".." / "client" / "public" / "assets" / "models"


# ── MPQ Archive Pool (keeps archives open for fast access) ──────────────────

class MPQArchivePool:
    """Opens all MPQ archives once and keeps them open for fast repeated access."""
    def __init__(self, storm, data_dir, mpq_list):
        self.storm = storm
        self.data_dir = data_dir
        self.handles = []  # List of (mpq_name, handle) tuples

        print(f"Opening {len(mpq_list)} MPQ archives...")
        for mpq_name in mpq_list:
            mpq_path = data_dir / mpq_name
            if not mpq_path.exists():
                continue
            handle = storm.open_archive(mpq_path)
            if handle:
                self.handles.append((mpq_name, handle))

        print(f"  Opened {len(self.handles)} archives successfully")

    def read_file(self, filepath):
        """Try to read a file from archives (highest priority first)."""
        # Search in reverse order (highest priority first)
        for mpq_name, handle in reversed(self.handles):
            if self.storm.has_file(handle, filepath):
                data = self.storm.read_file(handle, filepath)
                if data:
                    return data
        return None

    def close_all(self):
        """Close all open archives."""
        for mpq_name, handle in self.handles:
            self.storm.close_archive(handle)
        self.handles.clear()


# ── IFF chunk scanner (same pattern as extract_terrain.py) ──────────────────

def scan_chunks(data, start=0):
    """Yield (magic_reversed, data_offset, size) for each IFF chunk."""
    pos = start
    while pos + 8 <= len(data):
        raw_magic = data[pos:pos + 4]
        magic = raw_magic[::-1]  # WoW IFF stores reversed
        size = struct.unpack_from("<I", data, pos + 4)[0]
        data_ofs = pos + 8
        if data_ofs + size > len(data):
            break
        yield magic, data_ofs, size
        pos = data_ofs + size


# ── WMO Root parser ─────────────────────────────────────────────────────────

def parse_wmo_root(data):
    """Parse WMO root file. Returns dict with header, textures, materials, group info."""
    result = {
        "nTextures": 0,
        "nGroups": 0,
        "nPortals": 0,
        "nLights": 0,
        "nModels": 0,
        "textures": [],      # list of texture path strings
        "materials": [],     # list of material dicts
        "groups_info": [],   # list of group info dicts
    }

    motx_data = None  # raw texture name data

    for magic, data_ofs, size in scan_chunks(data):
        if magic == b"MOHD":
            # Header: 64 bytes
            if size >= 64:
                (n_tex, n_groups, n_portals, n_lights, n_models) = struct.unpack_from(
                    "<IIIII", data, data_ofs
                )
                result["nTextures"] = n_tex
                result["nGroups"] = n_groups
                result["nPortals"] = n_portals
                result["nLights"] = n_lights
                result["nModels"] = n_models

        elif magic == b"MOTX":
            # Concatenated null-terminated texture filenames
            motx_data = data[data_ofs:data_ofs + size]

        elif magic == b"MOMT":
            # Materials: 64 bytes each
            mat_size = 64
            n_mats = size // mat_size
            for i in range(n_mats):
                m_ofs = data_ofs + i * mat_size
                flags = struct.unpack_from("<I", data, m_ofs)[0]
                shader = struct.unpack_from("<I", data, m_ofs + 4)[0]
                blend_mode = struct.unpack_from("<I", data, m_ofs + 8)[0]
                tex1_ofs = struct.unpack_from("<I", data, m_ofs + 12)[0]
                # color1 at +16 (4 bytes BGRA)
                # tex1_flags at +20
                tex2_ofs = struct.unpack_from("<I", data, m_ofs + 24)[0]
                # color2 at +28
                # ground_type at +32
                # tex3_ofs at +36
                # color3 at +40
                # flags3 at +44
                # runtime data at +48..63

                result["materials"].append({
                    "flags": flags,
                    "shader": shader,
                    "blendMode": blend_mode,
                    "tex1Offset": tex1_ofs,
                    "tex2Offset": tex2_ofs,
                })

        elif magic == b"MOGI":
            # Group info: 32 bytes each
            gi_size = 32
            n_gi = size // gi_size
            for i in range(n_gi):
                g_ofs = data_ofs + i * gi_size
                flags = struct.unpack_from("<I", data, g_ofs)[0]
                bb_lo = struct.unpack_from("<3f", data, g_ofs + 4)
                bb_hi = struct.unpack_from("<3f", data, g_ofs + 16)
                name_ofs = struct.unpack_from("<i", data, g_ofs + 28)[0]
                result["groups_info"].append({
                    "flags": flags,
                    "bbLo": bb_lo,
                    "bbHi": bb_hi,
                    "nameOffset": name_ofs,
                })

    # Resolve texture paths from MOTX
    if motx_data:
        for mat in result["materials"]:
            tex_path = ""
            ofs = mat["tex1Offset"]
            if ofs < len(motx_data):
                end = motx_data.find(b"\x00", ofs)
                if end < 0:
                    end = len(motx_data)
                tex_path = motx_data[ofs:end].decode("ascii", errors="replace")
            mat["texturePath"] = tex_path

    return result


# ── WMO Group parser ────────────────────────────────────────────────────────

def parse_wmo_group(data):
    """Parse a WMO group file. Returns dict with vertices, normals, UVs, indices, material per tri."""
    result = {
        "vertices": None,   # Nx3 float array
        "normals": None,    # Nx3 float array
        "uvs": None,        # Nx2 float array
        "indices": None,    # Mx3 uint16 array (triangle indices)
        "materials": None,  # M-length array of material IDs per triangle
        "triFlags": None,   # M-length array of flags per triangle
    }

    # WMO group files may start with MVER chunk, then MOGP chunk wraps all sub-chunks
    # The MOGP header is 68 bytes, then sub-chunks follow inside MOGP's data
    if len(data) < 8:
        return result

    # Find the MOGP chunk (may be preceded by MVER)
    mogp_start = None
    for magic, data_ofs, size in scan_chunks(data, 0):
        if magic == b"MOGP":
            mogp_start = data_ofs
            break

    if mogp_start is None:
        return result

    # MOGP header is 68 bytes, then sub-chunks follow
    mogp_header_size = 68
    sub_start = mogp_start + mogp_header_size

    for magic, data_ofs, size in scan_chunks(data, sub_start):
        if magic == b"MOVT":
            # Vertex positions: 3 floats each
            n_verts = size // 12
            verts = np.frombuffer(data[data_ofs:data_ofs + n_verts * 12], dtype=np.float32).reshape(-1, 3)
            result["vertices"] = verts

        elif magic == b"MONR":
            # Normals: 3 floats each
            n_norms = size // 12
            norms = np.frombuffer(data[data_ofs:data_ofs + n_norms * 12], dtype=np.float32).reshape(-1, 3)
            result["normals"] = norms

        elif magic == b"MOTV":
            # UVs: 2 floats each (only take first set if multiple MOTV chunks)
            if result["uvs"] is None:
                n_uvs = size // 8
                uvs = np.frombuffer(data[data_ofs:data_ofs + n_uvs * 8], dtype=np.float32).reshape(-1, 2)
                result["uvs"] = uvs

        elif magic == b"MOVI":
            # Triangle indices: uint16
            n_idx = size // 2
            indices = np.frombuffer(data[data_ofs:data_ofs + n_idx * 2], dtype=np.uint16)
            result["indices"] = indices.reshape(-1, 3)

        elif magic == b"MOPY":
            # Material per triangle: 2 bytes each (flags, materialID)
            n_tris = size // 2
            mopy = np.frombuffer(data[data_ofs:data_ofs + n_tris * 2], dtype=np.uint8).reshape(-1, 2)
            result["triFlags"] = mopy[:, 0]
            result["materials"] = mopy[:, 1]

    return result


# ── GLB builder for WMO ─────────────────────────────────────────────────────

def build_wmo_glb(root_info, group_geometries, archive_pool):
    """
    Build a GLB from WMO root + groups.
    Merges all groups, splits by material for multi-primitive mesh.
    archive_pool: MPQArchivePool instance with open archives
    """
    # Merge all group geometry with vertex offset tracking
    all_verts = []
    all_norms = []
    all_uvs = []
    # Per material: list of triangles
    mat_triangles = {}  # materialID -> list of (v0, v1, v2) with global indices
    vert_offset = 0

    for group in group_geometries:
        if group["vertices"] is None or group["indices"] is None:
            continue

        verts = group["vertices"]
        norms = group["normals"]
        uvs = group["uvs"]
        tris = group["indices"]
        mat_ids = group["materials"]
        tri_flags = group["triFlags"]

        n_verts = len(verts)

        # Transform coordinates: WoW (x,y,z) → glTF (x, z, -y)
        transformed_verts = np.column_stack([verts[:, 0], verts[:, 2], -verts[:, 1]])
        all_verts.append(transformed_verts)

        if norms is not None and len(norms) == n_verts:
            transformed_norms = np.column_stack([norms[:, 0], norms[:, 2], -norms[:, 1]])
            all_norms.append(transformed_norms)
        else:
            all_norms.append(np.zeros((n_verts, 3), dtype=np.float32))

        if uvs is not None and len(uvs) == n_verts:
            all_uvs.append(uvs)
        else:
            all_uvs.append(np.zeros((n_verts, 2), dtype=np.float32))

        # Assign triangles to materials
        for tri_idx in range(len(tris)):
            mat_id = int(mat_ids[tri_idx]) if mat_ids is not None else 0
            flags = int(tri_flags[tri_idx]) if tri_flags is not None else 0

            # Skip collision-only triangles (flag 0x04) and detail doodad triangles
            # Bit 0x01 = render, we want triangles with render flag
            # Actually, MOPY flags: 0x04 = nocollide, 0x01 = detail (BSP detail)
            # materialID 0xFF means invisible/collision-only
            if mat_id == 0xFF:
                continue

            v0, v1, v2 = int(tris[tri_idx][0]), int(tris[tri_idx][1]), int(tris[tri_idx][2])
            if mat_id not in mat_triangles:
                mat_triangles[mat_id] = []
            mat_triangles[mat_id].append((v0 + vert_offset, v1 + vert_offset, v2 + vert_offset))

        vert_offset += n_verts

    if not all_verts or not mat_triangles:
        return None

    # Concatenate all vertex data
    positions = np.vstack(all_verts).astype(np.float32)
    normals_arr = np.vstack(all_norms).astype(np.float32)
    uvs_arr = np.vstack(all_uvs).astype(np.float32)
    total_verts = len(positions)

    def pad4(b):
        rem = len(b) % 4
        return b + b"\x00" * (4 - rem) if rem else b

    bin_data = bytearray()

    def append_bin(data_bytes):
        offset = len(bin_data)
        bin_data.extend(pad4(data_bytes))
        return offset

    # Write vertex data
    pos_offset = append_bin(positions.tobytes())
    norm_offset = append_bin(normals_arr.tobytes())
    uv_offset = append_bin(uvs_arr.tobytes())

    pos_min = positions.min(axis=0).tolist()
    pos_max = positions.max(axis=0).tolist()

    # Buffer views for shared vertex data
    bv_list = [
        pygltflib.BufferView(buffer=0, byteOffset=pos_offset,
                             byteLength=total_verts * 12, target=34962, byteStride=12),
        pygltflib.BufferView(buffer=0, byteOffset=norm_offset,
                             byteLength=total_verts * 12, target=34962, byteStride=12),
        pygltflib.BufferView(buffer=0, byteOffset=uv_offset,
                             byteLength=total_verts * 8, target=34962, byteStride=8),
    ]

    # Accessors for shared vertex attributes
    acc_list = [
        pygltflib.Accessor(bufferView=0, componentType=5126,
                           count=total_verts, type="VEC3", max=pos_max, min=pos_min),
        pygltflib.Accessor(bufferView=1, componentType=5126,
                           count=total_verts, type="VEC3"),
        pygltflib.Accessor(bufferView=2, componentType=5126,
                           count=total_verts, type="VEC2"),
    ]
    pos_acc = 0
    norm_acc = 1
    uv_acc = 2

    # Extract textures for materials
    mat_textures = {}  # materialID -> png_bytes or None
    materials_list = root_info.get("materials", [])

    for mat_id in mat_triangles.keys():
        if mat_id < len(materials_list):
            mat = materials_list[mat_id]
            tex_path = mat.get("texturePath", "")
            if tex_path:
                mpq_path = tex_path.replace("/", "\\")
                blp_data = archive_pool.read_file(mpq_path)
                if blp_data:
                    png = blp_to_png_bytes(blp_data)
                    if png:
                        mat_textures[mat_id] = png
                        continue
        mat_textures[mat_id] = None

    # Build one primitive per material
    primitives = []
    gltf_materials = []
    gltf_images = []
    gltf_textures = []
    gltf_samplers = []
    tex_idx_counter = 0

    sorted_mats = sorted(mat_triangles.keys())

    for gltf_mat_idx, mat_id in enumerate(sorted_mats):
        tris = mat_triangles[mat_id]
        idx_flat = []
        for v0, v1, v2 in tris:
            idx_flat.extend([v0, v1, v2])

        idx_type = np.uint16 if total_verts < 65536 else np.uint32
        idx_arr = np.array(idx_flat, dtype=idx_type)
        idx_ct = 5123 if idx_type == np.uint16 else 5125

        # Write index buffer
        idx_bv = len(bv_list)
        idx_off = append_bin(idx_arr.tobytes())
        bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=idx_off,
                                            byteLength=len(idx_arr) * idx_arr.itemsize, target=34963))

        idx_acc = len(acc_list)
        acc_list.append(pygltflib.Accessor(bufferView=idx_bv, componentType=idx_ct,
                                           count=len(idx_arr), type="SCALAR",
                                           max=[int(idx_arr.max())], min=[int(idx_arr.min())]))

        # Primitive
        attrs = pygltflib.Attributes(POSITION=pos_acc, NORMAL=norm_acc, TEXCOORD_0=uv_acc)
        primitives.append(pygltflib.Primitive(attributes=attrs, indices=idx_acc, material=gltf_mat_idx))

        # Material with texture if available
        png_data = mat_textures.get(mat_id)
        if png_data:
            tex_bv = len(bv_list)
            tex_off = append_bin(png_data)
            bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=tex_off,
                                                byteLength=len(png_data)))
            img_idx = len(gltf_images)
            gltf_images.append(pygltflib.Image(bufferView=tex_bv, mimeType="image/png"))

            if not gltf_samplers:
                gltf_samplers.append(pygltflib.Sampler(magFilter=9729, minFilter=9987,
                                                       wrapS=10497, wrapT=10497))

            tex_index = len(gltf_textures)
            gltf_textures.append(pygltflib.Texture(source=img_idx, sampler=0))

            gltf_materials.append(pygltflib.Material(
                pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
                    baseColorTexture=pygltflib.TextureInfo(index=tex_index),
                    metallicFactor=0.0, roughnessFactor=0.8),
                doubleSided=True))
        else:
            # Solid color fallback
            gltf_materials.append(pygltflib.Material(
                pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
                    baseColorFactor=[0.7, 0.6, 0.5, 1.0],
                    metallicFactor=0.0, roughnessFactor=0.8),
                doubleSided=True))

    # Assemble
    gltf = pygltflib.GLTF2(
        scene=0,
        scenes=[pygltflib.Scene(nodes=[0])],
        nodes=[pygltflib.Node(mesh=0)],
        meshes=[pygltflib.Mesh(primitives=primitives)],
        accessors=acc_list,
        bufferViews=bv_list,
        buffers=[pygltflib.Buffer(byteLength=len(bin_data))],
        materials=gltf_materials,
        textures=gltf_textures,
        images=gltf_images,
        samplers=gltf_samplers,
    )

    gltf.set_binary_blob(bytes(bin_data))
    return gltf


def extract_wmo_collision(group_geometries):
    """Extract collision triangles from WMO group data.

    Uses MOPY flags to identify collision triangles:
      - Triangles with flags & 0x04 are NO-COLLISION, skip them.
      - All other triangles (including materialID == 0xFF invisible walls) are collision.

    Returns (verts_flat, tris_flat) in glTF Y-up coords, or ([], []) if none.
      verts_flat: [x0,y0,z0, x1,y1,z1, ...] in glTF space
      tris_flat:  [i0,i1,i2, ...] triangle indices
    """
    all_verts = []
    all_tris = []
    vert_offset = 0

    for group in group_geometries:
        if group["vertices"] is None or group["indices"] is None:
            continue

        verts = group["vertices"]
        tris = group["indices"]
        tri_flags = group["triFlags"]
        n_verts = len(verts)

        # Transform vertices: WoW (x,y,z) Z-up → glTF (x, z, -y) Y-up
        for i in range(n_verts):
            x, y, z = float(verts[i][0]), float(verts[i][1]), float(verts[i][2])
            all_verts.extend([round(x, 3), round(z, 3), round(-y, 3)])

        # Collect collision triangles (those NOT marked no-collision)
        for tri_idx in range(len(tris)):
            flags = int(tri_flags[tri_idx]) if tri_flags is not None else 0
            # Bit 0x04 = no-collision — skip these
            if flags & 0x04:
                continue
            v0, v1, v2 = int(tris[tri_idx][0]), int(tris[tri_idx][1]), int(tris[tri_idx][2])
            all_tris.extend([v0 + vert_offset, v1 + vert_offset, v2 + vert_offset])

        vert_offset += n_verts

    if not all_tris:
        return [], []

    return all_verts, all_tris


def extract_single_wmo(archive_pool, wow_wmo_path):
    """
    Extract a single WMO (root + all groups) and return a pygltflib.GLTF2 object.
    Returns None on failure.
    archive_pool: MPQArchivePool instance with open archives
    """
    # Normalize path for MPQ
    mpq_path = wow_wmo_path.replace("/", "\\")
    if not mpq_path.lower().endswith(".wmo"):
        mpq_path += ".wmo"

    # Extract root file
    root_data = archive_pool.read_file(mpq_path)
    if root_data is None:
        print(f"    Root .wmo not found: {mpq_path}")
        return None

    # Parse root
    root_info = parse_wmo_root(root_data)
    n_groups = root_info["nGroups"]
    print(f"    Groups: {n_groups}, Materials: {len(root_info['materials'])}")

    if n_groups == 0:
        print(f"    No groups in WMO")
        return None

    # Skip extremely large WMOs (e.g. Stormwind with 209+ groups)
    if n_groups > 100:
        print(f"    Skipping: too many groups ({n_groups}), likely out-of-area WMO")
        return None

    # Extract and parse each group file
    base_path = mpq_path[:-4]  # strip .wmo
    group_geometries = []

    for gi in range(n_groups):
        group_path = f"{base_path}_{gi:03d}.wmo"
        group_data = archive_pool.read_file(group_path)
        if group_data is None:
            print(f"    Group {gi:03d} not found, skipping")
            continue

        group = parse_wmo_group(group_data)
        if group["vertices"] is not None:
            n_v = len(group["vertices"])
            n_t = len(group["indices"]) if group["indices"] is not None else 0
            print(f"    Group {gi:03d}: {n_v} verts, {n_t} tris")
            group_geometries.append(group)

    if not group_geometries:
        print(f"    No valid group geometry found")
        return None

    # Extract collision geometry from MOPY-flagged triangles
    coll_verts, coll_tris = extract_wmo_collision(group_geometries)

    # Build GLB
    gltf = build_wmo_glb(root_info, group_geometries, archive_pool)
    return gltf, coll_verts, coll_tris


def main():
    parser = argparse.ArgumentParser(description="Extract WoW WMO buildings to GLB")
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR),
                        help="Path to WoW Data directory with MPQ files")
    parser.add_argument("--doodad-json", default=str(DEFAULT_DOODAD_JSON),
                        help="Path to northshire_doodads.json")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR),
                        help="Output base directory for models")
    parser.add_argument("--force", action="store_true",
                        help="Force re-extraction of existing files")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    doodad_json_path = Path(args.doodad_json)
    output_dir = Path(args.output_dir)
    wmo_dir = output_dir / "wmos"
    wmo_dir.mkdir(parents=True, exist_ok=True)

    # Load doodad placement data
    print(f"Loading doodad data from {doodad_json_path}...")
    with open(doodad_json_path) as f:
        doodad_data = json.load(f)

    # Get unique WMO paths (only those within world bounds)
    HALF_WORLD = 800  # WORLD_SIZE / 2 from shared/constants.js
    unique_wmos = {}
    for wmo in doodad_data.get("wmos", []):
        if abs(wmo["x"]) > HALF_WORLD or abs(wmo["z"]) > HALF_WORLD:
            continue
        model = wmo["model"]
        if model not in unique_wmos:
            unique_wmos[model] = 0
        unique_wmos[model] += 1

    print(f"Found {len(unique_wmos)} unique WMO models ({sum(unique_wmos.values())} total instances)")

    # Initialize StormLib and open all archives
    print(f"\nLoading StormLib from {STORMLIB_DLL}...")
    storm = StormLib(STORMLIB_DLL)
    archive_pool = MPQArchivePool(storm, data_dir, MPQ_LOAD_ORDER)

    # Load existing manifest to append to
    manifest_path = output_dir / "doodad_manifest.json"
    if manifest_path.exists():
        with open(manifest_path) as f:
            manifest = json.load(f)
    else:
        manifest = {"models": {}}

    if "wmos" not in manifest:
        manifest["wmos"] = {}

    # Load existing collision data (from doodad extraction) to append WMO data
    collision_path = output_dir / "collision_data.json"
    if collision_path.exists():
        with open(collision_path) as f:
            collision_data = json.load(f)
    else:
        collision_data = {}

    total_size = 0
    extracted = 0
    failed = 0
    skipped = 0

    print(f"\n== Extracting {len(unique_wmos)} WMO models ==")
    if not args.force:
        print(f"   (Caching enabled - existing files will be skipped. Use --force to override)\n")
    else:
        print(f"   (--force enabled - re-extracting all models)\n")

    for i, (wow_path, instance_count) in enumerate(sorted(unique_wmos.items())):
        short_name = wow_path.rsplit("/", 1)[-1]
        basename = short_name.replace(".wmo", ".glb").lower()
        glb_path = wmo_dir / basename

        progress = f"[{i+1}/{len(unique_wmos)}]"

        # Check cache unless --force
        if not args.force and glb_path.exists():
            file_size = glb_path.stat().st_size
            total_size += file_size
            manifest["wmos"][wow_path] = {
                "glb": "wmos/" + basename,
            }
            skipped += 1
            # Still need to extract collision if not already present
            if wow_path not in collision_data:
                try:
                    result = extract_single_wmo(archive_pool, wow_path)
                    if result is not None:
                        _, coll_verts, coll_tris = result
                        if coll_verts and coll_tris:
                            collision_data[wow_path] = {
                                "verts": coll_verts,
                                "tris": coll_tris,
                            }
                except Exception:
                    pass
            continue

        print(f"{progress} {short_name} ({instance_count} instances)...")

        try:
            result = extract_single_wmo(archive_pool, wow_path)
            if result is None:
                print(f"  SKIP: extraction failed")
                failed += 1
                continue

            gltf, coll_verts, coll_tris = result

            if gltf is not None:
                gltf.save(str(glb_path))
                file_size = glb_path.stat().st_size
                total_size += file_size
                print(f"  OK: {file_size / 1024:.1f} KB")
            else:
                print(f"  SKIP: GLB build failed")
                failed += 1
                continue

            manifest["wmos"][wow_path] = {
                "glb": "wmos/" + basename,
            }

            if coll_verts and coll_tris:
                collision_data[wow_path] = {
                    "verts": coll_verts,
                    "tris": coll_tris,
                }
                n_cv = len(coll_verts) // 3
                n_ct = len(coll_tris) // 3
                print(f"  Collision: {n_cv} verts, {n_ct} tris")

            extracted += 1

        except Exception as e:
            print(f"  ERROR: {e}")
            import traceback
            traceback.print_exc()
            failed += 1
            continue

    # Close all archives
    archive_pool.close_all()

    # Update manifest
    manifest["totalWmoExtracted"] = extracted
    manifest["totalWmoSkipped"] = skipped
    manifest["totalWmoFailed"] = failed
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    # Write collision data (M2 doodads + WMO combined)
    with open(collision_path, "w") as f:
        json.dump(collision_data, f, separators=(",", ":"))
    collision_size = collision_path.stat().st_size

    # Count WMO collision stats
    wmo_coll_count = sum(1 for k in collision_data if k in unique_wmos)
    wmo_coll_verts = sum(len(v["verts"]) // 3 for k, v in collision_data.items() if k in unique_wmos)
    wmo_coll_tris = sum(len(v["tris"]) // 3 for k, v in collision_data.items() if k in unique_wmos)

    print(f"\n== Done ==")
    print(f"  Extracted: {extracted}/{len(unique_wmos)} WMOs")
    print(f"  Cached (skipped): {skipped}")
    print(f"  Failed: {failed}")
    print(f"  Total size: {total_size / 1024 / 1024:.1f} MB")
    print(f"  WMO Collision: {wmo_coll_count}/{len(unique_wmos)} models with collision meshes")
    print(f"    {wmo_coll_verts} vertices, {wmo_coll_tris} triangles")
    print(f"  Collision data: {collision_path} ({collision_size / 1024:.1f} KB)")
    print(f"  Manifest: {manifest_path}")
    print(f"  Output: {wmo_dir}")


if __name__ == "__main__":
    main()
