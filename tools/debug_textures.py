"""Extract and examine all Human Male skin texture components."""
import sys, io
sys.path.insert(0, '.')
from extract_model import StormLib, STORMLIB_DLL, extract_from_mpq
from pathlib import Path
from PIL import Image

storm = StormLib(STORMLIB_DLL)
data_dir = Path(r"C:\Program Files\Ascension Launcher\resources\epoch_live\Data")
out_dir = Path("../client/assets/models/debug")
out_dir.mkdir(exist_ok=True)

textures = {
    "FaceUpper": "Character\\Human\\Male\\HumanMaleFaceUpper00_00.blp",
    "FaceLower": "Character\\Human\\Male\\HumanMaleFaceLower00_00.blp",
    "Torso": "Character\\Human\\Male\\HUMANMALENAKEDTORSOSKIN00_00.BLP",
    "Pelvis": "Character\\Human\\Male\\HumanMaleNakedPelvisSkin00_00.blp",
    "Skin": "Character\\Human\\Male\\HumanMaleSkin00_00.blp",
}

for name, path in textures.items():
    blp_data = extract_from_mpq(storm, data_dir, path)
    if blp_data:
        img = Image.open(io.BytesIO(blp_data))
        print(f"{name}: {img.size[0]}x{img.size[1]} {img.mode}")
        img.save(out_dir / f"{name}.png")
    else:
        print(f"{name}: NOT FOUND")
