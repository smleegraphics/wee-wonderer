# Credits

Wee Wonderer is made by [Samantha Lee](https://samanthamlee.com). It is built on the work
below. The in-app Credits card (`src/ui/credits.ts`) says the same more briefly; keep
the two in step.

## The characters

**Chibi**: [Free Pack – Chibi Base Mesh (Rigged)](https://sketchfab.com/3d-models/free-pack-chibi-base-mesh-rigged-fed4fb329f224f1594f631eae8d2626b)
by PolyOne Studio, on Sketchfab, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Adapted for this project:
its bones renamed to Mixamo's names and Mixamo animations retargeted onto it
(`context/character-README.md`). Animations from [Mixamo](https://www.mixamo.com) (Adobe).

**Robot**: [RobotExpressive](https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/RobotExpressive)
by Tomás Laulhé (Quaternius), with changes by Don McCurdy, from the three.js examples,
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Credited as thanks; CC0 does
not ask for it.

**Human**: [Animated Human](https://opengameart.org/content/animated-human-low-poly) by
Quaternius, on OpenGameArt, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
(also stated in the download's `License.txt`). Converted from its FBX to GLB in Blender,
with its `ClothedLightSkin` palette as the colour (`context/movement.md`). Credited as thanks.

## The example scans

**Kitchen, Living Room and Counter** are the `kitchen`, `room` and `counter` scenes of the
Mip-NeRF 360 dataset:

> Jonathan T. Barron, Ben Mildenhall, Dor Verbin, Pratul P. Srinivasan, Peter Hedman.
> *Mip-NeRF 360: Unbounded Anti-Aliased Neural Radiance Fields.* CVPR 2022.
> [jonbarron.info/mipnerf360](https://jonbarron.info/mipnerf360/)

Google's [SMERF project page](https://smerf-3d.github.io/) states that the datasets are
released under CC BY 4.0 (the Mip-NeRF 360 page itself states no licence).

The photos were trained into Gaussian splats by **alexmkwizu**, with
[msplat](https://github.com/rayanht/msplat) (Apache 2.0) for 7,000 iterations, and
published in the Hugging Face dataset
[alexmkwizu/gaussian_training_datasets](https://huggingface.co/datasets/alexmkwizu/gaussian_training_datasets)
(`tested_outputs/kitchen.ply`, `room.ply`, `counter.ply`). That dataset adds no terms of its
own: it says each scene "retains the license/terms of its original source". For this site
they were then cleaned of floaters, levelled, cropped and converted to SPZ
(`scripts/clean-scan.mjs`, `context/deploy.md`).

**Curled Up Dog** (`Marishka-clean.spz`) was captured by Samantha Lee.

## Type

[Pixelify Sans](https://fonts.google.com/specimen/Pixelify+Sans) and
[Patrick Hand SC](https://fonts.google.com/specimen/Patrick+Hand+SC), both under the
[SIL Open Font License 1.1](https://openfontlicense.org), served from the app's own build
through Fontsource.

## Software

Built with [three.js](https://threejs.org) (MIT) and
[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) (MIT). The example scans
were converted with [splat-transform](https://github.com/playcanvas/splat-transform)
(PlayCanvas, MIT).
