"""Real worker/stdio protocol extension frames on the core SDK session."""
import json
import sys
import time
import pytest
from test_mcp_worker import Connection, SERVER, modules, pytestmark

TASK_SERVER = r'''
import json, sys
modern = sys.argv[1] == 'modern'
created = 0
status = 'working'
observed = sys.argv[2] if len(sys.argv)>2 else None
result_attempts = 0
def task():
    if modern:
        return {'taskId':'one-task','status':status,'createdAt':'2026-10-24T00:00:00Z',
                'lastUpdatedAt':'2026-10-24T00:00:00Z','ttlMs':60000,'pollIntervalMs':1}
    return {'taskId':'one-task','status':status,'createdAt':'2026-10-24T00:00:00Z',
            'lastUpdatedAt':'2026-10-24T00:00:00Z','ttl':60000,'pollInterval':1}
for line in sys.stdin:
    request=json.loads(line)
    if 'id' not in request: continue
    method=request['method']
    if method=='server/discover':
        reply = ({'result':{'supportedVersions':['2026-07-28'],'capabilities':{'tools':{},
                 'extensions':{'io.modelcontextprotocol/tasks':{}}},'resultType':'complete','ttlMs':0,'cacheScope':'public'}}
                 if modern else {'error':{'code':-32601,'message':'legacy'}})
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],**reply}),flush=True)
        continue
    if modern:
        meta = request['params']['_meta']
        assert meta['io.modelcontextprotocol/protocolVersion']=='2026-07-28'
        assert meta['io.modelcontextprotocol/clientInfo']['name']
        assert meta['io.modelcontextprotocol/clientCapabilities']['extensions']['io.modelcontextprotocol/tasks']=={}
    if method=='initialize':
        result={'protocolVersion':'2025-11-25','serverInfo':{'name':'tasks','version':'1'},
                'capabilities':{'tools':{},'tasks':{'requests':{'tools':{'call':{}}},'cancel':{}}}}
    elif method=='tools/list':
        result={'tools':[{'name':'report','inputSchema':{'type':'object'},'execution':{'taskSupport':'required'}}]}
        if modern: result.update(resultType='complete',ttlMs=0,cacheScope='public')
    elif method=='tools/call':
        assert request['params']['name']=='report'
        assert request['params']['arguments']=={'fixture':'kept'}
        if not modern: assert request['params']['task']=={}
        created+=1
        result={**task(),'resultType':'task'} if modern else {'task':task()}
    elif method=='tasks/get':
        assert request['params']['taskId']=='one-task'
        if observed and status=='working': status=observed
        result=task()
        if modern:
            result['resultType']='complete'
            if status=='completed': result['result']={'resultType':'complete','content':[{'type':'text','text':str(created)}]}
            if status=='failed': result['error']={'code':-32000,'message':'fixture failed'}
    elif method=='tasks/result':
        result_attempts+=1
        if observed=='completed' and result_attempts==1:
            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32000,'message':'result temporarily unavailable'}}),flush=True)
            continue
        result={'content':[{'type':'text','text':str(created)}]}
    elif method=='tasks/cancel':
        assert request['params']['taskId']=='one-task'
        status='cancelled'
        result={'resultType':'complete'} if modern else task()
    else: raise Exception(method)
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
'''


@pytest.mark.parametrize('generation', ['legacy', 'modern'])
def test_task_frames_retain_capabilities_and_same_session_without_replaying(modules, tmp_path, generation):
    base, ops = modules
    script = tmp_path/'task-server.py'
    script.write_text(TASK_SERVER)
    config = {'transport':'stdio','command':sys.executable,'args':[str(script),generation],'cwd':'/workspace','env':{},'timeout':10}
    ops.personal_mcp({'operation':'mcp_save','name':'demo','content':json.dumps(config)}, str(tmp_path))
    version = ops.personal_mcp({'operation':'mcp_probe','name':'demo'}, str(tmp_path))['version']
    conn = Connection(base, tmp_path, version)
    try:
        capabilities=conn.ready['server_info']['capabilities']
        assert ('tasks' in capabilities if generation=='legacy' else
                'io.modelcontextprotocol/tasks' in capabilities['extensions'])
        def request(method, params):
            return conn.call('report', operation='mcp_task', method=method, params=params,
                             deadline_ms=int(time.time()*1000)+10000)
        created = request('tools/call', {'name':'report','arguments':{'fixture':'kept'},**({'task':{}} if generation=='legacy' else {})})
        assert created['result'].get('task',created['result'])['taskId']=='one-task', created
        assert request('tasks/get', {'taskId':'one-task'})['result']['status']=='working'
        cancelled=request('tasks/cancel', {'taskId':'one-task'})
        if generation=='legacy':
            assert cancelled['result']['status']=='cancelled'
            assert cancelled['tasks_active_until']==0
        else:
            assert cancelled['result']['resultType']=='complete'
            assert cancelled['tasks_active_until']>time.time()*1000
            final=request('tasks/get', {'taskId':'one-task'})
            assert final['result']['status']=='cancelled'
            assert final['tasks_active_until']==0
        assert request('tasks/get', {'taskId':'one-task'})['result']['status']=='cancelled'
        assert '连接已失效' in request('tasks/get', {'taskId':'another-owner-task'})['error']
        assert conn.call('report', operation='mcp_test')['ready'], 'settling a task keeps the shared worker alive'
    finally:
        conn.close()


@pytest.mark.parametrize('generation', ['legacy', 'modern'])
@pytest.mark.parametrize('status', ['failed', 'cancelled', 'completed'])
def test_terminal_task_pins_and_result_retry(modules, tmp_path, generation, status):
    base, ops = modules
    script = tmp_path/'terminal-server.py'
    script.write_text(TASK_SERVER)
    config = {'transport':'stdio','command':sys.executable,'args':[str(script),generation,status],
              'cwd':'/workspace','env':{},'timeout':10}
    ops.personal_mcp({'operation':'mcp_save','name':'demo','content':json.dumps(config)}, str(tmp_path))
    version = ops.personal_mcp({'operation':'mcp_probe','name':'demo'}, str(tmp_path))['version']
    conn = Connection(base, tmp_path, version)
    def request(method, params):
        return conn.call('report', operation='mcp_task', method=method, params=params,
                         deadline_ms=int(time.time()*1000)+10000)
    try:
        started=request('tools/call', {'name':'report','arguments':{'fixture':'kept'},**({'task':{}} if generation=='legacy' else {})})
        assert started['tasks_active_until']>time.time()*1000
        terminal=request('tasks/get', {'taskId':'one-task'})
        assert terminal['result']['status']==status
        if status=='completed' and generation=='legacy':
            assert terminal['tasks_active_until']>time.time()*1000
            unavailable=request('tasks/result', {'taskId':'one-task'})
            assert unavailable['error']['message']=='result temporarily unavailable'
            assert unavailable['tasks_active_until']>time.time()*1000
            terminal=request('tasks/result', {'taskId':'one-task'})
            assert terminal['result']['content'][0]['text']=='1'
        assert terminal['tasks_active_until']==0
        # Treat the previous reply as lost between worker and manager. Recovery
        # reuses this task and connection, without another tools/call or active pin.
        recovered=request('tasks/result' if status=='completed' and generation=='legacy' else 'tasks/get', {'taskId':'one-task'})
        assert recovered['result']==terminal['result']
        assert recovered['tasks_active_until']==0
        assert conn.call('report', operation='mcp_test')['ready']
    finally:
        conn.close()


def test_modern_task_frames_are_accepted_by_the_core_sdk(modules, tmp_path):
    base, ops = modules
    script = tmp_path/'sdk-server.py'
    script.write_text(SERVER)
    config = {'transport':'stdio','command':sys.executable,'args':[str(script),'stdio'],
              'cwd':'/workspace','env':{},'timeout':10}
    ops.personal_mcp({'operation':'mcp_save','name':'demo','content':json.dumps(config)}, str(tmp_path))
    version = ops.personal_mcp({'operation':'mcp_probe','name':'demo'}, str(tmp_path))['version']
    conn = Connection(base, tmp_path, version)
    try:
        assert conn.ready['server_info']['protocolVersion']=='2026-07-28'
        result = conn.call('add', operation='mcp_task', method='tools/call',
                          params={'name':'add','arguments':{'value':1}},
                          deadline_ms=int(time.time()*1000)+10000)
        assert result.get('result',{}).get('structuredContent',{}).get('value')==2, result
    finally:
        conn.close()


@pytest.mark.parametrize('generation', ['legacy', 'modern'])
@pytest.mark.parametrize('expire_query', [False, True])
def test_inflight_query_can_be_cancelled_and_deadline_does_not_destroy_connection(modules, tmp_path, generation, expire_query):
    base, ops = modules
    script = tmp_path / 'concurrent-server.py'
    entered = tmp_path / 'query-entered'
    server = TASK_SERVER.replace('import json, sys', 'import json, sys, threading, time\nfrom pathlib import Path')
    server = server.replace('for line in sys.stdin:', 'def handle(line):\n    global created, status, result_attempts')
    server = server.replace('continue', 'return')
    server = server.replace("        result=task()", "        result=task()\n        Path(" + repr(str(entered)) + ").write_text('entered')\n        time.sleep(.8)")
    server += '\nfor line in sys.stdin:\n    threading.Thread(target=handle,args=(line,),daemon=True).start()\n'
    script.write_text(server)
    ops.personal_mcp({'operation': 'mcp_save', 'name': 'demo', 'content': json.dumps({
        'command': sys.executable, 'args': [str(script), generation], 'timeout': 5})}, str(tmp_path))
    version = ops.personal_mcp({'operation': 'mcp_probe', 'name': 'demo'}, str(tmp_path))['version']
    conn = Connection(base, tmp_path, version)
    def send(method, request_id, deadline=5000):
        params = {'name': 'report', 'arguments': {'fixture': 'kept'}, **({'task': {}} if generation == 'legacy' else {})} if method == 'tools/call' else {'taskId': 'one-task'}
        request = {'operation': 'mcp_task', 'manifest_version': conn.ready['manifest_version'], 'request_id': request_id,
                   'method': method, 'params': params, 'deadline_ms': int(time.time()*1000) + deadline}
        conn.process.stdin.write(json.dumps(request).encode() + b'\n')
        conn.process.stdin.flush()
    try:
        send('tools/call', 'create')
        assert conn.read()['request_id'] == 'create'
        send('tasks/get', 'query', 150 if expire_query else 5000)
        until = time.monotonic() + 2
        while not entered.exists() and time.monotonic() < until:
            time.sleep(.01)
        assert entered.exists()
        if expire_query:
            assert conn.read()['code'] == 'MCP_TASK_TIMEOUT'
        before = time.monotonic()
        send('tasks/cancel', 'cancel')
        response = conn.read()
        assert response['request_id'] == 'cancel', response
        assert time.monotonic() - before < .6
        assert not response.get('uncertain')
        if not expire_query:
            late = conn.read()
            assert late['request_id'] == 'query'
        assert conn.call('report', operation='mcp_test')['ready']
    finally:
        conn.close()
