"""Readable container names; immutable owner, workspace and generation remain authoritative."""
import os
import re


OWNER_ID = re.compile(r'gxzs-(?P<user_id>[1-9][0-9]{0,18})')
MAX_USER_ID = 2**63 - 1


def match_owner_id(owner):
    if not isinstance(owner, str):
        return None
    match = OWNER_ID.fullmatch(owner)
    if match and int(match['user_id']) <= MAX_USER_ID:
        return match
    return None


def account_names(owner, account):
    if account is None:
        return {}
    identity = match_owner_id(owner)
    if not identity or not isinstance(account, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,29}', account):
        raise ValueError('Invalid runtime account name')
    prefix = os.environ.get('GXZS_RUNTIME_PREFIX', 'gxzs')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,19}', prefix):
        raise ValueError('Invalid runtime container prefix')
    suffix = account.lower()
    names = {'account_name': account, 'container_name': prefix + '-host-' + suffix,
             'sandbox_name': prefix + '-sandbox-' + suffix}
    if any(len(names[key]) > 63 for key in ('container_name', 'sandbox_name')):
        raise ValueError('Runtime container name exceeds the DNS label limit')
    return names


def host_name(record):
    return record.get('container_name') or record['instance_id']


def volume_prefix(record, sandbox):
    return record.get('sandbox_volume_prefix') or sandbox
