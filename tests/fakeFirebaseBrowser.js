// Firebase simulado para el navegador (prueba de laboratorio del panel). Sin red.
(function () {
  const store = {}; // path -> data
  const listeners = [];
  class Ts { constructor(s, n) { this.seconds = s; this.nanoseconds = n || 0; } toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); } toDate() { return new Date(this.toMillis()); } static fromMillis(m) { return new Ts(Math.floor(m / 1000), (m % 1000) * 1e6); } static now() { return Ts.fromMillis(Date.now()); } }
  const SV = { __sv: 1 };
  const inc = n => ({ __inc: n }), aU = v => ({ __au: v });
  function resolve(old, d) {
    const o = Object.assign({}, old || {});
    for (const k of Object.keys(d)) {
      let v = d[k];
      if (v === SV) v = Ts.now(); else if (v && v.__inc !== undefined) v = ((k.includes('.') ? 0 : o[k]) || 0) + v.__inc; else if (v && v.__au) v = (o[k] || []).concat([v.__au]);
      if (k.includes('.')) { const [a, b] = k.split('.'); o[a] = Object.assign({}, o[a], { [b]: (v && v.__inc !== undefined) ? ((o[a] || {})[b] || 0) + v.__inc : v }); } else o[k] = v;
    }
    return o;
  }
  const notify = () => listeners.slice().forEach(l => l());
  class Doc { constructor(p) { this.path = p; this.id = p.split('/').pop(); }
    get ref() { return this; }
    collection(n) { return new Col(this.path + '/' + n); }
    snap() { const d = store[this.path]; return { id: this.id, ref: this, exists: d !== undefined, data: () => d === undefined ? undefined : JSON.parse(JSON.stringify(d), rev) }; }
    async get() { return this.snap(); }
    async set(d, o) { store[this.path] = resolve(o && o.merge ? store[this.path] : {}, d); notify(); }
    async update(d) { if (store[this.path] === undefined) throw { code: 'not-found' }; store[this.path] = resolve(store[this.path], d); notify(); }
    async delete() { delete store[this.path]; notify(); }
    onSnapshot(cb) { const f = () => cb(this.snap()); listeners.push(f); setTimeout(f, 0); return () => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); }; } }
  function rev(k, v) { return v && typeof v === 'object' && 'seconds' in v && 'nanoseconds' in v && Object.keys(v).length === 2 ? new Ts(v.seconds, v.nanoseconds) : v; }
  class Col { constructor(p) { this.path = p; this.f = []; this.o = null; this.l = null; }
    doc(id) { return new Doc(this.path + '/' + (id || 'a' + Math.random().toString(36).slice(2, 10))); }
    async add(d) { const r = this.doc(); await r.set(d); return r; }
    where(a, op, b) { const c = this.clone(); c.f.push([a, op, b]); return c; }
    orderBy(a, dir) { const c = this.clone(); c.o = [a, dir || 'asc']; return c; }
    limit(n) { const c = this.clone(); c.l = n; return c; }
    clone() { const c = new Col(this.path); c.f = this.f.slice(); c.o = this.o; c.l = this.l; return c; }
    run() { const pre = this.path + '/'; let docs = Object.keys(store).filter(k => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(k => new Doc(k).snap());
      this.f.forEach(([a, op, b]) => { docs = docs.filter(d => { const v = d.data()[a]; return op === '==' ? v === b : op === 'array-contains' ? (v || []).includes(b) : true; }); });
      if (this.o) { const [a, dir] = this.o, m = x => { const v = x.data()[a]; return v && v.toMillis ? v.toMillis() : v; }; docs.sort((x, y) => (m(x) > m(y) ? 1 : m(x) < m(y) ? -1 : 0) * (dir === 'desc' ? -1 : 1)); }
      if (this.l) docs = docs.slice(0, this.l); return { docs, empty: !docs.length, size: docs.length, forEach: fn => docs.forEach(fn) }; }
    async get() { return this.run(); }
    onSnapshot(cb) { const f = () => cb(this.run()); listeners.push(f); setTimeout(f, 0); return () => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); }; } }
  const db = { collection: n => new Col(n), batch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), update: (r, d) => ops.push(() => r.update(d)), delete: r => ops.push(() => r.delete()), commit: async () => { for (const f of ops) await f(); } }; }, runTransaction: async fn => fn({ get: r => r.get(), set: (r, d, o) => r.set(d, o), update: (r, d) => r.update(d) }) };
  const user = { uid: 'owner1', email: 'dueno@test.com', emailVerified: true, getIdToken: async () => 'tok:owner1:dueno@test.com' };
  let cb = null;
  const auth = { onAuthStateChanged: f => { cb = f; setTimeout(() => f(window.__loggedOut ? null : user), 50); }, signOut: async () => { cb && cb(null); }, signInWithEmailAndPassword: async () => {}, createUserWithEmailAndPassword: async () => {}, signInWithPopup: async () => {}, get currentUser() { return user; } };
  const fs = () => db; fs.FieldValue = { serverTimestamp: () => SV, increment: inc, arrayUnion: aU }; fs.Timestamp = Ts;
  const au = () => auth; au.GoogleAuthProvider = function () {};
  window.firebase = { initializeApp() {}, auth: au, firestore: fs, apps: [1] };
  window.__store = store;
  window.__fnCalls = [];
  const of = window.fetch; window.fetch = async (u, o) => { if (String(u).includes('/.netlify/functions/')) { window.__fnCalls.push([String(u).split('/').pop(), o && o.body]); return { ok: true, status: 200, json: async () => ({ ok: true, esAdmin: false, refrescar: false }) }; } return of(u, o); };
})();
