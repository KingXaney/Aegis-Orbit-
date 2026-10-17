# Spacecraft models

| File | Source | Credit |
|---|---|---|
| `iss.glb` | [NASA 3D Resources: International Space Station (ISS) (B)](https://science.nasa.gov/3d-resources/international-space-station-iss-b/) | NASA/Michael D. Carbajal |
| `gpm.glb` | [NASA 3D Resources: Global Precipitation Measurement](https://science.nasa.gov/3d-resources/global-precipitation-measurement/) | NASA/Christopher R. Meaney |

NASA 3D Resources models are free to use; see NASA's media usage guidelines
(<https://www.nasa.gov/nasa-brand-center/images-and-media>). Use of the models does not imply NASA
endorsement.

Both files are the NASA downloads processed by `../../scripts/prepare_models.py`, which moves them
into metres in the globe's body frame (x along velocity, y cross-track, z zenith). For the ISS it
also removes stray nodes and sets ISS material colours. The mesh data is unchanged.
