# Credits

Wee Wonderer is made by [Samantha Lee](https://samanthamlee.com). It is built on the work
below. The in-app Credits card (`src/ui/credits.ts`) says the same more briefly; keep
the two in step.

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
