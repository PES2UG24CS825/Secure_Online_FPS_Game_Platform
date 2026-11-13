#!/usr/bin/env python3
"""
SecureFPS: tools/validate_glb.py
Validates binary GLB 3D model files against glTF 2.0 binary specifications:
1. Header magic: 'glTF' (0x46546C67)
2. Format version: 2
3. Declared length equals actual file byte size
4. Chunk 0 type: 'JSON' (0x4E4F534A)
5. No UTF-8 replacement corruption bytes (EF BF BD) near header
6. Parses JSON chunk to list skeleton bones, animation clips, and bounding-box height.
"""

import json
import os
import struct
import sys


def validate_glb(file_path):
    """
    Validates a single GLB file and extracts metadata.
    Returns dict with validation status and diagnostics.
    """
    result = {
        "file": file_path,
        "valid": False,
        "error": None,
        "magic": None,
        "version": None,
        "declared_length": None,
        "actual_length": None,
        "chunk0_type": None,
        "bones": [],
        "animations": [],
        "height": None,
    }

    if not os.path.exists(file_path):
        result["error"] = f"File not found: {file_path}"
        return result

    try:
        with open(file_path, "rb") as f:
            data = f.read()
    except Exception as exc:
        result["error"] = f"Could not read file: {exc}"
        return result

    result["actual_length"] = len(data)

    if len(data) < 20:
        result["error"] = f"File is truncated: {len(data)} bytes (minimum 20 bytes required for GLB header)"
        return result

    # Check for UTF-8 replacement byte sequence (EF BF BD) near header
    header_check_len = min(64, len(data))
    if b"\xef\xbf\xbd" in data[:header_check_len]:
        result["error"] = (
            "Detected UTF-8 replacement bytes (EF BF BD) near header. "
            "File was corrupted by a text-mode copy or git filter."
        )
        return result

    try:
        magic, version, declared_length = struct.unpack("<4sII", data[:12])
        result["magic"] = magic.decode("ascii", errors="replace")
        result["version"] = version
        result["declared_length"] = declared_length
    except struct.error as exc:
        result["error"] = f"Invalid GLB binary header structure: {exc}"
        return result

    if magic != b"glTF":
        result["error"] = f"Invalid magic bytes: expected b'glTF', got {magic!r}"
        return result

    if version != 2:
        result["error"] = f"Unsupported glTF version: expected 2, got {version}"
        return result

    if declared_length != len(data):
        result["error"] = (
            f"Length mismatch: header declares {declared_length} bytes, "
            f"actual file size is {len(data)} bytes"
        )
        return result

    # First chunk (JSON)
    chunk0_len, chunk0_type = struct.unpack("<I4s", data[12:20])
    result["chunk0_type"] = chunk0_type.decode("ascii", errors="replace")

    if chunk0_type != b"JSON":
        result["error"] = f"Chunk 0 must be 'JSON', got {chunk0_type!r}"
        return result

    chunk0_data_end = 20 + chunk0_len
    if chunk0_data_end > len(data):
        result["error"] = "Chunk 0 extends beyond file length"
        return result

    try:
        chunk0_bytes = data[20:chunk0_data_end]
        gltf = json.loads(chunk0_bytes.decode("utf-8"))
    except Exception as exc:
        result["error"] = f"Failed to parse GLB JSON chunk: {exc}"
        return result

    # Extract bones
    nodes = gltf.get("nodes", [])
    bone_names = []
    skins = gltf.get("skins", [])
    joint_indices = set()
    for s in skins:
        joint_indices.update(s.get("joints", []))

    if joint_indices:
        for idx in sorted(joint_indices):
            if idx < len(nodes):
                bone_names.append(nodes[idx].get("name", f"joint_{idx}"))
    else:
        # Fallback heuristic: check for node names matching common bone patterns
        for n in nodes:
            name = n.get("name", "")
            if any(k in name.lower() for k in ["hips", "spine", "head", "hand", "arm", "leg", "foot", "mixamorig"]):
                bone_names.append(name)

    result["bones"] = bone_names

    # Extract animation clip names
    anims = gltf.get("animations", [])
    result["animations"] = [a.get("name", f"clip_{i}") for i, a in enumerate(anims)]

    # Compute bounding box height from POSITION accessors
    accessors = gltf.get("accessors", [])
    min_y = float("inf")
    max_y = float("-inf")
    found_pos = False

    for acc in accessors:
        if acc.get("type") == "VEC3" and "max" in acc and "min" in acc:
            mn = acc["min"]
            mx = acc["max"]
            if len(mn) >= 2 and len(mx) >= 2:
                # y is index 1
                min_y = min(min_y, mn[1])
                max_y = max(max_y, mx[1])
                found_pos = True

    if found_pos and max_y > min_y:
        result["height"] = round(max_y - min_y, 3)

    result["valid"] = True
    return result


def main():
    default_files = [
        "frontend/public/games/three-fps/models/Soldier.glb",
        "frontend/public/games/three-fps/models/FemaleOperator.glb"
    ]
    target_files = sys.argv[1:] if len(sys.argv) > 1 else default_files

    all_valid = True
    print("=" * 70)
    print("SecureFPS: GLB 3D Asset Binary Validator")
    print("=" * 70)

    for path in target_files:
        print(f"\nTarget: {path}")
        res = validate_glb(path)
        if res["valid"]:
            print("  Status:          [OK] Valid glTF 2.0 Binary")
            print(f"  File Size:       {res['actual_length']:,} bytes")
            print(f"  Magic/Version:   {res['magic']} v{res['version']}")
            print(f"  Bones Found:     {len(res['bones'])} bones ({', '.join(res['bones'][:8])}...)")
            print(f"  Animation Clips: {len(res['animations'])} clips ({', '.join(res['animations']) if res['animations'] else 'None'})")
            print(f"  BBox Height:     {res['height']} m" if res['height'] is not None else "  BBox Height:     Not calculated")
        else:
            all_valid = False
            print("  Status:          [CORRUPTED] Validation Failed")
            print(f"  Error:           {res['error']}")
            if res["actual_length"] is not None:
                print(f"  Actual Size:     {res['actual_length']:,} bytes")
            if res["declared_length"] is not None:
                print(f"  Declared Size:   {res['declared_length']:,} bytes")

    print("\n" + "=" * 70)
    if all_valid:
        print("SUMMARY: All GLB assets passed binary validation.")
        sys.exit(0)
    else:
        print("SUMMARY: One or more GLB assets are corrupted or missing.")
        sys.exit(1)


if __name__ == "__main__":
    main()
