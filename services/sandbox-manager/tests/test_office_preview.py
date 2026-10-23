"""Word layout units survive preview conversion without changing uploaded files."""

import importlib.util
import base64
import io
from pathlib import Path
import zipfile
from types import SimpleNamespace
from xml.etree import ElementTree

import pytest

spec = importlib.util.spec_from_file_location("office_preview", Path(__file__).parents[1] / "office_preview.py")
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)
NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def document(xml):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("word/document.xml", xml)
        archive.writestr("word/media/image.png", b"original-image")
    return stream.getvalue()


def test_exact_spacing_overrides_grid_only_in_conversion_copy():
    xml = f'''<w:document xmlns:w="{NS}"><w:body>
      <w:p><w:pPr><w:spacing w:lineRule="exact" w:line="440"/></w:pPr><w:r><w:rPr><w:b/><w:rFonts w:eastAsia="宋体"/></w:rPr><w:t>正文</w:t><w:br w:type="page"/></w:r></w:p>
      <w:p><w:pPr><w:spacing w:lineRule="auto" w:line="240"/></w:pPr></w:p>
      <w:sectPr><w:docGrid w:type="lines" w:linePitch="312"/></w:sectPr>
    </w:body></w:document>'''
    original = document(xml)
    output = preview.preserve_word_layout(original, ".docx")
    with zipfile.ZipFile(io.BytesIO(original)) as uploaded, zipfile.ZipFile(io.BytesIO(output)) as converted:
        assert uploaded.read("word/document.xml").decode() == xml
        tree = ElementTree.fromstring(converted.read("word/document.xml"))
        paragraphs = tree.findall(f".//{{{NS}}}pPr")
        assert paragraphs[0].find(f"{{{NS}}}snapToGrid").get(f"{{{NS}}}val") == "0"
        assert paragraphs[1].find(f"{{{NS}}}snapToGrid") is None
        assert tree.find(f".//{{{NS}}}spacing").get(f"{{{NS}}}line") == "440"
        assert tree.find(f".//{{{NS}}}br").get(f"{{{NS}}}type") == "page"
        assert tree.find(f".//{{{NS}}}rFonts").get(f"{{{NS}}}eastAsia") == "宋体"
        assert converted.read("word/media/image.png") == b"original-image"


def test_unsafe_xml_is_rejected_before_conversion():
    with pytest.raises(ValueError, match="声明"):
        preview.preserve_word_layout(document('<!DOCTYPE spacing><spacing/>'), ".docx")


def package(body, styles='', extra=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        archive.writestr('word/document.xml', f'<w:document xmlns:w="{NS}"><w:body>{body}</w:body></w:document>')
        if styles:
            archive.writestr('word/styles.xml', f'<w:styles xmlns:w="{NS}">{styles}</w:styles>')
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    return stream.getvalue()


def converted(data, part='word/document.xml'):
    with zipfile.ZipFile(io.BytesIO(preview.preserve_word_layout(data, '.docx'))) as archive:
        return ElementTree.fromstring(archive.read(part))


@pytest.mark.parametrize('characters,distance', [
    ('firstLineChars', 'firstLine'), ('hangingChars', 'hanging'),
    ('leftChars', 'left'), ('rightChars', 'right'), ('startChars', 'start'), ('endChars', 'end'),
])
@pytest.mark.parametrize('size,expected', [('24', '480'), ('32', '640'), ('36', '720')])
def test_character_indents_follow_effective_font_size(characters, distance, size, expected):
    source = package(f'<w:p><w:pPr><w:ind w:{characters}="200" w:{distance}="0"/></w:pPr>'
                     f'<w:r><w:rPr><w:sz w:val="{size}"/></w:rPr><w:t>正文</w:t></w:r></w:p>')
    ind = converted(source).find(f'.//{{{NS}}}pPr/{{{NS}}}ind')
    canonical_distance = {'start': 'left', 'end': 'right'}.get(distance, distance)
    assert ind.get(f'{{{NS}}}{canonical_distance}') == expected
    assert ind.get(f'{{{NS}}}{canonical_distance}Chars') == '200'


def test_style_inheritance_character_override_and_zero_reset():
    styles = '''<w:style w:type="paragraph" w:default="1" w:styleId="Normal">
      <w:pPr><w:ind w:firstLineChars="200" w:firstLine="123"/></w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:style>
      <w:style w:type="paragraph" w:styleId="Body"><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="32"/></w:rPr></w:style>'''
    source = package('''<w:p><w:pPr><w:pStyle w:val="Body"/><w:ind w:firstLine="0"/></w:pPr><w:r><w:t>继承</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Body"/><w:ind w:firstLineChars="0" w:firstLine="360"/></w:pPr><w:r><w:t>重置</w:t></w:r></w:p>''', styles)
    paragraphs = converted(source).findall(f'.//{{{NS}}}p')
    assert paragraphs[0].find(f'{{{NS}}}pPr/{{{NS}}}ind').get(f'{{{NS}}}firstLine') == '640'
    assert paragraphs[1].find(f'{{{NS}}}pPr/{{{NS}}}ind').get(f'{{{NS}}}firstLine') == '360'


def test_document_defaults_and_character_style_in_hyperlink():
    styles = '''<w:docDefaults><w:pPrDefault><w:pPr><w:ind w:leftChars="150"/></w:pPr></w:pPrDefault>
      <w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
      <w:style w:type="character" w:styleId="Large"><w:rPr><w:sz w:val="40"/></w:rPr></w:style>'''
    source = package('''<w:p><w:hyperlink><w:r><w:rPr><w:rStyle w:val="Large"/></w:rPr><w:t>链接正文</w:t></w:r></w:hyperlink></w:p>''', styles)
    ppr = converted(source).find(f'.//{{{NS}}}pPr')
    assert ppr.find(f'{{{NS}}}ind').get(f'{{{NS}}}left') == '600'


def test_section_character_grid_changes_indent_width_and_respects_run_opt_out():
    source = package('''<w:p><w:pPr><w:ind w:firstLineChars="200"/></w:pPr><w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t>网格</w:t></w:r></w:p>
      <w:p><w:pPr><w:ind w:firstLineChars="200"/></w:pPr><w:r><w:rPr><w:sz w:val="32"/><w:snapToGrid w:val="0"/></w:rPr><w:t>自由</w:t></w:r></w:p>
      <w:sectPr><w:docGrid w:type="linesAndChars" w:charSpace="4096"/></w:sectPr>''')
    indents = converted(source).findall(f'.//{{{NS}}}ind')
    assert [node.get(f'{{{NS}}}firstLine') for node in indents] == ['680', '640']


@pytest.mark.parametrize('complex_size', ['22', '60'])
def test_complex_script_size_does_not_change_character_indent_units(complex_size):
    source = package(f'''<w:p><w:pPr><w:bidi/><w:ind w:firstLineChars="200"/></w:pPr>
      <w:r><w:rPr><w:sz w:val="32"/><w:szCs w:val="{complex_size}"/><w:rtl/></w:rPr><w:t>שלום</w:t></w:r></w:p>''')
    assert converted(source).find(f'.//{{{NS}}}ind').get(f'{{{NS}}}firstLine') == '640'


def test_line_unit_gaps_follow_each_section_and_keep_automatic_spacing():
    source = package('''<w:p><w:pPr><w:spacing w:beforeLines="100" w:afterLines="50"/>
      <w:sectPr><w:docGrid w:type="lines" w:linePitch="400"/></w:sectPr></w:pPr></w:p>
      <w:p><w:pPr><w:spacing w:before="0" w:beforeLines="200" w:after="123" w:afterLines="200" w:afterAutospacing="1"/></w:pPr></w:p>
      <w:sectPr><w:docGrid w:linePitch="360"/></w:sectPr>''')
    gaps = converted(source).findall(f'.//{{{NS}}}spacing')
    assert gaps[0].get(f'{{{NS}}}before') == '400'
    assert gaps[0].get(f'{{{NS}}}after') == '200'
    assert gaps[1].get(f'{{{NS}}}before') == '480'
    assert gaps[1].get(f'{{{NS}}}after') == '123'


def test_table_and_header_paragraphs_inherit_font_and_gaps_without_rewriting_source():
    styles = '''<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:pPr><w:ind w:firstLineChars="200"/>
      <w:spacing w:afterLines="100"/></w:pPr><w:rPr><w:sz w:val="32"/></w:rPr></w:style>'''
    source = package('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
                     f'<w:sectPr><w:headerReference xmlns:r="{preview.REL_NS}" r:id="header" w:type="default"/>'
                     '<w:docGrid w:type="lines" w:linePitch="400"/></w:sectPr>', styles,
                     {'word/header1.xml': f'<w:hdr xmlns:w="{NS}"><w:p><w:r><w:t>页眉</w:t></w:r></w:p></w:hdr>',
                      'word/_rels/document.xml.rels': f'<Relationships xmlns="{preview.PACKAGE_REL_NS}"><Relationship Id="header" Target="header1.xml" Type="{preview.REL_NS}/header"/></Relationships>',
                      'word/media/image.png': b'unchanged'})
    for part in ('word/document.xml', 'word/header1.xml'):
        tree = converted(source, part)
        assert tree.find(f'.//{{{NS}}}pPr/{{{NS}}}ind').get(f'{{{NS}}}firstLine') == '640'
        assert tree.find(f'.//{{{NS}}}pPr/{{{NS}}}spacing').get(f'{{{NS}}}after') == '400'
    with zipfile.ZipFile(io.BytesIO(source)) as original, zipfile.ZipFile(io.BytesIO(preview.preserve_word_layout(source, '.docx'))) as output:
        assert b'firstLine="640"' not in original.read('word/document.xml')
        assert output.read('word/media/image.png') == b'unchanged'


def test_nonstandard_namespace_prefixes_and_property_order_are_preserved():
    xml = f'''<document xmlns="{NS}"><body><p><pPr><jc xmlns:w="{NS}" w:val="center"/></pPr>
      <r><rPr><sz xmlns:w="{NS}" w:val="32"/></rPr><t>正文</t></r></p></body></document>'''
    xml = xml.replace('<pPr>', f'<pPr><ind xmlns:w="{NS}" w:firstLineChars="200"/>')
    tree = converted(document(xml))
    assert tree.find(f'.//{{{NS}}}ind').get(f'{{{NS}}}firstLine') == '640'


def test_cyclic_styles_terminate_and_distance_only_documents_keep_their_values():
    source = package('<w:p><w:pPr><w:pStyle w:val="A"/><w:ind w:firstLine="360"/></w:pPr></w:p>',
                     '<w:style w:styleId="A"><w:basedOn w:val="B"/></w:style><w:style w:styleId="B"><w:basedOn w:val="A"/></w:style>')
    assert converted(source).find(f'.//{{{NS}}}ind').get(f'{{{NS}}}firstLine') == '360'


def test_numbered_list_units_and_level_overrides_use_paragraph_font_size():
    numbering = f'''<w:numbering xmlns:w="{NS}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0">
      <w:pPr><w:ind w:leftChars="200" w:hangingChars="100"/></w:pPr></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:lvl w:ilvl="0">
      <w:pPr><w:ind w:leftChars="300" w:hangingChars="150"/></w:pPr></w:lvl></w:lvlOverride></w:num></w:numbering>'''
    source = package('''<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t>编号项</w:t></w:r></w:p>''', extra={'word/numbering.xml': numbering})
    ind = converted(source).find(f'.//{{{NS}}}pPr/{{{NS}}}ind')
    assert ind.get(f'{{{NS}}}left') == '960'
    assert ind.get(f'{{{NS}}}hanging') == '480'


def test_inherited_spacing_is_inserted_before_indent_and_alignment():
    source = package('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>正文</w:t></w:r></w:p>',
                     '<w:docDefaults><w:pPrDefault><w:pPr><w:ind w:firstLineChars="200"/>'
                     '<w:spacing w:afterLines="100"/></w:pPr></w:pPrDefault></w:docDefaults>')
    ppr = converted(source).find(f'.//{{{NS}}}pPr')
    assert [node.tag.rpartition('}')[2] for node in ppr] == ['spacing', 'ind', 'jc']


@pytest.mark.parametrize('suffix', ['.docx', '.docm', '.dotx', '.dotm'])
def test_preview_entry_converts_the_compatibility_copy(suffix, monkeypatch):
    source = package('''<w:p><w:pPr><w:ind w:firstLineChars="200"/></w:pPr>
      <w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t>正文</w:t></w:r></w:p>''')
    def convert(args, **kwargs):
        with zipfile.ZipFile(args[3]) as archive:
            tree = ElementTree.fromstring(archive.read('word/document.xml'))
        assert tree.find(f'.//{{{NS}}}ind').get(f'{{{NS}}}firstLine') == '640'
        Path(args[4]).write_bytes(b'%PDF-test')
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(preview.subprocess, 'run', convert)
    monkeypatch.setattr(preview, 'missing_fonts', lambda *args: [])
    result = preview.preview({'name': 'report' + suffix, 'data': base64.b64encode(source).decode()})
    assert base64.b64decode(result['data']) == b'%PDF-test'


@pytest.mark.parametrize('suffix', ['.pdf', '.doc', '.xlsx', '.pptx', '.odt'])
def test_other_formats_are_passed_through(suffix):
    assert preview.preserve_word_layout(b'unchanged', suffix) == b'unchanged'


def test_missing_declared_fonts_accepts_localized_and_english_family_names(monkeypatch):
    monkeypatch.setattr(preview.subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(stdout='SimSun,宋体\nFangSong,仿宋\n'))
    source = document(f'<w:document xmlns:w="{NS}"><w:rFonts w:eastAsia="宋体" w:ascii="SimSun" w:cs="Unavailable"/></w:document>')
    assert preview.missing_fonts(source, '.docx') == ['Unavailable']


def test_hanging_wins_within_one_layer_and_first_line_replaces_inherited_hanging():
    styles = '''<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:sz w:val="32"/></w:rPr>
      <w:pPr><w:ind w:hangingChars="100" w:hanging="320"/></w:pPr></w:style>'''
    source = package('''<w:p><w:pPr><w:ind w:firstLineChars="200" w:hangingChars="100"/></w:pPr><w:r><w:t>悬挂</w:t></w:r></w:p>
      <w:p><w:pPr><w:ind w:firstLineChars="200"/></w:pPr><w:r><w:t>首行</w:t></w:r></w:p>''', styles)
    indents = converted(source).findall(f'.//{{{NS}}}ind')
    assert [(node.get(f'{{{NS}}}firstLine'), node.get(f'{{{NS}}}hanging')) for node in indents] == [(None, '320'), ('640', '0')]
    assert indents[0].get(f'{{{NS}}}firstLineChars') == '0'


@pytest.mark.parametrize('modern,legacy', [('start', 'left'), ('end', 'right')])
def test_alias_zero_clears_inherited_character_indentation(modern, legacy):
    styles = f'''<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:pPr>
      <w:ind w:{legacy}Chars="200" w:{legacy}="0"/></w:pPr><w:rPr><w:sz w:val="32"/></w:rPr></w:style>'''
    source = package(f'<w:p><w:pPr><w:ind w:{modern}Chars="0"/></w:pPr><w:r><w:t>重置</w:t></w:r></w:p>', styles)
    ind = converted(source).find(f'.//{{{NS}}}ind')
    assert ind.get(f'{{{NS}}}{legacy}') == '0'
    assert ind.get(f'{{{NS}}}{legacy}Chars') == '0'


def test_table_style_and_first_row_font_precede_document_defaults():
    styles = '''<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
      <w:style w:type="table" w:styleId="Large"><w:rPr><w:sz w:val="48"/></w:rPr>
      <w:pPr><w:ind w:firstLineChars="200"/></w:pPr><w:tblStylePr w:type="firstRow">
      <w:rPr><w:sz w:val="40"/></w:rPr></w:tblStylePr></w:style>'''
    source = package('''<w:tbl><w:tblPr><w:tblStyle w:val="Large"/><w:tblLook w:firstRow="1" w:noHBand="1" w:noVBand="1"/></w:tblPr>
      <w:tr><w:tc><w:p><w:r><w:t>表头</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:tc></w:tr></w:tbl>''', styles)
    assert [node.get(f'{{{NS}}}firstLine') for node in converted(source).findall(f'.//{{{NS}}}ind')] == ['800', '960']


def shared_header_package():
    ref = f'<w:headerReference xmlns:r="{preview.REL_NS}" r:id="header" w:type="default"/>'
    return package(f'''<w:p><w:pPr><w:sectPr>{ref}<w:docGrid w:type="linesAndChars" w:charSpace="0" w:linePitch="400"/></w:sectPr></w:pPr></w:p>
      <w:p><w:r><w:t>第二节</w:t></w:r></w:p><w:sectPr><w:docGrid w:type="linesAndChars" w:charSpace="40960" w:linePitch="600"/></w:sectPr>''',
      extra={
          'word/header1.xml': f'''<w:hdr xmlns:w="{NS}"><w:p><w:pPr><w:ind w:firstLineChars="200"/>
            <w:spacing w:beforeLines="100"/></w:pPr><w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t>共享页眉</w:t></w:r></w:p></w:hdr>''',
          'word/_rels/document.xml.rels': f'<Relationships xmlns="{preview.PACKAGE_REL_NS}"><Relationship Id="header" Type="{preview.REL_NS}/header" Target="header1.xml"/></Relationships>',
          'word/_rels/header1.xml.rels': f'<Relationships xmlns="{preview.PACKAGE_REL_NS}"><Relationship Id="image" Type="{preview.REL_NS}/image" Target="media/image.png"/></Relationships>',
          'word/media/image.png': b'original-image',
          '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>',
      })


def test_shared_headers_are_adapted_per_section_with_relationships_preserved():
    original = shared_header_package()
    output = preview.preserve_word_layout(original, '.docx')
    with zipfile.ZipFile(io.BytesIO(output)) as archive:
        main = ElementTree.fromstring(archive.read('word/document.xml'))
        refs = main.findall(f'.//{{{NS}}}headerReference')
        assert len(refs) == 2
        rels = ElementTree.fromstring(archive.read('word/_rels/document.xml.rels'))
        targets = {node.get('Id'): node.get('Target') for node in rels}
        properties = []
        for ref in refs:
            name = targets[ref.get(f'{{{preview.REL_NS}}}id')]
            tree = ElementTree.fromstring(archive.read('word/' + name))
            properties.append((tree.find(f'.//{{{NS}}}ind').get(f'{{{NS}}}firstLine'),
                               tree.find(f'.//{{{NS}}}spacing').get(f'{{{NS}}}before')))
            assert b'media/image.png' in archive.read('word/_rels/' + name + '.rels')
        assert properties == [('640', '400'), ('1040', '600')]
        assert archive.read('word/media/image.png') == b'original-image'
        assert b'preview-story-' in archive.read('[Content_Types].xml')
    with zipfile.ZipFile(io.BytesIO(original)) as archive:
        assert 'word/preview-story-1.xml' not in archive.namelist()


def test_shared_story_expansion_is_bounded_before_copying(monkeypatch):
    source = shared_header_package()
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        original_size = sum(item.file_size for item in archive.infolist())
    monkeypatch.setattr(preview, 'MAX_EXPANDED_BYTES', original_size + 1)
    with pytest.raises(ValueError, match='分节展开'):
        preview.preserve_word_layout(source, '.docx')


@pytest.mark.parametrize('story,note', [('footnotes', 'footnote'), ('endnotes', 'endnote')])
def test_notes_use_the_grid_of_their_reference_section(story, note):
    source = package(f'''<w:p><w:pPr><w:sectPr><w:docGrid w:type="linesAndChars" w:charSpace="0"/></w:sectPr></w:pPr>
      <w:r><w:{note}Reference w:id="1"/></w:r></w:p><w:p><w:r><w:{note}Reference w:id="2"/></w:r></w:p>
      <w:sectPr><w:docGrid w:type="linesAndChars" w:charSpace="40960"/></w:sectPr>''',
      extra={f'word/{story}.xml': f'''<w:{story} xmlns:w="{NS}">''' + ''.join(f'''<w:{note} w:id="{index}"><w:p><w:pPr><w:ind w:firstLineChars="200"/></w:pPr>
        <w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t>注释</w:t></w:r></w:p></w:{note}>''' for index in (1, 2)) + f'</w:{story}>'})
    assert [node.get(f'{{{NS}}}firstLine') for node in converted(source, f'word/{story}.xml').findall(f'.//{{{NS}}}ind')] == ['640', '1040']


def test_shared_story_in_a_subdirectory_keeps_relative_resource_targets():
    stream = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(shared_header_package())) as source, zipfile.ZipFile(stream, 'w') as target:
        for item in source.infolist():
            name, data = item.filename, source.read(item)
            if name in {'word/_rels/document.xml.rels', '[Content_Types].xml'}:
                data = data.replace(b'header1.xml', b'stories/header1.xml')
            if name == 'word/header1.xml':
                name = 'word/stories/header1.xml'
            elif name == 'word/_rels/header1.xml.rels':
                name, data = 'word/stories/_rels/header1.xml.rels', data.replace(b'media/', b'../media/')
            target.writestr(name, data)
    with zipfile.ZipFile(io.BytesIO(preview.preserve_word_layout(stream.getvalue(), '.docx'))) as output:
        rels = ElementTree.fromstring(output.read('word/_rels/document.xml.rels'))
        assert [node.get('Target') for node in rels] == ['stories/header1.xml', 'stories/preview-story-1.xml']
        assert b'../media/image.png' in output.read('word/stories/_rels/preview-story-1.xml.rels')


def test_shared_story_returns_to_an_earlier_section_grid_without_extra_copy():
    stream = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(shared_header_package())) as source, zipfile.ZipFile(stream, 'w') as target:
        for item in source.infolist():
            data = source.read(item)
            if item.filename == 'word/document.xml':
                tree = ElementTree.fromstring(data)
                body = tree.find(f'{{{NS}}}body')
                last = body.find(f'{{{NS}}}sectPr')
                body.remove(last)
                ppr = ElementTree.Element(f'{{{NS}}}pPr')
                body[-1].insert(0, ppr)
                ElementTree.SubElement(ppr, f'{{{NS}}}sectPr').extend(last)
                final = ElementTree.SubElement(body, f'{{{NS}}}sectPr')
                ElementTree.SubElement(final, f'{{{NS}}}docGrid', {f'{{{NS}}}type': 'linesAndChars', f'{{{NS}}}charSpace': '0', f'{{{NS}}}linePitch': '400'})
                data = ElementTree.tostring(tree)
            target.writestr(item, data)
    with zipfile.ZipFile(io.BytesIO(preview.preserve_word_layout(stream.getvalue(), '.docx'))) as output:
        tree = ElementTree.fromstring(output.read('word/document.xml'))
        refs = tree.findall(f'.//{{{NS}}}headerReference')
        assert [ref.get(f'{{{preview.REL_NS}}}id') for ref in refs] == ['header', 'previewStory1', 'header']
        assert len([name for name in output.namelist() if name.startswith('word/preview-story-')]) == 1


def test_inherited_fixed_spacing_overrides_a_direct_grid_flag():
    styles = '''<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:pPr><w:spacing w:line="400" w:lineRule="exact"/></w:pPr></w:style>'''
    source = package('''<w:p><w:pPr><w:snapToGrid w:val="1"/></w:pPr><w:r><w:t>固定行距</w:t></w:r></w:p>
      <w:p><w:pPr><w:spacing w:lineRule="auto" w:line="240"/><w:snapToGrid w:val="1"/></w:pPr><w:r><w:t>自动行距</w:t></w:r></w:p>''', styles)
    flags = converted(source).findall(f'.//{{{NS}}}pPr/{{{NS}}}snapToGrid')
    assert [node.get(f'{{{NS}}}val') for node in flags] == ['0', '1']


def test_existing_namespace_bindings_and_extension_nodes_are_preserved():
    xml = f'''<document xmlns="{NS}" xmlns:w="urn:vendor" xmlns:m="{NS}"><body><p><pPr><ind m:firstLineChars="200"/></pPr>
      <r><rPr><sz m:val="32"/></rPr><t>正文</t></r></p><w:metadata w:val="original"/></body></document>'''
    tree = converted(document(xml))
    assert tree.find('.//{urn:vendor}metadata').get('{urn:vendor}val') == 'original'
    assert tree.find(f'.//{{{NS}}}ind').get(f'{{{NS}}}firstLine') == '640'
