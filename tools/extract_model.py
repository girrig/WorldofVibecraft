#!/usr/bin/env python3
"""
Extract WoW 3.3.5a models from MPQ archives to glTF (.glb) format.

Usage:
    python extract_model.py --data-dir "C:\Path\To\Data" --model "Character\Human\Male\HumanMale" --output "../client/public/assets/models/human_male.glb"
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
    "enUS/locale-enUS.MPQ",
    "enUS/patch-enUS.MPQ",
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


# ── M2 bone & animation parsing ──────────────────────────────────────────────

# Animation IDs we want to extract
WANTED_ANIMATION_IDS = {0: "Stand", 4: "Walk", 5: "Run", 13: "WalkBackwards", 38: "Jump"}


def parse_m2_sequences(data, header_offset=0x01C):
    """Parse animation sequence definitions (64 bytes each)."""
    count, offset = read_m2array(data, header_offset)
    sequences = []
    for i in range(count):
        s_off = offset + i * 64
        anim_id, variation = struct.unpack_from("<HH", data, s_off)
        duration = struct.unpack_from("<I", data, s_off + 4)[0]
        movespeed = struct.unpack_from("<f", data, s_off + 8)[0]
        flags = struct.unpack_from("<I", data, s_off + 12)[0]
        sequences.append({
            "id": anim_id,
            "variation": variation,
            "duration": duration,
            "movespeed": movespeed,
            "flags": flags,
            "index": i,
        })
    return sequences


def parse_m2_track(m2_data, track_offset, value_size, value_fmt):
    """
    Parse an M2Track (20 bytes: interp u16, global_seq i16, ts_array M2Array, val_array M2Array).
    Returns dict {seq_index: {"timestamps": [...], "values": [...], "interpolation": int}}
    """
    interp_type = struct.unpack_from("<H", m2_data, track_offset)[0]
    global_seq = struct.unpack_from("<h", m2_data, track_offset + 2)[0]
    ts_count, ts_offset = struct.unpack_from("<II", m2_data, track_offset + 4)
    val_count, val_offset = struct.unpack_from("<II", m2_data, track_offset + 12)

    track_data = {}
    for seq_idx in range(min(ts_count, val_count)):
        # Inner M2Array for this sequence's timestamps and values
        inner_ts_count, inner_ts_offset = struct.unpack_from("<II", m2_data, ts_offset + seq_idx * 8)
        inner_val_count, inner_val_offset = struct.unpack_from("<II", m2_data, val_offset + seq_idx * 8)

        if inner_ts_count == 0 or inner_val_count == 0:
            continue

        try:
            timestamps = list(struct.unpack_from(f"<{inner_ts_count}I", m2_data, inner_ts_offset))
            values = []
            for j in range(inner_val_count):
                v = struct.unpack_from(value_fmt, m2_data, inner_val_offset + j * value_size)
                values.append(v)
            track_data[seq_idx] = {
                "timestamps": timestamps,
                "values": values,
                "interpolation": interp_type,
            }
        except struct.error:
            continue

    return track_data


def parse_m2_bones(m2_data, header_offset=0x02C):
    """Parse M2CompBone structures (88 bytes each). Returns list of bone dicts."""
    count, offset = read_m2array(m2_data, header_offset)
    bones = []
    for i in range(count):
        b_off = offset + i * 88
        key_bone_id = struct.unpack_from("<i", m2_data, b_off)[0]
        flags = struct.unpack_from("<I", m2_data, b_off + 4)[0]
        parent = struct.unpack_from("<h", m2_data, b_off + 8)[0]
        submesh_id = struct.unpack_from("<H", m2_data, b_off + 10)[0]

        # Parse animation tracks
        # Translation: vec3 float (12 bytes, "<3f")
        translation = parse_m2_track(m2_data, b_off + 16, 12, "<3f")
        # Rotation: CompQuat int16 x4 (8 bytes, "<4h")
        rotation = parse_m2_track(m2_data, b_off + 36, 8, "<4h")
        # Scale: vec3 float (12 bytes, "<3f")
        scale = parse_m2_track(m2_data, b_off + 56, 12, "<3f")

        pivot = struct.unpack_from("<3f", m2_data, b_off + 76)

        bones.append({
            "key_bone_id": key_bone_id,
            "flags": flags,
            "parent": parent,
            "submesh_id": submesh_id,
            "pivot": pivot,
            "translation": translation,
            "rotation": rotation,
            "scale": scale,
        })
    return bones


def wow_to_gltf_pos(x, y, z):
    """Convert WoW Z-up position to glTF Y-up: (x,y,z) -> (x, z, -y)."""
    return (x, z, -y)


def wow_to_gltf_quat(qx, qy, qz, qw):
    """Convert WoW quaternion to glTF coordinate system.
    Axis components transform like positions: (x,y,z) -> (x, z, -y)
    Returns (x, y, z, w) in glTF convention."""
    return (qx, qz, -qy, qw)


def _comp_to_float(v):
    """Decompress a single M2 CompQuat component (offset-encoded int16 → float [-1,1])."""
    return (v + 32768) / 32767.0 if v < 0 else (v - 32767) / 32767.0


def decompress_quat(x, y, z, w):
    """Decompress M2 CompQuat (int16 x4) to float quaternion, then convert to glTF coords."""
    fx, fy, fz, fw = _comp_to_float(x), _comp_to_float(y), _comp_to_float(z), _comp_to_float(w)
    return wow_to_gltf_quat(fx, fy, fz, fw)


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

def build_glb(m2_vertices, local_to_global, indices, submeshes, texture_pngs=None,
              geoset_filter=None, bones=None, sequences=None):
    """
    Build a GLB file from parsed M2 + skin data, optionally with skeletal animation.
    Returns a pygltflib.GLTF2 object.
    """
    has_skeleton = bones is not None and len(bones) > 0
    num_bones = len(bones) if has_skeleton else 0

    # ── Vertex data ──────────────────────────────────────────────────────
    all_positions = []
    all_normals = []
    all_uvs = []
    all_joints = []
    all_weights = []
    body_indices_list = []
    hair_indices_list = []
    global_to_output = {}
    output_idx = 0

    for sub in submeshes:
        if sub["level"] != 0:
            continue
        if geoset_filter is not None and sub["id"] not in geoset_filter:
            continue
        is_hair = 1 <= sub["id"] <= 99
        target = hair_indices_list if is_hair else body_indices_list

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
                if has_skeleton:
                    bi = list(v["bone_indices"])
                    # Clamp bone indices to valid range
                    bi = [min(b, num_bones - 1) for b in bi]
                    all_joints.append(bi)
                    bw = list(v["bone_weights"])
                    total_w = sum(bw)
                    if total_w > 0:
                        all_weights.append([w / total_w for w in bw])
                    else:
                        all_weights.append([1.0, 0.0, 0.0, 0.0])
                global_to_output[global_idx] = output_idx
                output_idx += 1
            target.append(global_to_output[global_idx])

    positions = np.array(all_positions, dtype=np.float32)
    normals = np.array(all_normals, dtype=np.float32)
    uvs = np.array(all_uvs, dtype=np.float32)
    idx_type = np.uint16 if output_idx < 65536 else np.uint32
    body_idx_arr = np.array(body_indices_list, dtype=idx_type)
    hair_idx_arr = np.array(hair_indices_list, dtype=idx_type) if hair_indices_list else None
    num_verts = len(positions)

    print(f"  Body: {len(body_idx_arr) // 3} tris, Hair: {len(hair_indices_list) // 3} tris, Verts: {num_verts}")

    if has_skeleton:
        joints_arr = np.array(all_joints, dtype=np.uint8)
        weights_arr = np.array(all_weights, dtype=np.float32)

    def pad4(b):
        rem = len(b) % 4
        return b + b"\x00" * (4 - rem) if rem else b

    # ── Binary buffer (bytearray for easy appending) ─────────────────────
    bin_data = bytearray()

    def append_bin(data_bytes):
        """Append padded data to bin_data, return its starting offset."""
        offset = len(bin_data)
        bin_data.extend(pad4(data_bytes))
        return offset

    body_idx_offset = append_bin(body_idx_arr.tobytes())
    hair_idx_offset = append_bin(hair_idx_arr.tobytes()) if hair_idx_arr is not None else 0
    pos_offset = append_bin(positions.tobytes())
    norm_offset = append_bin(normals.tobytes())
    uv_offset = append_bin(uvs.tobytes())
    joints_offset = append_bin(joints_arr.tobytes()) if has_skeleton else 0
    weights_offset = append_bin(weights_arr.tobytes()) if has_skeleton else 0

    # Inverse bind matrices
    ibm_offset = 0
    if has_skeleton:
        ibm_floats = []
        for bone in bones:
            px, py, pz = wow_to_gltf_pos(*bone["pivot"])
            # IBM = T(-pivot) in column-major layout
            ibm_floats.extend([1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  -px, -py, -pz, 1])
        ibm_offset = append_bin(np.array(ibm_floats, dtype=np.float32).tobytes())

    # Texture image data
    tex_offset = 0
    has_texture = texture_pngs and len(texture_pngs) > 0 and texture_pngs[0] is not None
    if has_texture:
        tex_offset = append_bin(texture_pngs[0])

    # ── Buffer views ─────────────────────────────────────────────────────
    pos_min = positions.min(axis=0).tolist()
    pos_max = positions.max(axis=0).tolist()
    idx_ct = 5123 if idx_type == np.uint16 else 5125

    bv_list = [
        pygltflib.BufferView(buffer=0, byteOffset=body_idx_offset,
                             byteLength=len(body_idx_arr) * body_idx_arr.itemsize, target=34963),
    ]
    hair_idx_bv = None
    if hair_idx_arr is not None and len(hair_idx_arr) > 0:
        hair_idx_bv = len(bv_list)
        bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=hair_idx_offset,
                       byteLength=len(hair_idx_arr) * hair_idx_arr.itemsize, target=34963))
    pos_bv = len(bv_list)
    bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=pos_offset,
                   byteLength=num_verts * 12, target=34962, byteStride=12))
    norm_bv = len(bv_list)
    bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=norm_offset,
                   byteLength=num_verts * 12, target=34962, byteStride=12))
    uv_bv = len(bv_list)
    bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=uv_offset,
                   byteLength=num_verts * 8, target=34962, byteStride=8))

    if has_skeleton:
        joints_bv = len(bv_list)
        bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=joints_offset,
                       byteLength=num_verts * 4, target=34962, byteStride=4))
        weights_bv = len(bv_list)
        bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=weights_offset,
                       byteLength=num_verts * 16, target=34962, byteStride=16))
        ibm_bv = len(bv_list)
        bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=ibm_offset,
                       byteLength=num_bones * 64))

    # ── Accessors ────────────────────────────────────────────────────────
    acc_list = [
        pygltflib.Accessor(bufferView=0, componentType=idx_ct,
                           count=len(body_idx_arr), type="SCALAR",
                           max=[int(body_idx_arr.max())], min=[int(body_idx_arr.min())]),
    ]
    hair_idx_acc = None
    if hair_idx_arr is not None and len(hair_idx_arr) > 0:
        hair_idx_acc = len(acc_list)
        acc_list.append(pygltflib.Accessor(bufferView=hair_idx_bv, componentType=idx_ct,
                        count=len(hair_idx_arr), type="SCALAR",
                        max=[int(hair_idx_arr.max())], min=[int(hair_idx_arr.min())]))
    pos_acc = len(acc_list)
    acc_list.append(pygltflib.Accessor(bufferView=pos_bv, componentType=5126,
                    count=num_verts, type="VEC3", max=pos_max, min=pos_min))
    norm_acc = len(acc_list)
    acc_list.append(pygltflib.Accessor(bufferView=norm_bv, componentType=5126,
                    count=num_verts, type="VEC3"))
    uv_acc = len(acc_list)
    acc_list.append(pygltflib.Accessor(bufferView=uv_bv, componentType=5126,
                    count=num_verts, type="VEC2"))

    if has_skeleton:
        joints_acc = len(acc_list)
        acc_list.append(pygltflib.Accessor(bufferView=joints_bv, componentType=5121,
                        count=num_verts, type="VEC4"))
        weights_acc = len(acc_list)
        acc_list.append(pygltflib.Accessor(bufferView=weights_bv, componentType=5126,
                        count=num_verts, type="VEC4"))
        ibm_acc = len(acc_list)
        acc_list.append(pygltflib.Accessor(bufferView=ibm_bv, componentType=5126,
                        count=num_bones, type="MAT4"))

    # ── Mesh primitives ──────────────────────────────────────────────────
    attrs = pygltflib.Attributes(POSITION=pos_acc, NORMAL=norm_acc, TEXCOORD_0=uv_acc)
    if has_skeleton:
        attrs.JOINTS_0 = joints_acc
        attrs.WEIGHTS_0 = weights_acc

    primitives = [pygltflib.Primitive(attributes=attrs, indices=0, material=0)]
    if hair_idx_acc is not None:
        primitives.append(pygltflib.Primitive(attributes=attrs, indices=hair_idx_acc, material=1))

    # ── Nodes: [mesh_node, bone_0, bone_1, ...] ─────────────────────────
    nodes = []
    if has_skeleton:
        root_bone_nodes = [i + 1 for i, b in enumerate(bones) if b["parent"] == -1]
        nodes.append(pygltflib.Node(mesh=0, skin=0, children=root_bone_nodes))
        for i, bone in enumerate(bones):
            px, py, pz = wow_to_gltf_pos(*bone["pivot"])
            if bone["parent"] >= 0:
                ppx, ppy, ppz = wow_to_gltf_pos(*bones[bone["parent"]]["pivot"])
                tx, ty, tz = px - ppx, py - ppy, pz - ppz
            else:
                tx, ty, tz = px, py, pz
            children = [j + 1 for j, b in enumerate(bones) if b["parent"] == i]
            node = pygltflib.Node(name=f"Bone_{i}", translation=[tx, ty, tz],
                                  rotation=[0, 0, 0, 1], scale=[1, 1, 1])
            if children:
                node.children = children
            nodes.append(node)
    else:
        nodes.append(pygltflib.Node(mesh=0))

    # ── Skin ─────────────────────────────────────────────────────────────
    skins = []
    if has_skeleton:
        first_root = next((i + 1 for i, b in enumerate(bones) if b["parent"] == -1), 1)
        skins.append(pygltflib.Skin(
            joints=list(range(1, num_bones + 1)),
            inverseBindMatrices=ibm_acc,
            skeleton=first_root))

    # ── Animations ───────────────────────────────────────────────────────
    gltf_animations = []
    if has_skeleton and sequences:
        for seq in sequences:
            if seq["id"] not in WANTED_ANIMATION_IDS or seq["variation"] != 0:
                continue
            anim_name = WANTED_ANIMATION_IDS[seq["id"]]
            seq_idx = seq["index"]
            channels = []
            samplers = []

            for bone_idx, bone in enumerate(bones):
                joint_node_idx = bone_idx + 1

                # ── Rotation channel ──
                if seq_idx in bone["rotation"]:
                    track = bone["rotation"][seq_idx]
                    n_kf = min(len(track["timestamps"]), len(track["values"]))
                    if n_kf >= 1:
                        ts = np.array([t / 1000.0 for t in track["timestamps"][:n_kf]], dtype=np.float32)
                        vals = []
                        for qx, qy, qz, qw in track["values"][:n_kf]:
                            gx, gy, gz, gw = decompress_quat(qx, qy, qz, qw)
                            vals.extend([gx, gy, gz, gw])
                        val_arr = np.array(vals, dtype=np.float32)

                        ts_bvi = len(bv_list)
                        ts_off = append_bin(ts.tobytes())
                        bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=ts_off, byteLength=n_kf * 4))
                        val_bvi = len(bv_list)
                        val_off = append_bin(val_arr.tobytes())
                        bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=val_off, byteLength=n_kf * 16))

                        ts_ai = len(acc_list)
                        acc_list.append(pygltflib.Accessor(bufferView=ts_bvi, componentType=5126,
                                        count=n_kf, type="SCALAR",
                                        max=[float(ts.max())], min=[float(ts.min())]))
                        val_ai = len(acc_list)
                        acc_list.append(pygltflib.Accessor(bufferView=val_bvi, componentType=5126,
                                        count=n_kf, type="VEC4"))

                        si = len(samplers)
                        samplers.append(pygltflib.AnimationSampler(input=ts_ai, output=val_ai, interpolation="LINEAR"))
                        channels.append(pygltflib.AnimationChannel(sampler=si,
                                        target=pygltflib.AnimationChannelTarget(node=joint_node_idx, path="rotation")))

                # ── Translation channel ──
                if seq_idx in bone["translation"]:
                    track = bone["translation"][seq_idx]
                    n_kf = min(len(track["timestamps"]), len(track["values"]))
                    if n_kf >= 1:
                        # Compute pivot offset for this bone
                        px, py, pz = wow_to_gltf_pos(*bone["pivot"])
                        if bone["parent"] >= 0:
                            ppx, ppy, ppz = wow_to_gltf_pos(*bones[bone["parent"]]["pivot"])
                            poff = (px - ppx, py - ppy, pz - ppz)
                        else:
                            poff = (px, py, pz)

                        ts = np.array([t / 1000.0 for t in track["timestamps"][:n_kf]], dtype=np.float32)
                        vals = []
                        for tvx, tvy, tvz in track["values"][:n_kf]:
                            gx, gy, gz = wow_to_gltf_pos(tvx, tvy, tvz)
                            vals.extend([poff[0] + gx, poff[1] + gy, poff[2] + gz])
                        val_arr = np.array(vals, dtype=np.float32)

                        ts_bvi = len(bv_list)
                        ts_off = append_bin(ts.tobytes())
                        bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=ts_off, byteLength=n_kf * 4))
                        val_bvi = len(bv_list)
                        val_off = append_bin(val_arr.tobytes())
                        bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=val_off, byteLength=n_kf * 12))

                        ts_ai = len(acc_list)
                        acc_list.append(pygltflib.Accessor(bufferView=ts_bvi, componentType=5126,
                                        count=n_kf, type="SCALAR",
                                        max=[float(ts.max())], min=[float(ts.min())]))
                        val_ai = len(acc_list)
                        acc_list.append(pygltflib.Accessor(bufferView=val_bvi, componentType=5126,
                                        count=n_kf, type="VEC3"))

                        si = len(samplers)
                        samplers.append(pygltflib.AnimationSampler(input=ts_ai, output=val_ai, interpolation="LINEAR"))
                        channels.append(pygltflib.AnimationChannel(sampler=si,
                                        target=pygltflib.AnimationChannelTarget(node=joint_node_idx, path="translation")))

            if channels:
                gltf_animations.append(pygltflib.Animation(
                    name=anim_name, channels=channels, samplers=samplers))
                print(f"  Animation '{anim_name}': {len(channels)} channels, {seq['duration']}ms")

    # ── Assemble glTF ────────────────────────────────────────────────────
    gltf = pygltflib.GLTF2(
        scene=0,
        scenes=[pygltflib.Scene(nodes=[0])],
        nodes=nodes,
        meshes=[pygltflib.Mesh(primitives=primitives)],
        skins=skins,
        animations=gltf_animations,
        accessors=acc_list,
        bufferViews=bv_list,
        buffers=[pygltflib.Buffer(byteLength=len(bin_data))],
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

    gltf.set_binary_blob(bytes(bin_data))
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

    # Parse bones and animations
    print("\n  Parsing animation sequences...")
    m2_sequences = parse_m2_sequences(m2_data)
    print(f"  Found {len(m2_sequences)} animation sequences")
    for seq in m2_sequences:
        if seq["id"] in WANTED_ANIMATION_IDS and seq["variation"] == 0:
            print(f"    {WANTED_ANIMATION_IDS[seq['id']]}: seq_idx={seq['index']}, {seq['duration']}ms")

    print("  Parsing bones...")
    m2_bones = parse_m2_bones(m2_data)
    print(f"  Found {len(m2_bones)} bones")

    # Determine geoset filter
    geoset_filter = DEFAULT_GEOSETS.get(model_path)
    if geoset_filter:
        print(f"\nUsing geoset filter: {sorted(geoset_filter)}")
    else:
        print("\nNo geoset filter defined, including all submeshes")

    # Build glTF
    print("Building glTF...")
    gltf = build_glb(m2_vertices, local_to_global, indices, submeshes, texture_pngs, geoset_filter,
                      bones=m2_bones, sequences=m2_sequences)

    # Save
    print(f"Saving to {output_path}...")
    gltf.save(str(output_path))
    file_size = output_path.stat().st_size
    print(f"Done! Output: {output_path} ({file_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
