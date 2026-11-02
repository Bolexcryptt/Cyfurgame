# Scene texture assets

The shared Three.js scene loads these 1K JPG PBR maps from `assets/pbr/`:

- `Rock035` by ambientCG for the floating-island keel and loose rock meshes: color, OpenGL normal, and roughness maps.
- `Concrete034` by ambientCG for the stone platform, floor tiles, pillars, and ruin stone: color, OpenGL normal, and roughness maps.

Both source assets are released under ambientCG's CC0 license:

- https://ambientcg.com/view?id=Rock035
- https://ambientcg.com/view?id=Concrete034
- https://docs.ambientcg.com/license/

The maps use the 1K JPG downloads and are shared across scene materials to limit texture memory. Existing geometry, floor cracks, and layout-specific level objects remain in the shared renderer.
