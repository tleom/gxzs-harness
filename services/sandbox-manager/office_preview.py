"""Convert one supplied Office document in a disposable, offline container."""
import base64
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
import io
import posixpath
from pathlib import Path
import subprocess
import sys
import tempfile
from xml.dom import minidom
from xml.parsers.expat import ExpatError
import zipfile
from xml.etree import ElementTree
from urllib.parse import unquote

MAX_BYTES = 20 * 1024 * 1024
MAX_EXPANDED_BYTES = 100 * 1024 * 1024
MAX_PARTS = 10000
SUFFIXES = {".doc", ".docx", ".docm", ".dotx", ".dotm", ".odt", ".rtf", ".xls", ".xlsx", ".xlsm", ".xlsb", ".xltx", ".xltm", ".ppt", ".pptx", ".pptm", ".ppsx", ".ppsm", ".potx", ".potm"}
WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
XMLNS_NS = 'http://www.w3.org/2000/xmlns/'


def word_child(parent, name):
    return next((node for node in parent.childNodes
                 if node.nodeType == node.ELEMENT_NODE and node.namespaceURI == WORD_NS
                 and node.localName == name), None) if parent is not None else None


def word_children(parent, name):
    return [node for node in parent.childNodes if node.nodeType == node.ELEMENT_NODE
            and node.namespaceURI == WORD_NS and node.localName == name] if parent is not None else []


def word_ancestor(node, name):
    parent = node.parentNode
    while parent is not None:
        if parent.namespaceURI == WORD_NS and parent.localName == name:
            return parent
        parent = parent.parentNode
    return None


def word_attributes(node):
    return {attr.localName: attr.value for attr in node.attributes.values()
            if attr.namespaceURI == WORD_NS} if node is not None else {}


def word_value(node, default=""):
    return node.getAttributeNS(WORD_NS, 'val') if node is not None else default


def xml_set(node, namespace, preferred, key, value):
    bindings = {}
    ancestor = node
    while ancestor is not None and ancestor.nodeType == ancestor.ELEMENT_NODE:
        for attr in ancestor.attributes.values():
            if attr.namespaceURI == XMLNS_NS and attr.prefix == 'xmlns':
                bindings.setdefault(attr.localName, attr.value)
        ancestor = ancestor.parentNode
    prefix = next((name for name, uri in bindings.items() if uri == namespace), None)
    if prefix is None:
        prefix, index = preferred, 0
        while prefix in bindings:
            index += 1
            prefix = preferred + str(index)
        node.setAttributeNS(XMLNS_NS, 'xmlns:' + prefix, namespace)
    node.setAttributeNS(namespace, prefix + ':' + key, str(value))


def word_set(node, key, value):
    if node.prefix:
        node.setAttributeNS(WORD_NS, node.prefix + ':' + key, str(value))
    else:
        xml_set(node, WORD_NS, 'w', key, value)


def word_ensure(parent, name, first=False):
    node = word_child(parent, name)
    if node is None:
        node = parent.ownerDocument.createElementNS(WORD_NS, (parent.prefix + ':' if parent.prefix else '') + name)
        following = None
        if first:
            following = parent.firstChild
        elif parent.localName == 'pPr':
            order = ('pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr '
                     'suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap '
                     'overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd '
                     'snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap '
                     'jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle '
                     'rPr sectPr pPrChange').split()
            following = next((child for child in parent.childNodes if child.namespaceURI == WORD_NS
                              and child.localName in order and order.index(child.localName) > order.index(name)), None)
        parent.insertBefore(node, following)
    return node


def word_number(value, default=0):
    try:
        result = Decimal(value)
        if result.is_finite() and abs(result) <= 2147483647:
            return result
    except (InvalidOperation, TypeError, ValueError):
        pass
    return Decimal(default)


def word_twips(value):
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def merge_indents(current, supplied):
    # start/end and left/right are aliases, including an explicit zero reset.
    layer = dict(supplied)
    for modern, legacy in (('start', 'left'), ('end', 'right')):
        for suffix in ('', 'Chars'):
            if modern + suffix in layer:
                layer[legacy + suffix] = layer.pop(modern + suffix)
    # A new character-based first/hanging setting replaces the opposite kind
    # inherited from a style. Within one layer, hanging takes precedence.
    if word_number(layer.get('hangingChars', '0')):
        layer.update(firstLine='0', firstLineChars='0')
    elif word_number(layer.get('firstLineChars', '0')):
        layer.update(hanging='0', hangingChars='0')
    current.update(layer)


class WordLayout:
    """Resolve only the properties needed by Writer's missing unit importers.

    Nonzero character indents override their distance equivalents across style
    levels; zero clears an inherited character indent, retaining the distance.
    https://learn.microsoft.com/openspecs/office_standards/ms-oi29500/138732dc-507a-4164-af66-808c2fd9f2f9
    """

    def __init__(self, styles, numbering=None):
        self.styles = {node.getAttributeNS(WORD_NS, 'styleId'): node
                       for node in styles.getElementsByTagNameNS(WORD_NS, 'style')} if styles else {}
        self.default_style = next((key for key, node in self.styles.items()
                                   if node.getAttributeNS(WORD_NS, 'type') == 'paragraph'
                                   and node.getAttributeNS(WORD_NS, 'default') in {'1', 'true', 'on'}), '')
        defaults = word_child(styles.documentElement, 'docDefaults') if styles else None
        self.default_ppr = word_child(word_child(defaults, 'pPrDefault'), 'pPr')
        self.default_rpr = word_child(word_child(defaults, 'rPrDefault'), 'rPr')
        self.chains = {}
        self.table_cells = {}
        self.numbers = {node.getAttributeNS(WORD_NS, 'numId'): node
                        for node in numbering.getElementsByTagNameNS(WORD_NS, 'num')} if numbering else {}
        self.abstract_numbers = {node.getAttributeNS(WORD_NS, 'abstractNumId'): node
                                 for node in numbering.getElementsByTagNameNS(WORD_NS, 'abstractNum')} if numbering else {}

    def chain(self, key):
        if key not in self.chains:
            requested = key
            chain, seen = [], set()
            while key in self.styles and key not in seen:
                if len(seen) >= 256:
                    raise ValueError('文档样式继承超过预览范围')
                seen.add(key)
                node = self.styles[key]
                chain.append(node)
                key = word_value(word_child(node, 'basedOn'))
            result = tuple(reversed(chain))
            self.chains[requested] = result
            return result
        return self.chains[key]

    def properties(self, paragraph):
        ppr = word_child(paragraph, 'pPr')
        chain = self.chain(word_value(word_child(ppr, 'pStyle'), self.default_style))
        table_styles = self.table_styles(paragraph)
        paragraph_properties = [self.default_ppr, *(word_child(style, 'pPr') for style in table_styles),
                                *(word_child(style, 'pPr') for style in chain), ppr]
        number = {}
        for node in paragraph_properties:
            numpr = word_child(node, 'numPr')
            for key in ('numId', 'ilvl'):
                value = word_child(numpr, key)
                if value is not None:
                    number[key] = word_value(value)
        num = self.numbers.get(number.get('numId'))
        abstract = self.abstract_numbers.get(word_value(word_child(num, 'abstractNumId')))
        level = number.get('ilvl', '0')
        numbering_level = next((node for node in abstract.childNodes if node.namespaceURI == WORD_NS
                                and node.localName == 'lvl' and node.getAttributeNS(WORD_NS, 'ilvl') == level), None) if abstract else None
        override = next((node for node in num.childNodes if node.namespaceURI == WORD_NS
                         and node.localName == 'lvlOverride' and node.getAttributeNS(WORD_NS, 'ilvl') == level), None) if num else None
        numbering_level = word_child(override, 'lvl') or numbering_level
        ind, spacing, run = {}, {}, {}
        for node in [self.default_rpr, *(word_child(style, 'rPr') for style in [*table_styles, *chain])]:
            for key in ('sz', 'snapToGrid'):
                value = word_child(node, key)
                if value is not None:
                    run[key] = word_value(value, '1') or '1'
        numbered_at = len(table_styles) + 1
        for node in [*paragraph_properties[:numbered_at], word_child(numbering_level, 'pPr'), *paragraph_properties[numbered_at:]]:
            merge_indents(ind, word_attributes(word_child(node, 'ind')))
            spacing.update(word_attributes(word_child(node, 'spacing')))
        # The first text run determines the character width. This also handles
        # hyperlink/content-control runs and character styles overriding Normal.
        first_run = next((node for node in paragraph.getElementsByTagNameNS(WORD_NS, 'r')
                          if (text := word_child(node, 't')) is not None and text.firstChild
                          and text.firstChild.data and word_ancestor(node, 'p') is paragraph), None)
        rpr = word_child(first_run, 'rPr') if first_run is not None else word_child(ppr, 'rPr')
        character_styles = self.chain(word_value(word_child(rpr, 'rStyle')))
        for node in [*(word_child(style, 'rPr') for style in character_styles), rpr]:
            for key in ('sz', 'snapToGrid'):
                value = word_child(node, key)
                if value is not None:
                    run[key] = word_value(value, '1') or '1'
        # Character units follow sz even when RTL glyphs use a separate szCs.
        return ind, spacing, run, word_number(run.get('sz', '22'), 22) * 10

    def table_styles(self, paragraph):
        cell = word_ancestor(paragraph, 'tc')
        if cell is None:
            return ()
        if cell not in self.table_cells:
            table = word_ancestor(cell, 'tbl')
            if table is None:
                return ()
            tblpr = word_child(table, 'tblPr')
            chain = self.chain(word_value(word_child(tblpr, 'tblStyle')))
            look = word_attributes(word_child(tblpr, 'tblLook'))
            try:
                flags = int(look.get('val', '0'), 16)
            except ValueError:
                flags = 0
            enabled = {key: look.get(key, '1' if flags & flag else '0') in {'1', 'true', 'on'}
                       for key, flag in (('firstRow', 32), ('lastRow', 64), ('firstColumn', 128),
                                         ('lastColumn', 256), ('noHBand', 512), ('noVBand', 1024))}
            rows = word_children(table, 'tr')
            columns = max(len(word_children(word_child(table, 'tblGrid'), 'gridCol')),
                          max((sum(max(1, int(word_number(word_value(word_child(word_child(tc, 'tcPr'), 'gridSpan'), '1'), 1)))
                               for tc in word_children(row, 'tc')) for row in rows), default=0)
                          )
            sizes = {'tblStyleRowBandSize': 1, 'tblStyleColBandSize': 1}
            for node in [*(word_child(style, 'tblPr') for style in chain), tblpr]:
                for key in sizes:
                    size = word_child(node, key)
                    if size is not None:
                        sizes[key] = max(1, int(word_number(word_value(size), 1)))
            for row_index, row in enumerate(rows):
                column = int(word_number(word_value(word_child(word_child(row, 'trPr'), 'gridBefore'), '0')))
                for tc in word_children(row, 'tc'):
                    span = max(1, int(word_number(word_value(word_child(word_child(tc, 'tcPr'), 'gridSpan'), '1'), 1)))
                    first_row = row_index == 0 and enabled['firstRow']
                    last_row = row_index == len(rows) - 1 and enabled['lastRow']
                    first_col = column == 0 and enabled['firstColumn']
                    last_col = column + span == columns and enabled['lastColumn']
                    conditions = ['wholeTable']
                    if not enabled['noVBand'] and not first_col and not last_col:
                        band = (column - int(enabled['firstColumn'])) // sizes['tblStyleColBandSize']
                        conditions.append('band1Vert' if band % 2 == 0 else 'band2Vert')
                    if not enabled['noHBand'] and not first_row and not last_row:
                        band = (row_index - int(enabled['firstRow'])) // sizes['tblStyleRowBandSize']
                        conditions.append('band1Horz' if band % 2 == 0 else 'band2Horz')
                    conditions += [key for key, applies in (('firstRow', first_row), ('lastRow', last_row),
                                    ('firstCol', first_col), ('lastCol', last_col), ('nwCell', first_row and first_col),
                                    ('neCell', first_row and last_col), ('swCell', last_row and first_col),
                                    ('seCell', last_row and last_col)) if applies]
                    result = list(chain)
                    for condition in conditions:
                        for style in chain:
                            result.extend(node for node in word_children(style, 'tblStylePr')
                                          if node.getAttributeNS(WORD_NS, 'type') == condition)
                    self.table_cells[tc] = tuple(result)
                    column += span
        return self.table_cells.get(cell, ())

    def normalize(self, document, default_grid=None, note_grids=None):
        paragraphs = list(document.getElementsByTagNameNS(WORD_NS, 'p'))
        body = word_child(document.documentElement, 'body')
        grid = word_child(word_child(body, 'sectPr'), 'docGrid') if body is not None else default_grid
        # Section properties end a section, so walk backwards to select the
        # correct grid for body paragraphs, including those inside tables.
        for paragraph in reversed(paragraphs):
            ppr = word_child(paragraph, 'pPr')
            section = word_child(ppr, 'sectPr')
            if section is not None:
                grid = word_child(section, 'docGrid')
            ind, spacing, run, width = self.properties(paragraph)
            paragraph_grid = grid
            if note_grids is not None:
                note = word_ancestor(paragraph, 'footnote') or word_ancestor(paragraph, 'endnote')
                if note is not None:
                    paragraph_grid = note_grids.get(note.getAttributeNS(WORD_NS, 'id'))
            if word_ancestor(paragraph, 'txbxContent') is not None:
                paragraph_grid = None
            grid_attrs = word_attributes(paragraph_grid)
            if grid_attrs.get('type') in {'linesAndChars', 'snapToChars'} and run.get('snapToGrid') not in {'0', 'false', 'off'}:
                width += word_number(grid_attrs.get('charSpace', '0')) * 20 / 4096
            for character, distance in (('leftChars', 'left'), ('rightChars', 'right'),
                                        ('firstLineChars', 'firstLine'), ('hangingChars', 'hanging')):
                if character in ind:
                    count = word_number(ind[character])
                    ppr = word_ensure(paragraph, 'pPr', first=True)
                    target = word_ensure(ppr, 'ind')
                    value = word_twips(width * count / 100) if count else ind.get(distance, '0')
                    word_set(target, distance, value)
                    # Materialize zero as well, clearing inherited aliases.
                    word_set(target, character, ind[character])
                    if distance in {'left', 'right'}:
                        alias = 'start' if distance == 'left' else 'end'
                        for key in (alias, alias + 'Chars'):
                            if target.hasAttributeNS(WORD_NS, key):
                                target.removeAttributeNS(WORD_NS, key)
            if word_number(ind.get('hangingChars', '0')):
                # Writer applies firstLine after hanging even when it is zero.
                # Keep the character reset, but omit the conflicting distance.
                target = word_child(ppr, 'ind')
                if target.hasAttributeNS(WORD_NS, 'firstLine'):
                    target.removeAttributeNS(WORD_NS, 'firstLine')
            # OOXML line-unit paragraph gaps use the section's active line grid,
            # or the nominal 12-point line when no line grid is active.
            pitch = word_number(grid_attrs.get('linePitch', '240'), 240) if grid_attrs.get('type') in {'lines', 'linesAndChars'} else Decimal(240)
            for side in ('before', 'after'):
                if side + 'Lines' in spacing and spacing.get(side + 'Autospacing') not in {'1', 'true', 'on'}:
                    ppr = word_ensure(paragraph, 'pPr', first=True)
                    word_set(word_ensure(ppr, 'spacing'), side, word_twips(pitch * word_number(spacing[side + 'Lines']) / 100))
            if spacing.get('lineRule') == 'exact':
                ppr = word_ensure(paragraph, 'pPr', first=True)
                word_set(word_ensure(ppr, 'snapToGrid'), 'val', '0')
        self.table_cells.clear()


def word_document(content):
    if len(content) > MAX_BYTES or b'<!DOCTYPE' in content.upper():
        raise ValueError('文档 XML 超过预览范围或包含不支持的声明')
    return minidom.parseString(content)


def word_part_contexts(source, main):
    """Bind auxiliary stories to their section, copying a shared header/footer
    only when different grids require different fixed preview distances.
    """
    grids, notes, extras, replacements = {}, {'footnotes': {}, 'endnotes': {}}, {}, {}
    body = word_child(main.documentElement, 'body')
    sections, pending = [], []
    for child in body.childNodes if body is not None else ():
        if child.namespaceURI != WORD_NS:
            continue
        if child.localName == 'sectPr':
            sections.append((child, pending))
            pending = []
        else:
            pending.append(child)
            section = word_child(word_child(child, 'pPr'), 'sectPr') if child.localName == 'p' else None
            if section is not None:
                sections.append((section, pending))
                pending = []
    if pending:
        sections.append((None, pending))
    rel_name = 'word/_rels/document.xml.rels'
    relationships = word_document(source.read(rel_name)) if rel_name in source.namelist() else None
    types = word_document(source.read('[Content_Types].xml')) if '[Content_Types].xml' in source.namelist() else None
    try:
        rels = {node.getAttribute('Id'): node for node in relationships.documentElement.childNodes
                if node.nodeType == node.ELEMENT_NODE and node.localName == 'Relationship'} if relationships else {}
        active, variants, last_rids = {}, {}, {}
        names, ids = set(source.namelist()), set(rels)
        changed = False
        for section, content in sections:
            grid = word_child(section, 'docGrid')
            grid_key = tuple(sorted(word_attributes(grid).items()))
            for kind in ('headerReference', 'footerReference'):
                for ref in word_children(section, kind):
                    rel = rels.get(ref.getAttributeNS(REL_NS, 'id'))
                    if rel is None or rel.getAttribute('TargetMode') == 'External':
                        continue
                    path = unquote(rel.getAttribute('Target'))
                    path = posixpath.normpath(path.lstrip('/') if path.startswith('/') else 'word/' + path)
                    if path in names and path.startswith('word/'):
                        active[(kind, ref.getAttributeNS(WORD_NS, 'type'))] = (path, rel, ref)
            for key, (path, rel, template) in active.items():
                variant_key = path, grid_key
                if variant_key not in variants:
                    if path not in grids:
                        target, rid = path, rel.getAttribute('Id')
                    else:
                        index = 1
                        directory = posixpath.dirname(path)
                        while (f'{directory}/preview-story-{index}.xml' in names
                               or f'{directory}/_rels/preview-story-{index}.xml.rels' in names
                               or f'previewStory{index}' in ids):
                            index += 1
                        target, rid = f'{directory}/preview-story-{index}.xml', f'previewStory{index}'
                        names.add(target)
                        ids.add(rid)
                        old_rels = posixpath.join(posixpath.dirname(path), '_rels', posixpath.basename(path) + '.rels')
                        additions = [(target, path)]
                        if old_rels in source.namelist():
                            additions.append((f'{directory}/_rels/{posixpath.basename(target)}.rels', old_rels))
                        # Check before reading/retaining additional part bytes.
                        if (len(source.infolist()) + len(extras) + len(additions) > MAX_PARTS
                                or sum(item.file_size for item in source.infolist()) + sum(map(len, extras.values()))
                                + sum(source.getinfo(original).file_size for _, original in additions) > MAX_EXPANDED_BYTES):
                            raise ValueError('文档分节展开后超过预览范围')
                        extras.update((name, source.read(original)) for name, original in additions)
                        copied = rel.cloneNode(True)
                        copied.setAttribute('Id', rid)
                        copied.setAttribute('Target', target.removeprefix('word/'))
                        relationships.documentElement.appendChild(copied)
                        if types is not None:
                            original = next((node for node in types.documentElement.childNodes
                                             if node.nodeType == node.ELEMENT_NODE and node.getAttribute('PartName') == '/' + path), None)
                            if original is not None:
                                copied_type = original.cloneNode(True)
                                copied_type.setAttribute('PartName', '/' + target)
                                types.documentElement.appendChild(copied_type)
                        changed = True
                    variants[variant_key] = rid
                    grids[target] = grid.cloneNode(True) if grid is not None else None
                rid = variants[variant_key]
                ref = next((node for node in word_children(section, key[0])
                            if node.getAttributeNS(WORD_NS, 'type') == key[1]), None)
                if last_rids.get(key) != rid or ref is not None:
                    if ref is None:
                        ref = template.cloneNode(True)
                        preceding = {'headerReference'} if key[0] == 'headerReference' else {'headerReference', 'footerReference'}
                        following = next((node for node in section.childNodes if node.namespaceURI == WORD_NS
                                          and node.localName not in preceding), None)
                        section.insertBefore(ref, following)
                    xml_set(ref, REL_NS, 'r', 'id', rid)
                last_rids[key] = rid
            for node in content:
                for kind, story in (('footnoteReference', 'footnotes'), ('endnoteReference', 'endnotes')):
                    for ref in node.getElementsByTagNameNS(WORD_NS, kind):
                        notes[story][ref.getAttributeNS(WORD_NS, 'id')] = grid.cloneNode(True) if grid is not None else None
        if changed:
            replacements[rel_name] = relationships.toxml(encoding='utf-8')
            if types is not None:
                replacements['[Content_Types].xml'] = types.toxml(encoding='utf-8')
        return grids, notes, extras, replacements
    finally:
        for document in (relationships, types):
            if document is not None:
                document.unlink()


def missing_fonts(data, suffix):
    """Report declared OOXML families; the original document is never rewritten."""
    if suffix not in {'.docx', '.docm', '.dotx', '.dotm', '.xlsx', '.xlsm', '.xltx', '.xltm', '.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm'}:
        return []
    families = set()
    with zipfile.ZipFile(io.BytesIO(data)) as source:
        if len(source.infolist()) > MAX_PARTS or sum(item.file_size for item in source.infolist()) > MAX_EXPANDED_BYTES:
            raise ValueError('文档解压后超过预览范围')
        for item in source.infolist():
            if not item.filename.endswith('.xml') or item.file_size > MAX_BYTES:
                continue
            content = source.read(item)
            if b'<!DOCTYPE' in content.upper():
                raise ValueError('文档包含不支持的声明')
            for node in ElementTree.fromstring(content).iter():
                local = node.tag.rpartition('}')[2]
                for key, value in node.attrib.items():
                    attr = key.rpartition('}')[2]
                    if (local == 'rFonts' and attr in {'ascii', 'hAnsi', 'eastAsia', 'cs'}) or attr == 'typeface':
                        if value and not value.startswith('+') and len(value) <= 100:
                            families.add(value)
    if not families:
        return []
    result = subprocess.run(['fc-list', '--format', '%{family}\n'], capture_output=True, text=True, timeout=5, check=True)
    available = {family.strip().casefold() for line in result.stdout.splitlines() for family in line.split(',')}
    return sorted(name for name in families if name.casefold() not in available)[:20]


def preserve_word_layout(data, suffix):
    """Adapt Word character/line units and exact spacing in the preview copy.

    Only the disposable conversion input changes. See OOXML docGrid/linePitch:
    https://learn.microsoft.com/dotnet/api/documentformat.openxml.wordprocessing.docgrid.linepitch
    """
    if suffix not in {".docx", ".docm", ".dotx", ".dotm"}:
        return data
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as source, zipfile.ZipFile(output, "w") as target:
        if len(source.infolist()) > MAX_PARTS or sum(item.file_size for item in source.infolist()) > MAX_EXPANDED_BYTES:
            raise ValueError("文档解压后超过预览范围")
        styles = word_document(source.read('word/styles.xml')) if 'word/styles.xml' in source.namelist() else None
        numbering = word_document(source.read('word/numbering.xml')) if 'word/numbering.xml' in source.namelist() else None
        layout = WordLayout(styles, numbering)
        main = word_document(source.read('word/document.xml')) if 'word/document.xml' in source.namelist() else None
        try:
            grids, notes, extras, replacements = word_part_contexts(source, main) if main is not None else ({}, {}, {}, {})
            if len(source.infolist()) + len(extras) > MAX_PARTS or sum(item.file_size for item in source.infolist()) + sum(map(len, extras.values())) > MAX_EXPANDED_BYTES:
                raise ValueError('文档分节展开后超过预览范围')
            for name in [*source.namelist(), *extras]:
                item = source.getinfo(name) if name not in extras else name
                content = replacements.get(name, extras.get(name))
                if content is None:
                    content = source.read(name)
                if name in replacements or not (name.startswith('word/') and name.endswith('.xml')):
                    target.writestr(item, content)
                    continue
                document = main if name == 'word/document.xml' else word_document(content)
                story = posixpath.basename(name).removesuffix('.xml')
                layout.normalize(document, grids.get(name), notes.get(story))
                for spacing in document.getElementsByTagNameNS(WORD_NS, "spacing"):
                    parent = spacing.parentNode
                    if spacing.getAttributeNS(WORD_NS, "lineRule") != "exact" or parent.localName != "pPr":
                        continue
                    snap = word_child(parent, 'snapToGrid')
                    if snap is None:
                        snap = document.createElementNS(WORD_NS, (spacing.prefix + ":" if spacing.prefix else "") + "snapToGrid")
                        parent.insertBefore(snap, spacing)
                    word_set(snap, 'val', '0')
                content = document.toxml(encoding="utf-8")
                document.unlink()
                target.writestr(item, content)
        finally:
            if main is not None:
                main.unlink()
            if styles is not None:
                styles.unlink()
            if numbering is not None:
                numbering.unlink()
    return output.getvalue()


def preview(payload):
    suffix = Path(payload["name"]).suffix.lower()
    if suffix not in SUFFIXES:
        raise ValueError("Unsupported document format")
    data = base64.b64decode(payload["data"], validate=True)
    if not data or len(data) > MAX_BYTES:
        raise ValueError("Only documents up to 20 MiB are supported")
    with tempfile.TemporaryDirectory(prefix="word-preview-") as directory:
        source = Path(directory) / ("source" + suffix)
        target = Path(directory) / "preview.pdf"
        source.write_bytes(preserve_word_layout(data, suffix))
        result = subprocess.run(
            ["/usr/bin/python3", "-I", "/opt/office/uno_worker.py", str(source), str(target), "convert"],
            capture_output=True, text=True, timeout=45,
        )
        if result.returncode or not target.is_file():
            raise ValueError("文档排版失败，请检查文件是否损坏或需要密码")
        if target.stat().st_size > MAX_BYTES:
            raise ValueError("分页预览超过 20 MiB，请下载原文件查看")
        content = target.read_bytes()
        if not content.startswith(b"%PDF-"):
            raise ValueError("文档未生成有效的分页预览")
        return {"data": base64.b64encode(content).decode(), "name": "preview.pdf", 'missing_fonts': missing_fonts(data, suffix)}


if __name__ == "__main__":
    try:
        print(json.dumps(preview(json.load(sys.stdin))))
    except (ValueError, OSError, zipfile.BadZipFile, ExpatError, ElementTree.ParseError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error) if not isinstance(error, subprocess.TimeoutExpired) else "文档排版超时，请下载原文件查看"}))
        sys.exit(2)
