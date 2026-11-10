/* Pitchside service worker: offline app shell + push notifications */
const CACHE='pitchside-v1';
const SHELL=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.origin!==location.origin)return;
  if(r.mode==='navigate'){e.respondWith(fetch(r).then(res=>{const c=res.clone();caches.open(CACHE).then(x=>x.put('./index.html',c));return res}).catch(()=>caches.match('./index.html')));return}
  e.respondWith(caches.match(r).then(m=>m||fetch(r)))});
/* push (Firebase Cloud Messaging data/notification payloads) */
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={notification:{title:'Pitchside',body:e.data?e.data.text():''}}}
  const n=d.notification||{},data=Object.assign({},d.data||{},(d.fcmOptions||{}));
  e.waitUntil(self.registration.showNotification(n.title||data.title||'Pitchside',{body:n.body||data.body||'',icon:'icon-192.png',badge:'icon-192.png',tag:data.tag||undefined,data:{link:data.link||(d.fcmOptions&&d.fcmOptions.link)||'./'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const link=(e.notification.data&&e.notification.data.link)||'./';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if('focus' in c){c.navigate(link).catch(()=>{});return c.focus()}}return self.clients.openWindow(link)}))});
