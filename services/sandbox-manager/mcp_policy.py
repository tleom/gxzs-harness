"""Deployment-owned MCP resource policy, shared with API and owner hosts."""
import json
import math
import os


DEFAULTS = {
    'request_bytes': 30 * 1024 * 1024,
    'response_bytes': 30 * 1024 * 1024,
    'connect_timeout_seconds': 60,
    'initialize_timeout_seconds': 60,
    'discovery_timeout_seconds': 60,
    'startup_timeout_seconds': 120,
    'catalog_timeout_seconds': 180,
    'call_timeout_seconds': 60,
    'max_call_seconds': 350,
    'write_timeout_seconds': 30,
    'control_timeout_seconds': 15,
    'control_retry_attempts': 3,
    'cleanup_timeout_seconds': 6,
    'response_grace_seconds': 15,
    'outcome_lock_seconds': 10,
    'cancel_retention_seconds': 600,
    'cancellation_check_timeout_seconds': 0.5,
    'receipt_retention_seconds': 3600,
    'supervisor_input_buffer_bytes': 2 * 1024 * 1024,
    'supervisor_output_buffer_bytes': 16 * 1024 * 1024,
    'max_active_calls': 64,
    'max_owner_calls': 8,
    'max_connections': 64,
    'max_idle_connections': 32,
    'max_owner_idle_connections': 4,
    'idle_seconds': 300,
    'discovery_parallelism': 8,
    'discovery_cache_entries': 512,
    'discovery_cache_seconds': 60,
    'discovery_failure_seconds': 30,
    'refresh_retry_seconds': 30,
    'refresh_interval_seconds': 30,
    'refresh_failure_seconds': 5,
    'source_archive_bytes': 50 * 1024 * 1024,
    'source_download_timeout_seconds': 120,
}


def validate(value):
    if not isinstance(value, dict) or set(value) - DEFAULTS.keys():
        raise ValueError('Invalid MCP resource policy keys')
    result = {**DEFAULTS, **value}
    for key, number in result.items():
        if type(number) not in (int, float) or not math.isfinite(number) or number <= 0:
            raise ValueError('MCP resource policy values must be positive finite numbers: ' + key)
        if key.endswith('_seconds') and not 0.001 <= number <= (2**31 - 1) / 1000:
            raise ValueError('MCP resource policy duration exceeds runtime timer range: ' + key)
        if key.endswith('_bytes') and number > 2**31 - 2:
            raise ValueError('MCP transport budget exceeds runtime addressable message size: ' + key)
        if not key.endswith('_seconds') and (type(number) is not int or number > 2**31 - 1):
            raise ValueError('MCP resource policy capacity must be an integer: ' + key)
    return result


_policy = validate(json.loads(os.environ.get('GXZS_MCP_POLICY', '{}')))


def current():
    return dict(_policy)


def configure(value):
    """Only manager-authored interpreter bootstrap may replace this snapshot."""
    global _policy
    _policy = validate(value)


def get(key):
    return _policy[key]
