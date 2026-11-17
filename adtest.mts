import { GitClient } from './spec/conformance/git-client.ts';
const c = new GitClient({ baseUrl: 'http://127.0.0.1:40941', token: 'tok123' } as any);
try {
  const a = await (c as any).advertisement('adaiversen', 'amber-thistle', 'git-upload-pack', {});
  console.log('v2 pref:', JSON.stringify({protocol: a.protocol, caps: [...(a.capabilities||[])].slice(0,5)}));
} catch (e) { console.log('v2 ERR:', (e as Error).message); }
try {
  const c0 = new GitClient({ baseUrl: 'http://127.0.0.1:40941', token: 'tok123', gitProtocol: 0 } as any);
  const a0 = await (c0 as any).advertisement('adaiversen', 'amber-thistle', 'git-upload-pack', {});
  console.log('v0 pref:', JSON.stringify({protocol: a0.protocol, refs: (a0.refs||[]).slice(0,3).map((r:any)=>r.name)}));
} catch (e) { console.log('v0 ERR:', (e as Error).message); }
