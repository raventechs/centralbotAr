const F_claims = {};
/* Firebase Admin simulado en memoria — solo para las pruebas de laboratorio de CentralbotAr (no se usa en producción). */
const store = new Map();       // "negocios/n1/contactos/549..." -> datos
let seq = 0;
class Ts { constructor(ms) { this.ms = ms; this.seconds = Math.floor(ms / 1000); this.nanoseconds = 0; } toMillis() { return this.ms; } }
const SENT = { ts: { __s: "ts" }, del: { __s: "del" } };
class Inc { constructor(n) { this.n = n; } }
const FieldValue = { serverTimestamp: () => SENT.ts, delete: () => SENT.del, increment: n => new Inc(n) };

function aplicar(actual, upd, esUpdate) {
  const out = Object.assign({}, actual || {});
  for (const k of Object.keys(upd)) {
    const v = upd[k];
    if (v === SENT.ts) out[k] = new Ts(Date.now() + (++seq));
    else if (v === SENT.del) delete out[k];
    else if (v instanceof Inc) out[k] = (out[k] || 0) + v.n;
    else out[k] = v;
  }
  return out;
}
function getPath(o, path) { return path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o); }

class DocRef {
  constructor(path) { this.path = path; this.id = path.split("/").pop(); }
  collection(n) { return new ColRef(this.path + "/" + n); }
  async get() { const d = store.get(this.path); return new Snap(this, d); }
  async set(data, opt) {
    const prev = store.get(this.path);
    store.set(this.path, opt && opt.merge ? aplicar(prev, data) : aplicar({}, data));
  }
  async create(data) {
    if (store.has(this.path)) { const e = new Error("ALREADY_EXISTS"); e.code = 6; throw e; }
    store.set(this.path, aplicar({}, data));
  }
  async update(data) { if (!store.has(this.path)) throw new Error("NOT_FOUND " + this.path); store.set(this.path, aplicar(store.get(this.path), data, true)); }
  async delete() { store.delete(this.path); }
}
class Snap {
  constructor(ref, d) { this.ref = ref; this.id = ref.id; this.exists = d !== undefined; this._d = d; }
  data() { return this._d === undefined ? undefined : cloneConTs(this._d); }
}
function cloneConTs(o) {
  if (o instanceof Ts) return o;
  if (Array.isArray(o)) return o.map(cloneConTs);
  if (o && typeof o === "object") { const r = {}; for (const k of Object.keys(o)) r[k] = cloneConTs(o[k]); return r; }
  return o;
}
class Query {
  constructor(path, filtros, orden, lim) { this.path = path; this.filtros = filtros || []; this.orden = orden || null; this.lim = lim || null; }
  where(campo, op, val) { return new Query(this.path, this.filtros.concat([[campo, op, val]]), this.orden, this.lim); }
  orderBy(campo, dir) { return new Query(this.path, this.filtros, [campo, dir || "asc"], this.lim); }
  limit(n) { return new Query(this.path, this.filtros, this.orden, n); }
  async get() {
    const prefijo = this.path + "/", depth = this.path.split("/").length + 1;
    let docs = [];
    for (const [p, d] of store) if (p.startsWith(prefijo) && p.split("/").length === depth) docs.push([p, d]);
    docs = docs.filter(([p, d]) => this.filtros.every(([c, op, v]) => {
      const x = getPath(d, c);
      if (op === "==") return x === v;
      if (op === "array-contains") return Array.isArray(x) && x.includes(v);
      if (op === "in") return v.includes(x);
      throw new Error("op no soportado " + op);
    }));
    if (this.orden) { const [c, dir] = this.orden; const val = x => { const y = getPath(x, c); return y instanceof Ts ? y.ms : y; }; docs.sort((a, b) => (val(a[1]) > val(b[1]) ? 1 : -1) * (dir === "desc" ? -1 : 1)); }
    if (this.lim) docs = docs.slice(0, this.lim);
    const snaps = docs.map(([p, d]) => new Snap(new DocRef(p), d));
    return { docs: snaps, empty: snaps.length === 0, size: snaps.length };
  }
}
class ColRef extends Query {
  constructor(path) { super(path); }
  doc(id) { return new DocRef(this.path + "/" + id); }
  async add(data) { const r = new DocRef(this.path + "/auto" + (++seq)); await r.set(data); return r; }
}
const dbObj = {
  collection: n => new ColRef(n),
  batch() { const ops = []; return { set(ref, data) { ops.push([ref, data]); }, async commit() { for (const [r, d] of ops) await r.set(d); } }; },
  async runTransaction(fn) {
    const tx = { get: ref => ref.get(), update: (ref, d) => { store.set(ref.path, aplicar(store.get(ref.path), d, true)); } };
    return fn(tx);
  },
};
const fake = {
  apps: [1],
  initializeApp() {}, credential: { cert: () => ({}) },
  firestore: Object.assign(() => dbObj, { FieldValue }),
  auth: () => ({ getUser: async uid => ({ customClaims: F_claims[uid] || {} }), setCustomUserClaims: async (uid, c) => { F_claims[uid] = c; }, verifyIdToken: async t => { const m = String(t).match(/^tok:(.+?):(.+?)(?::(ver))?$/); if (!m) throw new Error("bad"); return { uid: m[1], email: m[2], email_verified: m[3] === "ver" }; } }),
};
module.exports = { fake, store, Ts, reset: () => store.clear(), seed: (path, data) => store.set(path, cloneConTs(data)), read: p => store.get(p) };
