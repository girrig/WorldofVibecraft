#!/usr/bin/env python3
"""
Batch extract WoW 3.3.5a M2 doodad models to glTF (.glb) format.

Reads the doodad placement JSON (from extract_terrain.py), finds all unique M2 model
paths, extracts each from MPQ archives, and converts to static GLB meshes.

Usage:
    python extract_doodads.py
    python extract_doodads.py --data-dir "C:\Path\To\Data" --output-dir "../client/public/assets/models"
"""

import argparse
import json
import struct
import sys
import os
import numpy as np
from pathlib import Path
from collections import Counter
import io

# Reuse core functions from extract_model.py
from extract_model import (
    StormLib, extract_from_mpq, MPQ_LOAD_ORDER, STORMLIB_DLL,
    read_m2array, parse_m2_vertices, parse_m2_textures,
    parse_m2_texture_combos, parse_skin, blp_to_png_bytes, wow_to_gltf_pos,
)

import pygltflib

SCRIPT_DIR = Path(__file__).parent
DEFAULT_DATA_DIR = Path(r"C:\Program Files\Ascension Launcher\resources\epoch_live\Data")
DEFAULT_DOODAD_JSON = SCRIPT_DIR / ".." / "client" / "public" / "assets" / "terrain" / "northshire_doodads.json"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / ".." / "client" / "public" / "assets" / "models"


def sanitize_model_name(wow_path):
    """Convert WoW model path to a GLB filename.
    Handles collisions via the caller (appends counter if needed).
    """
    basename = wow_path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return basename.replace(".m2", ".glb").lower()


def build_doodad_glb(m2_vertices, local_to_global, indices, submeshes,
                     texture_pngs, sub_to_tex):
    """
    Build a static GLB from parsed M2 + skin data.
    No skeleton, no animations — one primitive per texture group.

    texture_pngs: dict mapping texture_index → PNG bytes
    sub_to_tex:   dict mapping submesh_index → texture_index (or -1 for no texture)
    """
    # Group submeshes by texture index
    tex_groups = {}  # tex_idx → list of submesh indices
    for si, sub in enumerate(submeshes):
        if sub["level"] != 0:
            continue
        tex_idx = sub_to_tex.get(si, -1)
        if tex_idx not in tex_groups:
            tex_groups[tex_idx] = []
        tex_groups[tex_idx].append(si)

    if not tex_groups:
        return None

    def pad4(b):
        rem = len(b) % 4
        return b + b"\x00" * (4 - rem) if rem else b

    bin_data = bytearray()

    def append_bin(data_bytes):
        offset = len(bin_data)
        bin_data.extend(pad4(data_bytes))
        return offset

    bv_list = []
    acc_list = []
    primitives = []
    materials = []
    images = []
    textures = []
    samplers = []

    # One sampler shared by all textures
    sampler_added = False

    # Sorted so output is deterministic
    for tex_idx in sorted(tex_groups.keys()):
        sub_indices = tex_groups[tex_idx]

        # Collect geometry for this texture group
        all_positions = []
        all_normals = []
        all_uvs = []
        all_tri_indices = []
        global_to_output = {}
        output_idx = 0

        for si in sub_indices:
            sub = submeshes[si]
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
                all_tri_indices.append(global_to_output[global_idx])

        if output_idx == 0:
            continue

        positions = np.array(all_positions, dtype=np.float32)
        normals_arr = np.array(all_normals, dtype=np.float32)
        uvs = np.array(all_uvs, dtype=np.float32)
        idx_type = np.uint16 if output_idx < 65536 else np.uint32
        idx_arr = np.array(all_tri_indices, dtype=idx_type)
        num_verts = len(positions)

        # Append to binary buffer
        idx_offset = append_bin(idx_arr.tobytes())
        pos_offset = append_bin(positions.tobytes())
        norm_offset = append_bin(normals_arr.tobytes())
        uv_offset = append_bin(uvs.tobytes())

        pos_min = positions.min(axis=0).tolist()
        pos_max = positions.max(axis=0).tolist()
        idx_ct = 5123 if idx_type == np.uint16 else 5125

        # Buffer views for this primitive
        bv_base = len(bv_list)
        bv_list.extend([
            pygltflib.BufferView(buffer=0, byteOffset=idx_offset,
                                 byteLength=len(idx_arr) * idx_arr.itemsize, target=34963),
            pygltflib.BufferView(buffer=0, byteOffset=pos_offset,
                                 byteLength=num_verts * 12, target=34962, byteStride=12),
            pygltflib.BufferView(buffer=0, byteOffset=norm_offset,
                                 byteLength=num_verts * 12, target=34962, byteStride=12),
            pygltflib.BufferView(buffer=0, byteOffset=uv_offset,
                                 byteLength=num_verts * 8, target=34962, byteStride=8),
        ])

        # Accessors
        acc_base = len(acc_list)
        acc_list.extend([
            pygltflib.Accessor(bufferView=bv_base, componentType=idx_ct,
                               count=len(idx_arr), type="SCALAR",
                               max=[int(idx_arr.max())], min=[int(idx_arr.min())]),
            pygltflib.Accessor(bufferView=bv_base + 1, componentType=5126,
                               count=num_verts, type="VEC3", max=pos_max, min=pos_min),
            pygltflib.Accessor(bufferView=bv_base + 2, componentType=5126,
                               count=num_verts, type="VEC3"),
            pygltflib.Accessor(bufferView=bv_base + 3, componentType=5126,
                               count=num_verts, type="VEC2"),
        ])

        # Material for this group
        mat_idx = len(materials)
        tex_png = texture_pngs.get(tex_idx)

        if tex_png is not None:
            tex_bv = len(bv_list)
            bv_list.append(pygltflib.BufferView(buffer=0, byteOffset=append_bin(tex_png),
                                                byteLength=len(tex_png)))
            img_idx = len(images)
            images.append(pygltflib.Image(bufferView=tex_bv, mimeType="image/png"))
            if not sampler_added:
                samplers.append(pygltflib.Sampler(magFilter=9729, minFilter=9987,
                                                  wrapS=10497, wrapT=10497))
                sampler_added = True
            gltf_tex_idx = len(textures)
            textures.append(pygltflib.Texture(source=img_idx, sampler=0))
            materials.append(pygltflib.Material(
                pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
                    baseColorTexture=pygltflib.TextureInfo(index=gltf_tex_idx),
                    metallicFactor=0.0, roughnessFactor=0.8),
                doubleSided=True,
                alphaMode="MASK",
                alphaCutoff=0.5))
        else:
            materials.append(pygltflib.Material(
                pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
                    baseColorFactor=[0.5, 0.5, 0.5, 1.0],
                    metallicFactor=0.0, roughnessFactor=0.8),
                doubleSided=True))

        attrs = pygltflib.Attributes(POSITION=acc_base + 1, NORMAL=acc_base + 2,
                                     TEXCOORD_0=acc_base + 3)
        primitives.append(pygltflib.Primitive(attributes=attrs, indices=acc_base,
                                              material=mat_idx))

    if not primitives:
        return None

    gltf = pygltflib.GLTF2(
        scene=0,
        scenes=[pygltflib.Scene(nodes=[0])],
        nodes=[pygltflib.Node(mesh=0)],
        meshes=[pygltflib.Mesh(primitives=primitives)],
        accessors=acc_list,
        bufferViews=bv_list,
        buffers=[pygltflib.Buffer(byteLength=len(bin_data))],
        materials=materials,
        textures=textures,
        images=images,
        samplers=samplers,
    )

    gltf.set_binary_blob(bytes(bin_data))
    return gltf


def extract_single_doodad(storm, data_dir, wow_model_path):
    """
    Extract a single M2 doodad model and return a pygltflib.GLTF2 object.
    Returns None on failure.
    """
    # Normalize path separators for MPQ
    mpq_path = wow_model_path.replace("/", "\\")

    # Ensure .m2 extension
    if not mpq_path.lower().endswith(".m2"):
        mpq_path += ".m2"

    # Extract M2 file
    m2_data = extract_from_mpq(storm, data_dir, mpq_path)
    if m2_data is None:
        return None

    # Verify magic
    if len(m2_data) < 8 or m2_data[0:4] != b"MD20":
        print(f"    Invalid M2 magic: {m2_data[0:4]}")
        return None

    # Parse vertices
    m2_vertices = parse_m2_vertices(m2_data)
    if not m2_vertices:
        print(f"    No vertices found")
        return None

    # Parse textures and texture lookup table
    m2_textures = parse_m2_textures(m2_data)
    tex_combos = parse_m2_texture_combos(m2_data)

    # Extract .skin file
    skin_mpq_path = mpq_path[:-3] + "00.skin"  # strip .m2, add 00.skin
    skin_data = extract_from_mpq(storm, data_dir, skin_mpq_path)
    if skin_data is None:
        print(f"    No .skin file found at {skin_mpq_path}")
        return None

    try:
        local_to_global, indices, submeshes, batches = parse_skin(skin_data)
    except Exception as e:
        print(f"    Failed to parse .skin: {e}")
        return None

    # Build submesh → texture index mapping from batches + texture combos
    sub_to_tex = {}
    for batch in batches:
        sub_idx = batch["skin_section_index"]
        combo_idx = batch["texture_combo_index"]
        tex_idx = -1
        if combo_idx < len(tex_combos):
            tex_idx = tex_combos[combo_idx]
        sub_to_tex[sub_idx] = tex_idx

    # Extract ALL type-0 textures (not just the first)
    texture_pngs = {}  # tex_index → PNG bytes
    for ti, tex in enumerate(m2_textures):
        if tex["type"] == 0 and tex["filename"]:
            tex_mpq_path = tex["filename"].replace("/", "\\")
            blp_data = extract_from_mpq(storm, data_dir, tex_mpq_path)
            if blp_data:
                png = blp_to_png_bytes(blp_data)
                if png:
                    texture_pngs[ti] = png

    # Build GLB
    gltf = build_doodad_glb(m2_vertices, local_to_global, indices, submeshes,
                            texture_pngs, sub_to_tex)
    return gltf


def main():
    parser = argparse.ArgumentParser(description="Batch extract WoW M2 doodads to GLB")
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR),
                        help="Path to WoW Data directory with MPQ files")
    parser.add_argument("--doodad-json", default=str(DEFAULT_DOODAD_JSON),
                        help="Path to northshire_doodads.json")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR),
                        help="Output base directory for models")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    doodad_json_path = Path(args.doodad_json)
    output_dir = Path(args.output_dir)
    doodad_dir = output_dir / "doodads"
    doodad_dir.mkdir(parents=True, exist_ok=True)

    # Load doodad placement data
    print(f"Loading doodad data from {doodad_json_path}...")
    with open(doodad_json_path) as f:
        doodad_data = json.load(f)

    # Count instances per unique model
    model_counts = Counter()
    for d in doodad_data["doodads"]:
        model_counts[d["model"]] += 1

    unique_models = sorted(model_counts.items(), key=lambda x: -x[1])
    print(f"Found {len(unique_models)} unique M2 models ({sum(model_counts.values())} total instances)")
    print(f"Top 10:")
    for path, count in unique_models[:10]:
        basename = path.rsplit("/", 1)[-1]
        print(f"  {basename}: {count} instances")

    # Initialize StormLib
    print(f"\nLoading StormLib from {STORMLIB_DLL}...")
    storm = StormLib(STORMLIB_DLL)

    # Track filename collisions
    used_filenames = {}  # sanitized name → wow path
    manifest = {"models": {}, "totalExtracted": 0, "totalFailed": 0}
    total_size = 0

    print(f"\n== Extracting {len(unique_models)} doodad models ==\n")

    for i, (wow_path, instance_count) in enumerate(unique_models):
        basename = sanitize_model_name(wow_path)

        # Handle filename collisions
        if basename in used_filenames and used_filenames[basename] != wow_path:
            name, ext = basename.rsplit(".", 1)
            counter = 2
            while f"{name}_{counter}.{ext}" in used_filenames:
                counter += 1
            basename = f"{name}_{counter}.{ext}"

        used_filenames[basename] = wow_path
        glb_path = doodad_dir / basename

        progress = f"[{i+1}/{len(unique_models)}]"
        short_name = wow_path.rsplit("/", 1)[-1]
        print(f"{progress} {short_name} ({instance_count} instances)...")

        try:
            gltf = extract_single_doodad(storm, data_dir, wow_path)
            if gltf is None:
                print(f"  SKIP: extraction failed")
                manifest["totalFailed"] += 1
                continue

            gltf.save(str(glb_path))
            file_size = glb_path.stat().st_size
            total_size += file_size
            print(f"  OK: {file_size / 1024:.1f} KB")

            manifest["models"][wow_path] = {
                "glb": "doodads/" + basename,
                "instances": instance_count,
            }
            manifest["totalExtracted"] += 1

        except Exception as e:
            print(f"  ERROR: {e}")
            manifest["totalFailed"] += 1
            continue

    # Write manifest
    manifest_path = output_dir / "doodad_manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\n== Done ==")
    print(f"  Extracted: {manifest['totalExtracted']}/{len(unique_models)} models")
    print(f"  Failed: {manifest['totalFailed']}")
    print(f"  Total size: {total_size / 1024 / 1024:.1f} MB")
    print(f"  Manifest: {manifest_path}")
    print(f"  Output: {doodad_dir}")


if __name__ == "__main__":
    main()
