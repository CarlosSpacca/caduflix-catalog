// Gera o índice diário do catálogo do CADUFLIX a partir do TMDB.
// Roda no GitHub Actions (ver .github/workflows/daily.yml). Precisa da variável TMDB_KEY.
// Saída: dist/index.json.gz  — só dados públicos do TMDB, nada de playlist.
import fs from 'node:fs';
import zlib from 'node:zlib';

const KEY = (process.env.TMDB_KEY || '').trim();
if (!KEY) {
  console.error('Defina TMDB_KEY');
  process.exit(1);
}
const BEARER = KEY.length > 40;
const LANG = 'pt-BR';
const NOW = new Date();
const YEAR = NOW.getUTCFullYear();
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

let requests = 0;
async function get(path, params = {}) {
  const u = new URL('https://api.themoviedb.org/3' + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  if (!BEARER) u.searchParams.set('api_key', KEY);
  for (let i = 0; i < 5; i++) {
    requests++;
    try {
      const r = await fetch(u, { headers: BEARER ? { Authorization: 'Bearer ' + KEY } : {} });
      if (r.status === 429 || r.status >= 500) throw new Error('retry ' + r.status);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  return null;
}

// fila com no máximo N requisições ao mesmo tempo
function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res } = q.shift();
    fn().then(res, () => res(null)).finally(() => (active--, next()));
  };
  return (fn) => new Promise((res) => (q.push({ fn, res }), next()));
}
const run = limiter(12);

const movies = new Map();
const series = new Map();
const r1 = (x) => Math.round((x || 0) * 10) / 10;
function keep(r, kind) {
  if (!r || !r.id || r.adult) return;
  const map = kind === 'movie' ? movies : series;
  const date = (kind === 'movie' ? r.release_date : r.first_air_date) || '';
  const prev = map.get(r.id);
  // [id, título pt-BR, título original, ano, gêneros, popularidade, nota, votos, capa, fundo, idioma]
  const row = [
    r.id,
    (kind === 'movie' ? r.title : r.name) || '',
    (kind === 'movie' ? r.original_title : r.original_name) || '',
    Number(date.slice(0, 4)) || 0,
    r.genre_ids || [],
    r1(r.popularity),
    r1(r.vote_average),
    r.vote_count || 0,
    r.poster_path || '',
    r.backdrop_path || '',
    r.original_language || '',
  ];
  if (!prev || prev[5] < row[5]) map.set(r.id, row);
}

// busca várias páginas de um endpoint e devolve os ids na ordem
async function pages(kind, path, params, maxPages) {
  const first = await run(() => get(path, { language: LANG, ...params, page: 1 }));
  if (!first) return [];
  const total = Math.min(first.total_pages || 1, maxPages, 500);
  const rest = await Promise.all(
    Array.from({ length: total - 1 }, (_, i) => run(() => get(path, { language: LANG, ...params, page: i + 2 })))
  );
  const ids = [];
  for (const p of [first, ...rest]) {
    for (const r of p?.results || []) {
      const k = r.media_type === 'tv' ? 'tv' : r.media_type === 'movie' ? 'movie' : kind;
      if (k !== 'movie' && k !== 'tv') continue;
      keep(r, k);
      ids.push(r.id);
    }
  }
  return ids;
}

const disc = (kind, params, max) =>
  pages(kind, `/discover/${kind}`, { sort_by: 'popularity.desc', include_adult: 'false', ...params }, max);

console.time('índice');

// ---------- base: muitos títulos por ano (cobre playlists grandes) ----------
const jobs = [];
for (let y = YEAR + 1; y >= 1970; y--) {
  const recent = YEAR - y < 25;
  jobs.push(disc('movie', { primary_release_year: y, 'vote_count.gte': 3 }, recent ? 30 : 15));
  if (y >= 1985) jobs.push(disc('tv', { first_air_date_year: y, 'vote_count.gte': 2 }, recent ? 18 : 8));
}
for (const [a, b] of [[1900, 1949], [1950, 1959], [1960, 1969]]) {
  jobs.push(disc('movie', { 'primary_release_date.gte': `${a}-01-01`, 'primary_release_date.lte': `${b}-12-31`, 'vote_count.gte': 20 }, 15));
}
jobs.push(disc('tv', { 'first_air_date.lte': '1984-12-31', 'vote_count.gte': 10 }, 20));
// nichos comuns em playlists brasileiras
jobs.push(disc('movie', { with_origin_country: 'BR' }, 40));
jobs.push(disc('tv', { with_origin_country: 'BR' }, 30));
jobs.push(disc('tv', { with_genres: 16, with_original_language: 'ja' }, 40));
jobs.push(disc('tv', { with_genres: 10766 }, 20));
jobs.push(disc('tv', { with_genres: 10762 }, 20));
jobs.push(disc('movie', { with_genres: 16 }, 40));
jobs.push(disc('tv', { with_original_language: 'ko' }, 20));
jobs.push(disc('tv', { with_original_language: 'es' }, 20));
await Promise.all(jobs);

// ---------- listas que mudam todo dia ----------
const PROV = { netflix: '8', prime: '119', disney: '337', max: '1899|384', apple: '350', globo: '307', paramount: '531', crunchyroll: '283' };
const L = {};
const listJobs = {
  'm-trend-day': () => pages('movie', '/trending/movie/day', {}, 5),
  'm-trend-week': () => pages('movie', '/trending/movie/week', {}, 5),
  's-trend-day': () => pages('tv', '/trending/tv/day', {}, 5),
  's-trend-week': () => pages('tv', '/trending/tv/week', {}, 5),
  'm-pop': () => pages('movie', '/movie/popular', { region: 'BR' }, 8),
  's-pop': () => pages('tv', '/tv/popular', {}, 8),
  'm-now': () => pages('movie', '/movie/now_playing', { region: 'BR' }, 5),
  'm-new': () => disc('movie', { 'primary_release_date.gte': day(200), 'primary_release_date.lte': day(0), 'vote_count.gte': 20 }, 10),
  's-new': () => disc('tv', { 'first_air_date.gte': day(200), 'vote_count.gte': 10 }, 8),
  'm-top': () => pages('movie', '/movie/top_rated', {}, 15),
  's-top': () => pages('tv', '/tv/top_rated', {}, 10),
};
await Promise.all(Object.entries(listJobs).map(async ([k, fn]) => (L[k] = await fn())));

// ---------- plataformas: só o que é delas ----------
// 1) produções originais (canal/estúdio da própria plataforma no TMDB)
// 2) títulos no catálogo por assinatura no Brasil que estão SÓ nela (entre as plataformas do app)
// Aluguel/compra não conta, e um título que está em várias plataformas fica fora de todas.
const ORIG = {
  netflix: { tv: '213', movie: '178464|145174|185004' },
  prime: { tv: '1024', movie: '210099|20580' },
  disney: { tv: '2739', movie: '' },
  max: { tv: '49|3186', movie: '158691' },
  apple: { tv: '2552', movie: '194232' },
  globo: { tv: '3290', movie: '205328' },
  paramount: { tv: '4330', movie: '' },
  crunchyroll: { tv: '1112', movie: '' },
};
const flat = {};
const orig = {};
await Promise.all(
  Object.entries(PROV).flatMap(([name, id]) => [
    disc('movie', { with_watch_providers: id, watch_region: 'BR', with_watch_monetization_types: 'flatrate', 'vote_count.gte': 5 }, 30).then((r) => (flat[`m-${name}`] = r)),
    disc('tv', { with_watch_providers: id, watch_region: 'BR', with_watch_monetization_types: 'flatrate', 'vote_count.gte': 2 }, 30).then((r) => (flat[`s-${name}`] = r)),
    ORIG[name]?.tv ? disc('tv', { with_networks: ORIG[name].tv, 'vote_count.gte': 2 }, 20).then((r) => (orig[`s-${name}`] = r)) : null,
    ORIG[name]?.movie ? disc('movie', { with_companies: ORIG[name].movie, 'vote_count.gte': 5 }, 15).then((r) => (orig[`m-${name}`] = r)) : null,
  ])
);
for (const kind of ['m', 's']) {
  const count = new Map();
  const origOwner = new Map();
  for (const name of Object.keys(PROV)) {
    for (const id of new Set(flat[`${kind}-${name}`] || [])) count.set(id, (count.get(id) || 0) + 1);
    for (const id of orig[`${kind}-${name}`] || []) if (!origOwner.has(id)) origOwner.set(id, name);
  }
  for (const name of Object.keys(PROV)) {
    const mine = (orig[`${kind}-${name}`] || []).filter((id) => origOwner.get(id) === name);
    const only = (flat[`${kind}-${name}`] || []).filter((id) => count.get(id) === 1 && (!origOwner.has(id) || origOwner.get(id) === name));
    L[`${kind}-${name}`] = [...new Set([...mine, ...only])];
  }
}

// ---------- gêneros ----------
const [gm, gt] = await Promise.all([get('/genre/movie/list', { language: LANG }), get('/genre/tv/list', { language: LANG })]);
const genres = {
  movie: Object.fromEntries((gm?.genres || []).map((g) => [g.id, g.name])),
  tv: Object.fromEntries((gt?.genres || []).map((g) => [g.id, g.name])),
};

const out = {
  v: 1,
  date: NOW.toISOString(),
  fields: ['id', 'title', 'original', 'year', 'genres', 'popularity', 'vote', 'votes', 'poster', 'backdrop', 'lang'],
  genres,
  movies: [...movies.values()],
  series: [...series.values()],
  lists: L,
};
fs.mkdirSync('dist', { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync('dist/index.json.gz', zlib.gzipSync(json, { level: 9 }));
fs.writeFileSync('dist/meta.json', JSON.stringify({ date: out.date, movies: out.movies.length, series: out.series.length }));
console.timeEnd('índice');
console.log(`${out.movies.length} filmes, ${out.series.length} séries, ${requests} requisições, ${(fs.statSync('dist/index.json.gz').size / 1048576).toFixed(1)} MB`);
