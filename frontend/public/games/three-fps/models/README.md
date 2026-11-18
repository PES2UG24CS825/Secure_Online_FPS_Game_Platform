# Operator asset provenance

The restored binary files have the same glTF JSON manifests as the previously damaged copies.

- `Soldier.glb` is the [Three.js Soldier example asset](https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/Soldier.glb), the Mixamo Vanguard rig.
- `FemaleOperator.glb` is the [Three.js Xbot example asset](https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/Xbot.glb), retained as a historical asset. The game uses Valkyrie in that slot.
- Valkyrie uses the repository's procedural tactical character meshes and materials in `js/TacticalOperator.js` and `js/TextureGenerator.js`, covered by the root MIT license. No third-party female character or texture pack is used.

[Adobe Mixamo usage information](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html).

## Remaining combat assets

Vanguard has authored idle, walk, and run clips. Valkyrie's movement is procedural. Both operators use runtime arm positioning for the weapon grip and procedural recoil and death behavior. Authored `Fire`, `Reload`, `Hit`, and `Death` clips for Vanguard are still absent. A skinned Valkyrie model and compatible authored clips would be needed for a fully authored animation set.
