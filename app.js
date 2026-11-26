// Navegador de chacra
// Lotes del cliente + Sentinel-2 L2A (Earth Search, público): imagen real, NDVI y zonas de las 2 últimas fechas sin nubes.
{
const NAV = window.NAV || { datos: [] };
const CFG = { dias: 120, maxFechas: 2, stac: 'https://earth-search.aws.element84.com/v1/search', col: 'sentinel-2-c1-l2a' };
const PAL = [[165,0,38],[215,48,39],[244,109,67],[253,174,97],[254,224,139],[217,239,139],[166,217,106],[102,189,99],[26,152,80],[0,104,55]];
const ZC = [[215,48,31],[253,216,53],[46,125,50]], ZN = ['Baja', 'Media', 'Alta'];
const MALO = new Set([0, 1, 3, 8, 9, 10, 11]); // SCL: sin dato, saturado, sombra, nubes, cirros, nieve
const $ = id => document.getElementById(id);
const est = t => $('est').textContent = t;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = f => f.slice(8, 10) + '/' + f.slice(5, 7) + '/' + f.slice(0, 4);

// ---------- mapa ----------
const map = L.map('map', { zoomControl: false });
L.control.zoom({ position: 'bottomleft' }).addTo(map);
const gs = L.tileLayer('https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { subdomains: '0123', maxZoom: 21, attribution: 'Google' }).addTo(map);
const gh = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { subdomains: '0123', maxZoom: 21, attribution: 'Google' });
L.control.layers({ 'Google Satélite': gs, 'Google Híbrido': gh }, null, { position: 'topright' }).addTo(map);
map.setView([-32.5, -56], 7);

// ---------- estado ----------
let campos = [], C = null, LOT = null, nombres = [], sel = new Set(), lotLay = null, ambLay = null, ambEtq = null;
// colores de ambientes: A verde, B amarillo, D rojo; más oscuro en el bajo
// colores de ambientes: A verde, B amarillo, D rojo; tono según relieve (loma claro, bajo oscuro)
const AC = { A: { l: '#a6d96a', ml: '#66bd63', b: '#1a9850' }, B: { l: '#fff3a3', ml: '#fee08b', b: '#f2c14e' }, D: { l: '#fcae91', ml: '#f46d43', b: '#d73027' } };
const colAmb = p => (AC[p.prod] || {})[p.clase] || (AC[p.prod] || {}).ml || '#9e9e9e';
function coloresAmb() {}
const RELIEVE = { l: 'loma', ml: 'media loma', b: 'bajo' };
let escenas = [], act = 0, ov = { real: null, ndvi: null, zon: null }, corrida = 0;

// ---------- utilidades geo ----------
function defUTM(epsg) {
  const z = epsg % 100, sur = Math.floor(epsg / 100) === 327;
  proj4.defs('EPSG:' + epsg, `+proj=utm +zone=${z}${sur ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`);
  return 'EPSG:' + epsg;
}
const epsgDe = it => it.properties['proj:epsg'] || +String(it.properties['proj:code'] || '').split(':')[1];
const polys = f => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
function bboxUTM(crs, pad) {
  let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
  for (const f of LOT.features) for (const p of polys(f)) for (const r of p) for (const c of r) {
    const [x, y] = proj4('EPSG:4326', crs, c); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}
const pool = (typeof Worker !== 'undefined') ? new GeoTIFF.Pool() : undefined;
async function leer(href, bb) {
  const tif = await GeoTIFF.fromUrl(href, { allowFullFile: false });
  const img = await tif.getImage();
  const [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution();
  const c0 = Math.floor((bb[0] - ox) / rx), c1 = Math.ceil((bb[2] - ox) / rx), r0 = Math.floor((bb[3] - oy) / ry), r1 = Math.ceil((bb[1] - oy) / ry);
  const W = img.getWidth(), H = img.getHeight();
  const g = { x0: ox + c0 * rx, y0: oy + r0 * ry, rx, ry, w: c1 - c0, h: r1 - r0 };
  const cc0 = Math.max(0, c0), cc1 = Math.min(W, c1), rr0 = Math.max(0, r0), rr1 = Math.min(H, r1);
  const nb = img.getSamplesPerPixel(), out = [];
  for (let b = 0; b < nb; b++) out.push(new Float32Array(g.w * g.h));
  if (cc1 > cc0 && rr1 > rr0) {
    const d = await img.readRasters({ window: [cc0, rr0, cc1, rr1], pool });
    const ww = cc1 - cc0;
    for (let b = 0; b < nb; b++) for (let r = rr0; r < rr1; r++) for (let c = cc0; c < cc1; c++)
      out[b][(r - r0) * g.w + (c - c0)] = d[b][(r - rr0) * ww + (c - cc0)];
  }
  g.b = out; return g;
}
// lee una banda de varias escenas de la misma fecha y las une (completa los huecos sin dato)
async function leerMosaico(items, clave, bb) {
  let g = null;
  for (const it of items) {
    const x = await leer(it.assets[clave].href, bb);
    if (!g) { g = x; continue; }
    for (let i = 0; i < g.b[0].length; i++) if (!g.b[0][i] && x.b[0][i]) for (let b = 0; b < g.b.length; b++) g.b[b][i] = x.b[b][i];
  }
  return g;
}
// máscara de lotes en una grilla: 0 = fuera, k+1 = lote k
function mascara(g, crs) {
  const cv = document.createElement('canvas'); cv.width = g.w; cv.height = g.h;
  const cx = cv.getContext('2d', { willReadFrequently: true }), m = new Uint16Array(g.w * g.h);
  LOT.features.forEach((f, k) => {
    cx.clearRect(0, 0, g.w, g.h); cx.fillStyle = '#000'; cx.beginPath();
    for (const p of polys(f)) for (const r of p) r.forEach((c, i) => {
      const [x, y] = proj4('EPSG:4326', crs, c), px = (x - g.x0) / g.rx, py = (y - g.y0) / g.ry;
      i ? cx.lineTo(px, py) : cx.moveTo(px, py);
    });
    cx.fill('evenodd');
    const d = cx.getImageData(0, 0, g.w, g.h).data;
    for (let i = 0; i < m.length; i++) if (d[i * 4 + 3] > 127) m[i] = k + 1;
  });
  return m;
}

// ---------- carga de clientes y campos ----------
async function iniciar() {
  try {
    for (const url of NAV.datos) {
      const j = await (await fetch(url, { cache: 'no-cache' })).json();
      for (const e of j.establecimientos) campos.push({ cliente: j.cliente, ...e });
    }
  } catch (e) { est('No se pudieron cargar los lotes: ' + e.message); return; }
  const unCliente = new Set(campos.map(c => c.cliente)).size === 1;
  $('subt').textContent = unCliente ? campos[0].cliente : 'Todos los clientes';
  if (campos.length > 1) {
    $('campoSel').innerHTML = campos.map((c, i) => `<option value="${i}">${esc(unCliente ? c.nombre : c.cliente + ' · ' + c.nombre)}</option>`).join('');
    $('campoBox').hidden = false;
  }
  let ini = 0;
  try { const g = localStorage.getItem('nav-campo-' + location.pathname); if (g !== null && campos[+g]) ini = +g; } catch (e) {}
  $('campoSel').value = ini;
  elegirCampo(ini);
}
function elegirCampo(i) {
  C = campos[i]; LOT = C.lotes; nombres = LOT.features.map(f => f.properties.nombre); sel = new Set(nombres);
  try { localStorage.setItem('nav-campo-' + location.pathname, i); } catch (e) {}
  $('tit').textContent = C.nombre;
  if (lotLay) map.removeLayer(lotLay);
  if (ambLay) { map.removeLayer(ambLay); ambLay = null; }
  coloresAmb();
  lotLay = L.geoJSON(LOT, { style: { color: '#fff', weight: 1.2, opacity: .9, fill: false } }).addTo(map);
  lotLay.eachLayer(l => l.bindTooltip(esc(l.feature.properties.nombre), { permanent: true, direction: 'center', className: 'lbl' }));
  map.fitBounds(lotLay.getBounds(), { padding: [20, 20] });
  $('lots').innerHTML = nombres.map(n => `<button class="b on" data-p="${esc(n)}">${esc(n)}</button>`).join('');
  $('lotsBox').hidden = nombres.length < 2;
  act = 0; buscar();
}

// ---------- búsqueda de escenas ----------
async function buscar() {
  const yo = ++corrida, minc = +$('minc').value || 95;
  escenas = []; pintarFechas(); limpiarOv(); $('tab').innerHTML = ''; $('badge').hidden = true;
  const b = lotLay.getBounds(), hoy = new Date(), desde = new Date(hoy - CFG.dias * 864e5);
  est('Buscando imágenes Sentinel-2…');
  const body = { collections: [CFG.col], bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    datetime: desde.toISOString().slice(0, 10) + 'T00:00:00Z/' + hoy.toISOString().slice(0, 10) + 'T23:59:59Z',
    limit: 200, sortby: [{ field: 'properties.datetime', direction: 'desc' }] };
  let items = [];
  try { items = (await (await fetch(CFG.stac, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()).features || []; }
  catch (e) { est('No se pudo consultar el catálogo: ' + e.message); return; }
  if (yo !== corrida) return;
  const porFecha = new Map();
  for (const it of items) {
    if ((it.properties['eo:cloud_cover'] ?? 0) > 98) continue;
    const f = it.properties.datetime.slice(0, 10);
    if (!porFecha.has(f)) porFecha.set(f, []);
    porFecha.get(f).push(it);
  }
  const fechas = [...porFecha.keys()].sort().reverse();
  let rev = 0;
  for (const f of fechas) {
    if (escenas.length >= CFG.maxFechas) break;
    rev++; est(`Revisando nubes ${fmt(f)} (${rev}/${fechas.length})…`);
    try {
      // varias escenas del mismo día (otra pasada, tile vecino o versión recortada): se unen en la proyección de la primera
      const lista = porFecha.get(f).sort((a, b) => a.properties['eo:cloud_cover'] - b.properties['eo:cloud_cover']);
      const epsg = epsgDe(lista[0]), crs = defUTM(epsg), bb = bboxUTM(crs, 60);
      const usadas = lista.filter(it => epsgDe(it) === epsg);
      let scl = null, m = null, pct = 0, uso = [];
      for (const it of usadas) {
        const x = await leer(it.assets.scl.href, bb);
        if (yo !== corrida) return;
        if (!scl) { scl = x; m = mascara(scl, crs); }
        else for (let i = 0; i < scl.b[0].length; i++) if (MALO.has(scl.b[0][i]) && !MALO.has(x.b[0][i])) scl.b[0][i] = x.b[0][i];
        uso.push(it);
        let tot = 0, ok = 0;
        for (let i = 0; i < m.length; i++) if (m[i]) { tot++; if (!MALO.has(scl.b[0][i])) ok++; }
        pct = tot ? 100 * ok / tot : 0;
        if (pct >= 99.9) break;
      }
      if (pct >= minc) { escenas.push({ f, items: uso, crs, bb, pct, scl }); pintarFechas(); if (escenas.length === 1) await procesar(0, false, yo); }
    } catch (e) { console.warn(f, e); }
    if (yo !== corrida) return;
  }
  if (!escenas.length) { est(`Ninguna fecha de los últimos ${CFG.dias} días llega a ${minc}% sin nubes. Bajá el %.`); return; }
  for (let i = 1; i < escenas.length; i++) await procesar(i, true, yo);
  if (yo !== corrida) return;
  est(`Listo · ${escenas.map(e => fmt(e.f) + ' (' + Math.round(e.pct) + '% sin nubes)').join(' · ')}`);
  tabla();
}

// ---------- procesamiento de una fecha ----------
async function procesar(i, silencio, yo) {
  const e = escenas[i]; if (!e || e.listo) return;
  if (!silencio) est(`Bajando bandas del ${fmt(e.f)}…`);
  const [red, nir, vis] = await Promise.all([leerMosaico(e.items, 'red', e.bb), leerMosaico(e.items, 'nir', e.bb), leerMosaico(e.items, 'visual', e.bb)]);
  if (yo !== undefined && yo !== corrida) return;
  const rb = k => (e.items[0].assets[k]['raster:bands'] || [{}])[0];
  const sR = rb('red').scale ?? 1e-4, oR = rb('red').offset ?? 0, sN = rb('nir').scale ?? 1e-4, oN = rb('nir').offset ?? 0;
  const g = red, n = g.w * g.h, m = mascara(g, e.crs), nd = new Float32Array(n).fill(NaN);
  for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) {
    const q = r * g.w + c; if (!m[q]) continue;
    const X = g.x0 + (c + .5) * g.rx, Y = g.y0 + (r + .5) * g.ry;
    const sc = Math.floor((X - e.scl.x0) / e.scl.rx), sr = Math.floor((Y - e.scl.y0) / e.scl.ry);
    const s = (sc >= 0 && sr >= 0 && sc < e.scl.w && sr < e.scl.h) ? e.scl.b[0][sr * e.scl.w + sc] : 0;
    const ra = red.b[0][q], rn = nir.b[0][q];
    if (!ra || !rn || MALO.has(s)) continue;
    const a = ra * sR + oR, b = rn * sN + oN;
    if (a + b > 0) nd[q] = (b - a) / (b + a);
  }
  const sem = nombres.map(x => !C.sinSembrar.includes(x));
  const vals = []; for (let k = 0; k < n; k++) if (m[k] && sem[m[k] - 1] && !isNaN(nd[k])) vals.push(nd[k]);
  vals.sort((x, y) => x - y);
  e.vmin = vals[Math.floor(vals.length * .02)] ?? 0; e.vmax = vals[Math.floor(vals.length * .98)] ?? 1;
  if (e.vmax - e.vmin < .05) e.vmax = e.vmin + .05;
  e.g = g; e.m = m; e.nd = nd; e.vis = vis; e.zon = zonas(g, m, nd, sem);
  e.stats = nombres.map((nm, k) => { let s = 0, c = 0; for (let q = 0; q < n; q++) if (m[q] === k + 1 && !isNaN(nd[q])) { s += nd[q]; c++; } return c ? s / c : NaN; });
  e.map = remuestreo(g, e.crs);
  e.listo = true;
  if (i === act) render();
}

// zonas por lote: mediana 3x3, recorte p2-p98, k-means 1D (3 clases), mayoría 5x5 dos pasadas
function zonas(g, m, nd, sem) {
  const W = g.w, H = g.h, z = new Int8Array(W * H).fill(-1);
  nombres.forEach((nm, k) => {
    if (!sem[k]) return;
    const idx = []; for (let i = 0; i < m.length; i++) if (m[i] === k + 1 && !isNaN(nd[i])) idx.push(i);
    if (idx.length < 30) return;
    const sm = new Float32Array(idx.length), tmp = [];
    idx.forEach((i, j) => {
      const r = Math.floor(i / W), c = i % W; tmp.length = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
        const q = rr * W + cc; if (m[q] === k + 1 && !isNaN(nd[q])) tmp.push(nd[q]);
      }
      tmp.sort((a, b) => a - b); sm[j] = tmp[tmp.length >> 1];
    });
    const s = Array.from(sm).sort((a, b) => a - b), q = p => s[Math.floor(p * (s.length - 1))];
    const lo = q(.02), hi = q(.98); for (let j = 0; j < sm.length; j++) sm[j] = Math.min(hi, Math.max(lo, sm[j]));
    let c = [q(.17), q(.5), q(.83)];
    const cl = v => { const a = Math.abs(v - c[0]), b = Math.abs(v - c[1]), d = Math.abs(v - c[2]); return a <= b && a <= d ? 0 : b <= d ? 1 : 2; };
    for (let it = 0; it < 30; it++) {
      const su = [0, 0, 0], nn = [0, 0, 0];
      for (const v of sm) { const l = cl(v); su[l] += v; nn[l]++; }
      c = c.map((x, l) => nn[l] ? su[l] / nn[l] : x);
    }
    c.sort((a, b) => a - b);
    idx.forEach((i, j) => z[i] = cl(sm[j]));
    for (let pas = 0; pas < 2; pas++) {
      const nz = new Int8Array(idx.length);
      idx.forEach((i, j) => {
        const r = Math.floor(i / W), c0 = i % W, cnt = [0, 0, 0];
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
          const rr = r + dr, cc = c0 + dc; if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
          const v = z[rr * W + cc]; if (v >= 0 && m[rr * W + cc] === k + 1) cnt[v]++;
        }
        nz[j] = cnt[0] >= cnt[1] && cnt[0] >= cnt[2] ? 0 : cnt[1] >= cnt[2] ? 1 : 2;
      });
      idx.forEach((i, j) => z[i] = nz[j]);
    }
  });
  return z;
}

// remuestreo de la grilla UTM a Web Mercator (proyección exacta en una grilla gruesa + interpolación)
function remuestreo(g, crs) {
  const esq = [[g.x0, g.y0], [g.x0 + g.w * g.rx, g.y0], [g.x0, g.y0 + g.h * g.ry], [g.x0 + g.w * g.rx, g.y0 + g.h * g.ry]].map(p => proj4(crs, 'EPSG:4326', p));
  const lon0 = Math.min(...esq.map(p => p[0])), lon1 = Math.max(...esq.map(p => p[0])), lat0 = Math.min(...esq.map(p => p[1])), lat1 = Math.max(...esq.map(p => p[1]));
  const my = la => Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360));
  const yt = my(lat1), yb = my(lat0);
  const W = Math.round(g.w * 1.5), H = Math.max(1, Math.round(W * (yt - yb) / ((lon1 - lon0) * Math.PI / 180)));
  const P = 8, GW = Math.ceil(W / P) + 1, GH = Math.ceil(H / P) + 1, GX = new Float64Array(GW * GH), GY = new Float64Array(GW * GH);
  for (let gj = 0; gj < GH; gj++) {
    const y = yt - Math.min(gj * P, H) / H * (yt - yb), la = (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
    for (let gi = 0; gi < GW; gi++) {
      const lo = lon0 + Math.min(gi * P, W) / W * (lon1 - lon0), [X, Y] = proj4('EPSG:4326', crs, [lo, la]);
      GX[gj * GW + gi] = X; GY[gj * GW + gi] = Y;
    }
  }
  const idx = new Int32Array(W * H).fill(-1);
  for (let j = 0; j < H; j++) {
    const fj = (j + .5) / P, j0 = Math.min(GH - 2, Math.floor(fj)), tj = fj - j0;
    for (let i = 0; i < W; i++) {
      const fi = (i + .5) / P, i0 = Math.min(GW - 2, Math.floor(fi)), ti = fi - i0, a = j0 * GW + i0, b = a + GW;
      const X = (GX[a] * (1 - ti) + GX[a + 1] * ti) * (1 - tj) + (GX[b] * (1 - ti) + GX[b + 1] * ti) * tj;
      const Y = (GY[a] * (1 - ti) + GY[a + 1] * ti) * (1 - tj) + (GY[b] * (1 - ti) + GY[b + 1] * ti) * tj;
      const c = Math.floor((X - g.x0) / g.rx), r = Math.floor((Y - g.y0) / g.ry);
      if (c >= 0 && r >= 0 && c < g.w && r < g.h) idx[j * W + i] = r * g.w + c;
    }
  }
  return { W, H, idx, bounds: [[lat0, lon0], [lat1, lon1]] };
}

// ---------- dibujo ----------
function limpiarOv() { for (const k in ov) if (ov[k]) { map.removeLayer(ov[k]); ov[k] = null; } }
function capa(e, fn) {
  const { W, H, idx, bounds } = e.map, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d'), im = cx.createImageData(W, H), d = im.data;
  for (let p = 0; p < idx.length; p++) {
    const s = idx[p]; if (s < 0) continue; const k = e.m[s]; if (!k || !sel.has(nombres[k - 1])) continue;
    const col = fn(s, k); if (!col) continue; d[p * 4] = col[0]; d[p * 4 + 1] = col[1]; d[p * 4 + 2] = col[2]; d[p * 4 + 3] = 255;
  }
  cx.putImageData(im, 0, 0);
  return L.imageOverlay(cv.toDataURL(), bounds, { opacity: +$('op').value, className: 'pix', interactive: false });
}
function rampa(v, a, b) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a))) * (PAL.length - 1), i = Math.min(PAL.length - 2, Math.floor(t)), f = t - i;
  return PAL[i].map((x, q) => Math.round(x + (PAL[i + 1][q] - x) * f));
}
const sinSem = k => C.sinSembrar.includes(nombres[k - 1]);
function render() {
  limpiarOv(); const e = escenas[act];
  $('leyN').hidden = !$('cNdvi').checked; $('leyZ').hidden = !$('cZon').checked;
  if (lotLay) { $('cLot').checked ? lotLay.addTo(map) : map.removeLayer(lotLay); }
  pintarAmb();
  if (!e || !e.listo) { if (lotLay && $('cLot').checked) lotLay.bringToFront(); return; }
  if ($('cReal').checked) ov.real = capa(e, s => [e.vis.b[0][s], e.vis.b[1][s], e.vis.b[2][s]]).addTo(map);
  if ($('cNdvi').checked) ov.ndvi = capa(e, (s, k) => isNaN(e.nd[s]) || sinSem(k) ? null : rampa(e.nd[s], e.vmin, e.vmax)).addTo(map);
  if ($('cZon').checked) ov.zon = capa(e, s => e.zon[s] < 0 ? null : ZC[e.zon[s]]).addTo(map);
  if (ambLay) ambLay.eachLayer(l => l.bringToFront && l.bringToFront());
  if (lotLay && $('cLot').checked) lotLay.bringToFront();
  $('lmin').textContent = e.vmin.toFixed(2); $('lmax').textContent = e.vmax.toFixed(2);
  const cap = [['cReal', 'Imagen real'], ['cNdvi', 'NDVI'], ['cZon', 'Zonas'], ['cAmb', 'Ambientes']].filter(x => $(x[0]).checked).map(x => x[1]);
  $('badge').textContent = `${C.nombre} · ${cap.length ? cap.join(' + ') + ' · ' : ''}${fmt(e.f)}`;
  $('badge').hidden = false;
}
function etqZoom() { if (ambEtq) map.getZoom() >= 14 ? ambEtq.addTo(map) : map.removeLayer(ambEtq); }
map.on('zoomend', etqZoom);
const estAmb = f => ({ color: 'rgba(255,255,255,.7)', weight: .6, fillColor: colAmb(f.properties), fillOpacity: +$('op').value * .8 });
function pintarAmb() {
  if (ambLay) { map.removeLayer(ambLay); ambLay = null; }
  if (ambEtq) { map.removeLayer(ambEtq); ambEtq = null; }
  const on = $('cAmb').checked && C && C.ambientes;
  $('leyA').hidden = !on; if (!on) return;
  const fs = C.ambientes.features.filter(f => sel.has(f.properties.lote));
  ambLay = L.layerGroup().addTo(map);
  L.geoJSON({ type: 'FeatureCollection', features: fs }, { style: estAmb, interactive: false }).addTo(ambLay);
  ambEtq = L.layerGroup();
  for (const f of fs) if (f.properties.lp && f.properties.ha >= 1)
    L.marker([f.properties.lp[1], f.properties.lp[0]], { interactive: false, icon: L.divIcon({ className: 'etqA', html: esc(f.properties.amb), iconSize: null }) }).addTo(ambEtq);
  etqZoom();
  const tot = new Map();
  for (const f of fs) { const p = f.properties, t = tot.get(p.amb) || { ha: 0, p }; t.ha += p.ha; tot.set(p.amb, t); }
  $('leyA').innerHTML = [...tot.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([n, t]) => `<span><i style="background:${colAmb(t.p)}"></i>${esc(n)} <em>${t.ha.toFixed(1)} ha</em></span>`).join('');
}
function pintarFechas() {
  $('fechas').innerHTML = escenas.map((e, i) => `<button class="b${i === act ? ' on' : ''}" data-i="${i}">${i ? 'Anterior' : 'Última'} · ${fmt(e.f)}</button>`).join('') || '<small class="n">—</small>';
}
function tabla() {
  if (!escenas.length || !escenas[0].stats) return;
  const h = escenas.map(e => `<th>${fmt(e.f).slice(0, 5)}</th>`).join('') + (escenas.length > 1 ? '<th>Cambio</th>' : '');
  const rows = nombres.map((nm, k) => {
    const ss = C.sinSembrar.includes(nm), v = escenas.map(e => e.stats && !ss ? e.stats[k] : NaN), d = v[0] - v[1];
    return `<tr><td>${esc(nm)}${ss ? ' <small class="n">s/s</small>' : ''}</td>${v.map((x, i) => `<td>${isNaN(x) ? '–' : `<i class="pt" style="background:rgb(${rampa(x, escenas[i].vmin, escenas[i].vmax)})"></i>` + x.toFixed(2)}</td>`).join('')}${v.length > 1 ? `<td class="${d < 0 ? 'baj' : 'alt'}">${isNaN(d) ? '–' : (d > 0 ? '▲ +' : '▼ ') + d.toFixed(2)}</td>` : ''}</tr>`;
  }).join('');
  $('tab').innerHTML = `<table><tr><th>Lote</th>${h}</tr>${rows}</table>`;
}

// ---------- controles ----------
$('campoSel').onchange = () => elegirCampo(+$('campoSel').value);
$('lots').onclick = ev => { const b = ev.target.closest('[data-p]'); if (!b) return; const p = b.dataset.p; sel.has(p) ? sel.delete(p) : sel.add(p); b.classList.toggle('on', sel.has(p)); render(); };
$('fechas').onclick = async ev => { const b = ev.target.closest('[data-i]'); if (!b) return; act = +b.dataset.i; pintarFechas(); await procesar(act); render(); };
['cReal', 'cNdvi', 'cZon', 'cLot', 'cAmb'].forEach(id => $(id).onchange = render);
$('op').oninput = () => { for (const k in ov) if (ov[k]) ov[k].setOpacity(+$('op').value); if (ambLay) ambLay.eachLayer(l => l.setStyle && l.setStyle(estAmb)); };
$('minb').onclick = () => { $('pan').classList.toggle('min'); $('minb').textContent = $('pan').classList.contains('min') ? '+' : '–'; };
$('rebus').onclick = () => { act = 0; buscar(); };
if (window.innerWidth < 600) { $('pan').classList.add('min'); $('minb').textContent = '+'; }

function dentro(pt, f) {
  let ok = false;
  for (const p of polys(f)) {
    let inP = false;
    p.forEach((ring, ri) => {
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
      }
      if (ri === 0) inP = c; else if (c) inP = false;
    });
    if (inP) ok = true;
  }
  return ok;
}
map.on('click', ev => {
  if (!C) return;
  const pt = [ev.latlng.lng, ev.latlng.lat];
  const lot = LOT.features.find(f => dentro(pt, f)); if (!lot) return;
  const nm = lot.properties.nombre, k = nombres.indexOf(nm) + 1;
  let h = `<b>${esc(nm)}</b>`;
  const am = (C.ambientes ? C.ambientes.features : []).find(f => f.properties.lote === nm && dentro(pt, f));
  if (am) h += `<br>Ambiente: <b>${esc(am.properties.amb)}</b>${RELIEVE[am.properties.clase] ? ' (' + RELIEVE[am.properties.clase] + ')' : ''}`;
  const e = escenas[act];
  if (e && e.listo) {
    const [X, Y] = proj4('EPSG:4326', e.crs, pt);
    const c = Math.floor((X - e.g.x0) / e.g.rx), r = Math.floor((Y - e.g.y0) / e.g.ry);
    if (c >= 0 && r >= 0 && c < e.g.w && r < e.g.h) {
      const s = r * e.g.w + c, v = e.nd[s], z = e.zon[s];
      h += `<br>${fmt(e.f)} · ${sinSem(k) ? 'Sin sembrar' : 'NDVI: <b>' + (isNaN(v) ? 'nube/sin dato' : v.toFixed(2)) + '</b>'}${z >= 0 ? '<br>Zona: ' + ZN[z] : ''}`;
    }
  }
  L.popup().setLatLng(ev.latlng).setContent(h + `<br><small>${ev.latlng.lat.toFixed(6)}, ${ev.latlng.lng.toFixed(6)}</small>`).openOn(map);
});

// ---------- GPS ----------
let wid = null, yoM = null, prec = null, primera = true;
$('bGps').onclick = () => {
  if (wid !== null) { navigator.geolocation.clearWatch(wid); wid = null; if (yoM) { map.removeLayer(yoM); map.removeLayer(prec); yoM = null; } $('bGps').classList.remove('on'); $('bCen').hidden = true; return; }
  if (!navigator.geolocation) { est('Este navegador no tiene GPS.'); return; }
  $('bGps').classList.add('on'); primera = true;
  wid = navigator.geolocation.watchPosition(p => {
    const ll = [p.coords.latitude, p.coords.longitude];
    if (!yoM) { prec = L.circle(ll, { radius: p.coords.accuracy, color: '#1565c0', weight: 1, fillOpacity: .15 }).addTo(map); yoM = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1565c0', fillOpacity: 1 }).addTo(map); }
    else { yoM.setLatLng(ll); prec.setLatLng(ll).setRadius(p.coords.accuracy); }
    $('bCen').hidden = false;
    if (primera) { map.setView(ll, Math.max(map.getZoom(), 16)); primera = false; }
  }, err => { est('GPS: ' + err.message); $('bGps').classList.remove('on'); wid = null; }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
};
$('bCen').onclick = () => yoM && map.setView(yoM.getLatLng(), Math.max(map.getZoom(), 17));

iniciar();
}
