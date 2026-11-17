const PORT = process.argv[2];
const r = await fetch(`http://127.0.0.1:${PORT}/adaiversen/amber-thistle.git/info/refs?service=git-upload-pack`, {headers:{'Authorization':'Bearer tok123'}});
console.log(r.status, r.headers.get('content-type'));
const t = await r.text();
console.log(JSON.stringify(t.slice(0, 200)));
