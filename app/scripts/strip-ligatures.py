"""Copy Pixelify Sans into assets/fonts with its ligatures switched off.

Pixelify Sans draws "fi" and "fl" as ligatures that read as other letters
("Find in files" shows as "Find in Ales"). CSS can turn them off on the web,
but React Native on iOS ignores `fontVariant: ['no-common-ligatures']`, so the
fix lives in the font files: the liga and dlig features keep their names but
lose their lookups.

Needs fontTools (pip install fonttools). Run from app/:
    python3 scripts/strip-ligatures.py
"""

from pathlib import Path

from fontTools.ttLib import TTFont

SOURCE = Path('node_modules/@expo-google-fonts/pixelify-sans')
TARGET = Path('assets/fonts')
WEIGHTS = ['400Regular', '500Medium', '600SemiBold']
LIGATURE_FEATURES = {'liga', 'dlig', 'clig'}


def strip(name: str) -> None:
    font = TTFont(SOURCE / name / f'PixelifySans_{name}.ttf')
    for record in font['GSUB'].table.FeatureList.FeatureRecord:
        if record.FeatureTag in LIGATURE_FEATURES:
            record.Feature.LookupListIndex = []
            record.Feature.LookupCount = 0
    font.save(TARGET / f'PixelifySans_{name}.ttf')


if __name__ == '__main__':
    TARGET.mkdir(parents=True, exist_ok=True)
    for weight in WEIGHTS:
        strip(weight)
        print(f'wrote {TARGET}/PixelifySans_{weight}.ttf')
