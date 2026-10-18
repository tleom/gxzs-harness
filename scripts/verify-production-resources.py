#!/usr/bin/env python3
"""Verify persistent global skills and private fonts before a production rollout."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


def verify_skill_source(root):
    root = Path(root).resolve(strict=True)
    manifest = json.loads((root / 'skills-manifest.json').read_text(encoding='utf-8'))
    skills = root / 'skills'
    if skills.is_symlink():
        raise ValueError('Published skill resources must not contain symlinks')
    actual = {}
    for path in skills.rglob('*'):
        if path.is_symlink():
            raise ValueError('Published skill resources must not contain symlinks')
        if path.is_file():
            actual[path.relative_to(skills).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    count = len(list(skills.glob('*/SKILL.md')))
    if not actual or count < 1 or actual != manifest['files'] or count != manifest['skills']:
        raise ValueError('Published global skills differ from their release manifest')
    return skills, manifest


def verify_font_source(root):
    root = Path(root) / 'fonts'
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    files = set()
    for item in manifest['files']:
        name = item['asset'].split('/')[-1]
        path = root / name
        if (not re.fullmatch(r'[a-f0-9]{64}\.(ttf|otf|ttc|otc)', name)
                or name.split('.')[0] != item['sha256'] or path.is_symlink()
                or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']):
            raise ValueError('Published font asset differs from its release manifest')
        files.add(name)
    generation = hashlib.sha256('\n'.join(sorted(files)).encode()).hexdigest()
    if not files or len(files) != manifest['uniqueFiles'] or generation != manifest['generation']:
        raise ValueError('Published font generation differs from its release manifest')
    return manifest


def verify_font_runtime(runtime, manifest):
    if (manifest['uniqueFiles'] < 1 or manifest['generation'] == 'system'
            or runtime['fonts'] != manifest['uniqueFiles']
            or runtime['font_generation'] != manifest['generation']):
        raise ValueError('Candidate sandbox does not preserve production font assets')


def verify(resources, sandbox_image, host_image):
    resources = Path(resources).resolve(strict=True)
    skills, manifest = verify_skill_source(resources)
    fonts = verify_font_source(resources)
    # Match the complete mounted file set, not just the directory or SKILL.md count.
    script = """
const fs=require('fs'),p=require('path'),c=require('crypto');
const root='/opt/workbench-global/skills',files={};
function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 const f=p.join(dir,e.name);
 if(e.isSymbolicLink())throw Error('Skill symlink');
 if(e.isDirectory())visit(f);
 else if(e.isFile())files[p.relative(root,f)]=c.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}}
visit(root);console.log(JSON.stringify(files));
"""
    def run(image, args):
        command = ['docker', 'run', '--rm', '--network', 'none', '--cap-drop', 'ALL',
                   '--security-opt', 'no-new-privileges:true', '--memory', '2g', '--cpus', '2',
                   '--pids-limit', '256', '--mount', f'type=bind,source={skills},destination=/opt/workbench-global/skills,readonly',
                   '--entrypoint', 'node', image, *args]
        result = subprocess.run(command, capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise RuntimeError('Candidate resource verification failed: ' + result.stderr[-1500:])
        return json.loads(result.stdout)
    for image in (host_image, sandbox_image):
        if run(image, ['-e', script]) != manifest['files']:
            raise ValueError('Candidate runtime cannot read the complete global skill tree')
    runtime = run(sandbox_image, ['/opt/workbench/verify-runtime.mjs'])
    verify_font_runtime(runtime, fonts)
    return {'skills': manifest['skills'], 'skillFiles': len(manifest['files']), **runtime,
            'hostImage': host_image, 'sandboxImage': sandbox_image, 'globalSkillMount': 'readonly'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--resources', required=True, help='Docker-host directory containing skills-manifest.json, skills/, fonts/manifest.json')
    parser.add_argument('--sandbox-image', required=True)
    parser.add_argument('--host-image', required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.resources, args.sandbox_image, args.host_image), ensure_ascii=False))
