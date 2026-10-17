"""Readable container names; immutable owner, workspace and generation remain authoritative."""
import os
import re


def account_names(owner, account):
    if account is None:
        return {}
    tenant, user = owner.split(':', 1)
    if not user.isdecimal() or not isinstance(account, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,29}', account):
        raise ValueError('Invalid runtime account name')
    prefix = os.environ.get('GXZS_RUNTIME_PREFIX', 'gxzs')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,19}', prefix):
        raise ValueError('Invalid runtime container prefix')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,19}', tenant):
        raise ValueError('Invalid runtime account tenant')
    # A dot cannot occur in either identifier, so tenant boundaries cannot
    # collide with a default-tenant account such as "000001-admin".
    suffix = account.lower() if tenant == '000000' else tenant.lower() + '.' + account.lower()
    names = {'account_name': account, 'container_name': prefix + '-host-' + suffix,
             'sandbox_name': prefix + '-sandbox-' + suffix}
    if any(len(names[key]) > 63 for key in ('container_name', 'sandbox_name')):
        raise ValueError('Runtime container name exceeds the DNS label limit')
    return names


def host_name(record):
    return record.get('container_name') or record['instance_id']


def volume_prefix(record, sandbox):
    return record.get('sandbox_volume_prefix') or sandbox
