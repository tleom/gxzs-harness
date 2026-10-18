#!/usr/bin/env python3
"""Disposable multi-owner stack using pinned production or candidate image IDs.

Only names, paths and identities in this invocation's manifest may be mutated.
No production environment file, model credential or database is copied.
"""
import argparse,base64,concurrent.futures,hashlib,hmac,ipaddress,json,os,pathlib,secrets,subprocess,time,urllib.error,urllib.request,uuid

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('action',choices=['up','owners','pilot','status'])
parser.add_argument('--root',required=True)
parser.add_argument('--owners',type=int,default=2)
parser.add_argument('--pool',default='10.247.128.0/18')
parser.add_argument('--model-port',type=int,default=15012)
parser.add_argument('--manager-port',type=int,default=15010)
parser.add_argument('--sandbox-image',help='Explicit candidate sandbox image; defaults to the installed production image')
parser.add_argument('--host-image',help='Explicit candidate Host image')
parser.add_argument('--manager-image',help='Explicit candidate Manager image')
parser.add_argument('--account-names',action='store_true',help='Exercise readable names in an isolated runtime namespace')
parser.add_argument('--global-skills-dir',help='Verified Docker-host skill directory to mount read-only in fixture runtimes')
args=parser.parse_args()
if args.global_skills_dir:
 skill_root=pathlib.Path(args.global_skills_dir)
 assert skill_root.is_absolute() and skill_root.is_dir() and list(skill_root.glob('*/SKILL.md')),'Expected a populated absolute global skill directory'
root=pathlib.Path(args.root).resolve()
assert root.name.startswith('gxzs-simulated-soak-') and root.parent==pathlib.Path('/home/jrgx')
root.mkdir(exist_ok=True,mode=0o700);os.umask(0o077)
source=pathlib.Path(__file__).resolve().parent
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
manifest=root/'stack-private.json'

def docker(*values,check=True,timeout=180):
 result=subprocess.run(['docker',*values],capture_output=True,text=True,timeout=timeout)
 if check and result.returncode:raise RuntimeError('Docker operation failed: '+result.stderr[-1500:])
 return result
def inspect(name):return json.loads(docker('inspect',name).stdout)[0]
def save(path,value):
 temporary=path.with_suffix(path.suffix+'.tmp');temporary.write_text(json.dumps(value,indent=2));temporary.replace(path)
def http(url,method='GET',body=None,headers=None,timeout=45):
 data=None if body is None else json.dumps(body).encode()
 request=urllib.request.Request(url,data=data,headers={'Content-Type':'application/json',**(headers or {})},method=method)
 try:
  with opener.open(request,timeout=timeout) as response:return response.status,json.load(response)
 except urllib.error.HTTPError as error:
  raw=error.read()
  try:return error.code,json.loads(raw)
  except ValueError:return error.code,{'nonJsonBodyBytes':len(raw)}
def manager(path,body=None):
 status,value=http(config['managerURL']+path,'POST' if body is not None else 'GET',body,{'Authorization':'Bearer '+config['token']},timeout=180)
 if status>=300:raise RuntimeError('Fixture manager '+str(status)+': '+str(value))
 return value
def bindings():
 return {row['owner_id']:row for row in json.loads((root/'output/bindings.json').read_text())}
def signed(row,method,path,body=None,timeout=45):
 raw=b'' if body is None else json.dumps(body).encode();now=int(time.time());owner=row['owner_id'];tenant,user=owner.split(':')
 key=hmac.new(base64.b64decode(config['assertionKey']),f"assertion\n{owner}\n{row['generation']}\n{row['instance_id']}".encode(),hashlib.sha256).digest()
 claims={'iss':'gxzs-simulator','aud':'agent-workbench','sub':owner,'tenant_id':tenant,'user_id':user,'name':'synthetic-owner','iat':now,'exp':now+60,'jti':str(uuid.uuid4()),'method':method,'target':'/ai/workbench'+path,'body_sha256':hashlib.sha256(raw).hexdigest(),'content_type':'application/json' if body is not None else '', 'last_event_id':''}
 encode=lambda value:base64.urlsafe_b64encode(value).decode().rstrip('=')
 message=encode(json.dumps({'alg':'HS256','typ':'JWT'}).encode())+'.'+encode(json.dumps(claims).encode())
 token=message+'.'+encode(hmac.new(key,message.encode(),hashlib.sha256).digest())
 request=urllib.request.Request(row['endpoint']+'/ai/workbench'+path,data=raw if body is not None else None,method=method,headers={'X-GXZS-Assertion':token,**({'Content-Type':'application/json'} if body is not None else {})})
 try:
  with opener.open(request,timeout=timeout) as response:return json.load(response)['data']
 except urllib.error.HTTPError as error:raise RuntimeError('Host '+str(error.code)+': '+error.read(2000).decode()) from None

if args.action=='up':
 assert not manifest.exists(),'An existing stack must be inspected, not recreated'
 # Docker DNS labels must fit 63 bytes, including the sandbox UUID suffix.
 prefix='gxzs-soak-'+hashlib.sha256(root.name.encode()).hexdigest()[:8]
 for name in (prefix+'-manager',prefix+'-simulator'):assert docker('inspect',name,check=False).returncode!=0
 production=inspect('gxzs-sandbox-manager');env=dict(item.split('=',1) for item in production['Config']['Env'])
 images={key:json.loads(docker('image','inspect',env[name]).stdout)[0]['Id'] for key,name in [('host','GXZS_HOST_IMAGE'),('sandbox','WORKBENCH_SANDBOX_IMAGE')]}
 images['manager']=production['Image']
 networks=json.loads(docker('network','inspect',*docker('network','ls','-q').stdout.split()).stdout)
 pool=ipaddress.ip_network(args.pool)
 assert pool.version==4 and pool.is_private and 16<=pool.prefixlen<=22
 assert 1024<=args.model_port<=65535 and 1024<=args.manager_port<=65535 and args.model_port!=args.manager_port
 if args.sandbox_image:images['sandbox']=json.loads(docker('image','inspect',args.sandbox_image).stdout)[0]['Id']
 if args.host_image:images['host']=json.loads(docker('image','inspect',args.host_image).stdout)[0]['Id']
 if args.manager_image:images['manager']=json.loads(docker('image','inspect',args.manager_image).stdout)[0]['Id']
 helper_path='/opt/workbench/profiles/workbench/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'
 helper=docker('run','--rm','--network','none','--entrypoint','sha256sum',images['host'],helper_path).stdout.split()[0]
 assert helper==docker('run','--rm','--network','none','--entrypoint','sha256sum',images['sandbox'],helper_path).stdout.split()[0],'Candidate Host/Sandbox helper mismatch'
 assert all(not pool.overlaps(ipaddress.ip_network(item['Subnet'])) for network in networks for item in (network.get('IPAM',{}).get('Config') or []) if item.get('Subnet') and ':' not in item['Subnet'])
 (root/'output').mkdir(exist_ok=True);(root/'state').mkdir(exist_ok=True)
 config={'prefix':prefix,'token':secrets.token_hex(32),'assertionKey':base64.b64encode(secrets.token_bytes(32)).decode(),'publicURL':f'http://10.16.9.237:{args.model_port}','managerURL':f'http://10.16.9.237:{args.manager_port}','images':images,'pool':str(pool),'owners':[],'accountNames':args.account_names}
 save(manifest,config)
 credentials=root/'fixture-credentials.yaml';credentials.write_text('version: 1\nrefs:\n  GXZS_SIM_MODEL_KEY: '+config['token']+'\nrecords: {}\n')
 container_config={**config,'host':'0.0.0.0','port':args.model_port,'output':'/output'};save(root/'simulator-private.json',container_config)
 # The production Host image runs as gxzs (UID/GID 1000). Keep private files
 # private while allowing that user to read its config and persist fixture data.
 os.chown(root/'simulator-private.json',1000,1000)
 os.chown(root/'output',1000,1000)
 manager_env={'WORKBENCH_SANDBOX_MANAGER_TOKEN':config['token'],'WORKBENCH_SANDBOX_IMAGE':images['sandbox'],'WORKBENCH_SANDBOX_PREFIX':prefix+'-sbx','WORKBENCH_SANDBOX_NETWORK':prefix+'-net','WORKBENCH_SANDBOX_ADDRESS_POOL':config['pool'],'WORKBENCH_SANDBOX_SUBNET_PREFIX':'27','WORKBENCH_MANAGER_HOST_STATE':str(root/'state'),'GXZS_HOST_IMAGE':images['host'],'GXZS_HOST_PLATFORM_URL':config['publicURL']+'/internal/workbench','GXZS_HOST_MANAGER_URL':config['managerURL'],'GXZS_HOST_ADVERTISE_IP':'10.16.9.237','GXZS_HOST_BIND_IP':'10.16.9.237','GXZS_ORCHESTRATOR_TOKEN':config['token'],'GXZS_SANDBOX_HELPER_HASH':helper,'GXZS_HOST_CREDENTIALS_FILE':'/fixture-credentials.yaml','WORKBENCH_RUNTIME_CONTAINER':prefix+'-simulator','WORKBENCH_MCP_API_URL':config['publicURL']}
 for key in ['GXZS_HOST_CPUS','GXZS_HOST_MEMORY','WORKBENCH_SANDBOX_CPUS','WORKBENCH_SANDBOX_MEMORY','WORKBENCH_SANDBOX_PIDS_LIMIT','WORKBENCH_MANAGER_MAX_OPERATIONS']:
  if key in env:manager_env[key]=env[key]
 if args.account_names:manager_env['GXZS_RUNTIME_PREFIX']=prefix
 if args.global_skills_dir:manager_env['GXZS_GLOBAL_SKILL_HOST_DIR']=str(skill_root)
 (root/'manager-private.env').write_text(''.join(key+'='+value+'\n' for key,value in manager_env.items()))
 docker('run','-d','--name',prefix+'-simulator','--label','gxzs.simulator='+prefix,'--memory','1g','--cpus','2','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true','--no-healthcheck','-p',f'10.16.9.237:{args.model_port}:{args.model_port}','-v',str(source)+':/fixture:ro','-v',str(root/'output')+':/output','-v',str(root/'simulator-private.json')+':/fixture-config.json:ro','--entrypoint','node',images['host'],'/fixture/platform.mjs','/fixture-config.json')
 manager_limits=production['HostConfig']
 docker('run','-d','--name',prefix+'-manager','--label','gxzs.simulator='+prefix,'--memory',str(manager_limits['Memory']),'--cpus',str(manager_limits['NanoCpus']/1e9),'--pids-limit',str(manager_limits['PidsLimit']),'-p',f'10.16.9.237:{args.manager_port}:5010','-v','/var/run/docker.sock:/var/run/docker.sock','-v',str(root/'state')+':/state','-v',str(credentials)+':/fixture-credentials.yaml:ro','--env-file',str(root/'manager-private.env'),images['manager'])
 for attempt in range(30):
  try:
   assert http(config['publicURL']+'/healthz')[0]==200 and manager('/healthz')['ok'];break
  except Exception:time.sleep(1)
 else:raise RuntimeError('Fixture services are not ready')
 save(root/'stack-proof.json',{'images':images,'prefix':prefix,'productionSettingsCopied':False,'paidCredentialsCopied':False,'globalAdmissionLimitsUnmodified':True,'createdAt':time.time()})
 print(json.dumps({'ready':True,'images':images,'paidCredentialsCopied':False}))
else:
 config=json.loads(manifest.read_text())
 if args.action=='owners':
  assert 1<=args.owners<=30
  def ensure(index):
   owner='soak1017:'+str(910000+index);workspace=str(uuid.uuid5(uuid.NAMESPACE_DNS,config['prefix']+':'+owner));instance=config['prefix']+'-host-'+str(index)
   payload={'owner_id':owner,'generation':1,'instance_id':instance,'assertion_issuer':'gxzs-simulator','assertion_key':config['assertionKey'],'platform_token':config['token'],'image_digest':config['images']['host']}
   if config.get('accountNames'):payload['account_name']='00066943' if index==1 else 'admin' if index==2 else 'soak_'+str(index)
   row=manager('/sandboxes/'+workspace+'/ensure-host',payload)
   return {'owner':owner,'workspace':workspace,'instance':instance}
  with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
   rows=list(pool.map(ensure,range(1,args.owners+1)))
  config['owners']=rows;save(manifest,config)
  started=time.monotonic()
  while time.monotonic()-started<240:
   current=bindings();ready=sum(current.get(row['owner'],{}).get('state')=='ready' for row in rows)
   if ready==len(rows):break
   print(json.dumps({'ready':ready,'total':len(rows)}),flush=True);time.sleep(10)
  assert ready==len(rows),'Some synthetic owners did not become ready'
  print(json.dumps({'ready':ready,'identities':'isolated synthetic owners; no production user rows'}))
 elif args.action=='pilot':
  owner=config['owners'][0]['owner'];row=bindings()[owner]
  chat=signed(row,'POST','/chats',{});case={'id':'pilot001','rounds':5,'stepDelayMs':100}
  run=signed(row,'POST','/chats/'+chat['id']+'/runs',{'query':'GXZS_SIM_CASE '+json.dumps(case),'request_key':'pilot-'+uuid.uuid4().hex,'version':chat['version']})
  cursor='0-0';events=[];start=time.monotonic()
  while time.monotonic()-start<120:
   result=signed(row,'GET','/runs/'+run['id']+'?after='+cursor);events+=result['events'];cursor=result['events_cursor']
   if result['history_complete'] and result['status'] not in ['running','queued','stopping']:break
   time.sleep(1)
  save(root/'pilot-events.json',events)
  proof={'status':result['status'],'seconds':round(time.monotonic()-start,2),'events':len(events),'paidModelCalls':0}
  save(root/'pilot-proof.json',proof);print(json.dumps(proof));assert result['status']=='completed'
 elif args.action=='status':
  rows=bindings();health=[]
  for row in rows.values():
   status,value=http(row['endpoint']+'/ai/workbench/health',timeout=8)
   health.append({'owner':row['owner_id'],'state':row['state'],'status':status,'health':value})
  print(json.dumps({'owners':len(rows),'ready':sum(row['state']=='ready' for row in rows.values()),'manager':manager('/healthz'),'health':health}))
