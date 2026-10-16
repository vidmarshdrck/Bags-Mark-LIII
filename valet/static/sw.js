// Network first so updates always show; cache is only the offline fallback.
const C='valet-v4',A=['./','index.html','app.css','app.js','agents.js','mock.js','manifest.webmanifest','icon-192.png','icon-512.png','fonts/rajdhani-500.ttf','fonts/rajdhani-600.ttf','fonts/manrope-400.ttf','fonts/manrope-600.ttf'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!='GET'||u.origin!=location.origin||/\/(api|health)(\/|$)/.test(u.pathname))return;
 e.respondWith(fetch(e.request).then(r=>{if(r.ok){const c=r.clone();caches.open(C).then(x=>x.put(e.request,c))}return r}).catch(()=>caches.match(e.request,{ignoreSearch:true})))});
