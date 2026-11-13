# SecureFPS: 3D Character Asset Pipeline & Model Specification

## 1. Asset Overview & Model Sources

SecureFPS Three.js tactical arena (`frontend/public/games/three-fps/`) is designed to load realistic adult human tactical operator 3D models with glTF 2.0 binary (`.glb`) rigging and animation:

| Model Asset | Target Role | Height / Scale | Rigging Standard | Recommended Source & License |
|---|---|---|---|---|
| `models/Soldier.glb` | TaskForce Ghost / Male Assault Operator | 1.82 m (Scale 1.0) | Mixamo / Humanoid Standard (`mixamorig*` hierarchy, Root, Hips, Spine, RightHand, LeftHand, etc.) | Mixamo (Adobe free license) / Sketchfab (CC-BY 4.0 standard tactical operator). |
| `models/FemaleOperator.glb` | Valkyrie / Female Tactical Recon | 1.74 m (Scale 0.95) | Mixamo / Humanoid Standard (`mixamorig*` hierarchy) | Mixamo (Adobe free license) / Sketchfab (CC-BY 4.0 standard female combat operator). |

---

## 2. Animation Clip Mapping

The animation system (`TacticalOperator.js`) maps animation clips by regex and substring matching, allowing models with various naming conventions to blend seamlessly:

| Logical Action | Supported Clip Names / Substrings | AnimationMixer Behavior |
|---|---|---|
| **Idle** | `idle`, `rifle_idle`, `combat_idle`, `standing_idle` | Looping cross-fade blend when speed $\le 0.1$ m/s |
| **Walk** | `walk`, `walking`, `rifle_walk`, `patrol` | Looping playback scaled to locomotion velocity ($0.1 < \text{speed} < 3.5$) |
| **Run / Sprint** | `run`, `running`, `jog`, `sprint`, `rifle_run` | Looping playback when $\text{speed} \ge 3.5$ m/s |
| **Shoot / Fire** | `fire`, `shoot`, `rifle_fire`, `shot` | One-shot burst playback with upper-body priority |
| **Reload** | `reload`, `magazine_reload`, `tactical_reload` | One-shot clamp-when-finished action (2.2s duration) |
| **Hit Reaction** | `hit`, `flinch`, `damage`, `impact` | Rapid one-shot perturbation of spine and torso |
| **Death** | `death`, `die`, `fall`, `collapse` | One-shot clamp-when-finished action stopping movement |

---

## 3. Why Text-Mode Copy Corrupts GLB Files

GLB is a binary container format consisting of:
1. A 12-byte header (`magic: glTF`, `version: 2`, `length: total_bytes`).
2. A JSON chunk (`chunkLength`, `chunkType: JSON`, UTF-8 JSON text).
3. A binary buffer chunk (`chunkLength`, `chunkType: BIN\x00`, vertex buffers, normals, animation keyframes, skins).

When GLB files are edited, transferred, or committed in text mode without `.gitattributes`, text decoders encounter invalid UTF-8 byte sequences in the binary chunk and replace them with the 3-byte Unicode replacement character `\ufffd` (`0xEF 0xBF 0xBD`). This corrupts both the declared byte length and the chunk offsets, causing standard loaders to crash.

### Prevention via `.gitattributes`
SecureFPS enforces binary storage for all 3D and raster assets in `.gitattributes`:
```gitattributes
*.glb binary
*.gltf text
*.png binary
*.jpg binary
*.jpeg binary
*.webp binary
```

---

## 4. How to Validate & Swap Real Models

To replace corrupted or missing models with fresh rigged assets:

1. Obtain a glTF 2.0 binary `.glb` model with embedded humanoid skeleton and animations (e.g. exported from Blender or Mixamo with glTF binary settings).
2. Place the models into:
   - `frontend/public/games/three-fps/models/Soldier.glb`
   - `frontend/public/games/three-fps/models/FemaleOperator.glb`
3. Validate the binary header, bones, animation clips, and bounding box:
   ```bash
   python tools/validate_glb.py
   # OR
   npm run validate:glb
   ```
4. If validation succeeds (`[OK] Valid glTF 2.0 Binary`), the Three.js game engine will automatically load and instantiate the rigged mesh using `THREE.GLTFLoader` and `THREE.SkeletonUtils.clone()`.
5. If models are missing or corrupted, the engine automatically activates the high-fidelity procedural anatomical tactical operator rig and displays a clear notice in the developer HUD.

---

## 5. Manual QA Checklist

When testing character models in-game:

- [ ] **Startup Verification**: Open browser console. Confirm clear log indicating either valid GLB load or procedural anatomical fallback notice.
- [ ] **Height & Proportion Check**: Character stands with feet touching ground level ($y = 0$). Eye height is approximately 1.70–1.75 m.
- [ ] **Idle State**: Character displays natural breathing bob and two-handed weapon grip (right hand on trigger, left hand on handguard).
- [ ] **Walk & Run**: Locomotion animates smoothly between 0 and 6 m/s without foot-sliding.
- [ ] **Aim Pitch & Yaw**: Torso and head rotate vertically to follow target crosshair elevation ($[-60^\circ, +60^\circ]$).
- [ ] **Weapon Firing**: Muzzle flash starburst, dynamic point light, recoil kick, and brass shell casing ejection occur on each shot.
- [ ] **Hit & Death**: Character flinches on bullet impact and collapses upon health reaching 0.
- [ ] **Hitbox Registration**: Raycast hitboxes (head, torso, limbs) follow the skeletal joints accurately.
- [ ] **Multiplayer Synchronization**: Remote players instantiate using identical character factories and display correct team colors and weapon types.
