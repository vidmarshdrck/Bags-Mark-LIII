const C='valet-v2',A=['fonts/rajdhani-500.ttf','fonts/rajdhani-600.ttf','fonts/manrope-400.ttf','fonts/manrope-600.ttf','./','index.html','app.css','app.js','agents.js','mock.js','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x))))));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.pathname.includes('/api/'))return;
 e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)))});
