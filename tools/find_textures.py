"""Find all Human Male character textures in MPQ archives."""
import sys
sys.path.insert(0, '.')
from extract_model import StormLib, STORMLIB_DLL
from pathlib import Path

storm = StormLib(STORMLIB_DLL)
data_dir = Path(r"C:\Program Files\Ascension Launcher\resources\epoch_live\Data")

mpq_files = sorted(data_dir.glob("*.MPQ"), reverse=True) + sorted(data_dir.glob("*.mpq"), reverse=True)
found = set()

prefix = "Character\\Human\\Male\\"
names = [
    "HumanMaleFaceLower", "HumanMaleFaceUpper",
    "HumanMaleNakedPelvisSkin", "HumanMaleNakedLegsSkin",
    "HumanMaleNakedArmsSkin", "HUMANMALENAKEDTORSOSKIN",
    "HumanMaleSkin", "HumanMaleNakedSkin",
    "HumanMaleScalpLower", "HumanMaleScalpUpper",
    "HumanMaleFaceSkin", "HumanMaleNakedFootSkin",
    "HumanMaleNakedHandSkin", "HumanMaleNakedArmsUpper",
    "HumanMaleNakedArmsLower", "HumanMaleNakedLegsUpper",
    "HumanMaleNakedLegsLower",
]
suffixes = ["00_00.blp", "00_00.BLP", "00_01.blp", "00_01.BLP",
            "00_02.blp", "00_02.BLP", "00.blp", "00.BLP"]

for mpq_path in mpq_files:
    handle = storm.open_archive(mpq_path)
    if not handle:
        continue
    for name in names:
        for suffix in suffixes:
            path = prefix + name + suffix
            if path not in found and storm.has_file(handle, path):
                found.add(path)
                print(f"  {path}  ({mpq_path.name})")
    storm.close_archive(handle)

print(f"\nTotal: {len(found)}")
