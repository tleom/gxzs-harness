"""Package readable OpenType/TrueType fonts for a private sandbox image build.

Run on the font-owning computer. Font bytes are never added to this repository.
The manifest records embedding flags; it does not rewrite font licensing flags.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile

from fontTools.ttLib import TTCollection, TTFont, TTLibError


def inspect_font(source):
    collection = TTCollection(source, lazy=True) if source.suffix.lower() in {'.ttc', '.otc'} else None
    fonts = collection.fonts if collection else [TTFont(source, lazy=True)]
    try:
        faces = []
        for font in fonts:
            names = font['name']
            family = names.getDebugName(16) or names.getDebugName(1)
            faces.append({'family': family, 'embeddingFlags': int(font['OS/2'].fsType) if 'OS/2' in font else None})
        return faces
    finally:
        for font in fonts:
            font.close()


def package(roots, output):
    entries, skipped, unique = [], [], {}
    for root in roots:
        if not root.is_dir():
            continue
        for source in sorted(root.rglob('*')):
            if not source.is_file() or source.suffix.lower() not in {'.ttf', '.otf', '.ttc', '.otc', '.fon'}:
                continue
            try:
                faces = inspect_font(source)
                digest = hashlib.sha256(source.read_bytes()).hexdigest()
                name = digest + source.suffix.lower()
                unique.setdefault(name, source)
                entries.append({'sourceName': source.name, 'asset': 'fonts/' + name, 'sha256': digest,
                                'bytes': source.stat().st_size, 'faces': faces})
            except (OSError, TTLibError, KeyError, ValueError) as error:
                skipped.append({'sourceName': source.name, 'reason': type(error).__name__})
    if not entries:
        raise ValueError('No readable OpenType or TrueType fonts were found')
    generation = hashlib.sha256('\n'.join(sorted(unique)).encode()).hexdigest()
    manifest = {'schema': 1, 'generation': generation, 'files': entries, 'skipped': skipped,
                'uniqueFiles': len(unique), 'totalBytes': sum(item.stat().st_size for item in unique.values())}
    encoded = json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(output, 'w:gz', compresslevel=3) as archive:
        info = tarfile.TarInfo('manifest.json')
        info.size, info.mode = len(encoded), 0o644
        archive.addfile(info, io.BytesIO(encoded))
        for name, source in sorted(unique.items()):
            info = tarfile.TarInfo('fonts/' + name)
            info.size, info.mode = source.stat().st_size, 0o644
            with source.open('rb') as stream:
                archive.addfile(info, stream)
    output.with_suffix('.manifest.json').write_bytes(encoded)
    return {'files': len(entries), 'uniqueFiles': len(unique), 'faces': sum(len(item['faces']) for item in entries),
            'skipped': len(skipped), 'fontBytes': manifest['totalBytes'], 'archiveBytes': output.stat().st_size,
            'generation': generation}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, action='append')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    roots = args.root or [Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts',
                         Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft/Windows/Fonts']
    print(json.dumps(package(roots, args.output), ensure_ascii=False))
