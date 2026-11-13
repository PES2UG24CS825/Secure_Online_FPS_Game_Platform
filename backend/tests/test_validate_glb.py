"""
Unit tests for GLB binary asset validation tooling (Requirement 1, 12).
Tests tools/validate_glb.py on valid glTF 2.0 binaries, corrupted byte sequences,
length mismatches, and actual model assets.
"""

import json
import os
import struct
import tempfile
import unittest

from tools.validate_glb import validate_glb


class TestGLBValidator(unittest.TestCase):
    def _create_minimal_glb(self, gltf_dict, corrupt_magic=False, corrupt_utf8=False, length_mismatch=False):
        json_bytes = json.dumps(gltf_dict).encode("utf-8")
        # Pad JSON chunk to 4-byte boundary with spaces
        padding = (4 - (len(json_bytes) % 4)) % 4
        json_bytes += b" " * padding

        chunk0_len = len(json_bytes)
        chunk0_type = b"JSON"

        total_length = 12 + 8 + chunk0_len
        magic = b"glTF" if not corrupt_magic else b"NOPE"
        version = 2

        if length_mismatch:
            header_length = total_length + 100
        else:
            header_length = total_length

        header = struct.pack("<4sII", magic, version, header_length)
        chunk0_header = struct.pack("<I4s", chunk0_len, chunk0_type)

        data = header + chunk0_header + json_bytes

        if corrupt_utf8:
            # Insert EF BF BD at byte 24
            data = data[:24] + b"\xef\xbf\xbd" + data[27:]

        return data

    def test_valid_minimal_glb_passes(self):
        gltf = {
            "asset": {"version": "2.0"},
            "nodes": [
                {"name": "Hips"},
                {"name": "Spine"},
                {"name": "Head"},
                {"name": "RightHand"},
                {"name": "LeftHand"},
            ],
            "skins": [
                {"joints": [0, 1, 2, 3, 4]}
            ],
            "animations": [
                {"name": "idle"},
                {"name": "walk"},
                {"name": "fire"},
            ],
            "accessors": [
                {
                    "type": "VEC3",
                    "min": [-0.5, 0.0, -0.2],
                    "max": [0.5, 1.82, 0.2],
                }
            ]
        }
        data = self._create_minimal_glb(gltf)
        with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        try:
            res = validate_glb(tmp_path)
            self.assertTrue(res["valid"])
            self.assertIsNone(res["error"])
            self.assertEqual(res["magic"], "glTF")
            self.assertEqual(res["version"], 2)
            self.assertEqual(res["actual_length"], len(data))
            self.assertEqual(res["bones"], ["Hips", "Spine", "Head", "RightHand", "LeftHand"])
            self.assertEqual(res["animations"], ["idle", "walk", "fire"])
            self.assertEqual(res["height"], 1.82)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def test_corrupted_utf8_replacement_bytes_rejected(self):
        gltf = {"asset": {"version": "2.0"}}
        data = self._create_minimal_glb(gltf, corrupt_utf8=True)
        with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        try:
            res = validate_glb(tmp_path)
            self.assertFalse(res["valid"])
            self.assertIn("EF BF BD", res["error"])
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def test_invalid_magic_rejected(self):
        gltf = {"asset": {"version": "2.0"}}
        data = self._create_minimal_glb(gltf, corrupt_magic=True)
        with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        try:
            res = validate_glb(tmp_path)
            self.assertFalse(res["valid"])
            self.assertIn("Invalid magic", res["error"])
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def test_length_mismatch_rejected(self):
        gltf = {"asset": {"version": "2.0"}}
        data = self._create_minimal_glb(gltf, length_mismatch=True)
        with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        try:
            res = validate_glb(tmp_path)
            self.assertFalse(res["valid"])
            self.assertIn("Length mismatch", res["error"])
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def test_actual_repo_models_detected_as_corrupted(self):
        for path in [
            "frontend/public/games/three-fps/models/Soldier.glb",
            "frontend/public/games/three-fps/models/FemaleOperator.glb"
        ]:
            if os.path.exists(path):
                res = validate_glb(path)
                self.assertFalse(res["valid"])
                self.assertIsNotNone(res["error"])


if __name__ == "__main__":
    unittest.main()
