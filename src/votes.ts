import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fetchJson, fetchText, mapPool } from './http.ts';

const INDEX_URL = 'https://www.congreso.es/es/opendata/votaciones';
const OUT_DIR = 'data/v1/sessions';

type RawVoting = {
  informacion: {
    sesion: number;
    numeroVotacion: number;
    fecha: string;
    titulo: string;
    textoExpediente: string;
    tituloSubGrupo: string;
    textoSubGrupo: string;
  };
  totales: {
    asentimiento: string;
    presentes: number;
    afavor: number;
    enContra: number;
    abstenciones: number;
    noVotan: number;
  };
  votaciones: { asiento: string; diputado: string; grupo: string; voto: string }[];
};

export type Vote = 'yes' | 'no' | 'abstain' | 'absent';

// One character per deputy, aligned with the session roster: repeating 350 full names
// on every one of the 2000+ votings is what made the dataset unmanageable.
export const VOTE_CODE: Record<Vote, string> = { yes: 'Y', no: 'N', abstain: 'A', absent: 'X' };
const NOT_IN_ROLL_CALL = '.';

export type Session = {
  date: string;
  session: number;
  legislature: string;
  deputies: { name: string; group: string; seat: string }[];
  votings: {
    number: number;
    heading: string;
    title: string;
    subtitle: string;
    expediente: string | null;
    totals: { present: number; yes: number; no: number; abstain: number; absent: number; unanimous: boolean };
    votes: string;
    source: string;
  }[];
};

const VOTES: Record<string, Vote> = {
  Si: 'yes',
  Sí: 'yes',
  No: 'no',
  Abstencion: 'abstain',
  Abstención: 'abstain',
  'No vota': 'absent',
};

const clean = (v: string) => v.replace(/\s+/g, ' ').trim();

// An unmapped value would silently become 'absent' and skew the tally, so it stops the build.
const toVote = (raw: string): Vote => {
  const vote = VOTES[clean(raw)];
  if (!vote) throw new Error(`unmapped vote value: ${JSON.stringify(raw)}`);
  return vote;
};

const romanize = (n: number) => {
  const table: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [value, symbol] of table) while (n >= value) (out += symbol), (n -= value);
  return out;
};

const isoDate = (ddmmyyyy: string) => ddmmyyyy.split('/').reverse().join('-');

/**
 * Each voting JSON knows its session and its ballot, but not which file it belongs to:
 * the expediente only exists in the day's HTML, as a link preceding the block of
 * votings it covers (one expediente typically spans several amendment votes).
 */
function parseDay(html: string) {
  const marks = [
    ...html.matchAll(/\(Núm\. expte\.\s*(\d{3}\/\d{6})\)/g),
    ...html.matchAll(/\/webpublica\/opendata\/votaciones\/[^"']+?\.json/g),
  ].sort((a, b) => a.index - b.index);

  const votings: { url: string; expediente: string | null }[] = [];
  let expediente: string | null = null;
  for (const mark of marks) {
    if (mark[0].startsWith('(')) expediente = mark[1];
    else votings.push({ url: 'https://www.congreso.es' + mark[0], expediente });
  }
  return votings;
}

const indexHtml = await fetchText(INDEX_URL);
const legislatureNumber = Number(/<option[^>]*selected[^>]*value="(\d+)"/.exec(indexHtml)?.[1]);
if (!legislatureNumber) throw new Error('cannot read current legislature from ' + INDEX_URL);
const legislature = romanize(legislatureNumber);

const days = [...(/diasVotaciones\s*=\s*\[([^\]]*)\]/.exec(indexHtml)?.[1] ?? '').matchAll(/(\d{4})(\d{2})(\d{2})/g)]
  .map((m) => `${m[1]}-${m[2]}-${m[3]}`)
  .sort();
if (!days.length) throw new Error('no voting days listed at ' + INDEX_URL);

await mkdir(OUT_DIR, { recursive: true });
const existing = new Set((await readdir(OUT_DIR)).map((f) => f.replace('.json', '')));

// Past days are immutable; only the most recent one can still gain votings.
const pending = days.filter((day, i) => !existing.has(day) || i === days.length - 1);
console.log(`legislature ${legislature}: ${days.length} voting days, ${pending.length} to fetch`);

let noExpediente = 0;
let totalVotings = 0;

for (const day of pending) {
  const [year, month, dayOfMonth] = day.split('-');
  const url = `${INDEX_URL}?p_p_id=votaciones&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view&targetLegislatura=${legislature}&targetDate=${dayOfMonth}/${month}/${year}`;
  const found = parseDay(await fetchText(url));
  if (!found.length) {
    console.warn(`${day}: no votings found in HTML`);
    continue;
  }

  const raw = await mapPool(found, 6, ({ url }) => fetchJson<RawVoting>(url));
  const votings: Session['votings'] = [];

  // Seats are not a usable key: everyone without one (ministers, mostly) shares "-1".
  const roster = new Map<string, { group: string; seat: string }>();
  for (const voting of raw) {
    for (const { asiento, diputado, grupo } of voting.votaciones) {
      roster.set(clean(diputado), { group: clean(grupo), seat: asiento });
    }
  }
  const names = [...roster.keys()].sort((a, b) => a.localeCompare(b, 'es'));
  const deputies = names.map((name) => ({ name, ...roster.get(name)! }));

  for (const [i, voting] of raw.entries()) {
    if (isoDate(voting.informacion.fecha.split('/').map((p) => p.padStart(2, '0')).join('/')) !== day) {
      console.warn(`${day}: voting ${i + 1} reports date ${voting.informacion.fecha}`);
    }
    const cast = new Map(voting.votaciones.map((v) => [clean(v.diputado), toVote(v.voto)]));
    const votes = voting.votaciones.length
      ? names.map((name) => {
          const vote = cast.get(name);
          return vote ? VOTE_CODE[vote] : NOT_IN_ROLL_CALL;
        }).join('')
      : '';

    const totals = {
      present: voting.totales.presentes,
      yes: voting.totales.afavor,
      no: voting.totales.enContra,
      abstain: voting.totales.abstenciones,
      absent: voting.totales.noVotan,
      unanimous: clean(voting.totales.asentimiento).startsWith('S'),
    };
    // The published totals are the authority: if the per-deputy tally disagrees, the
    // roll call was parsed wrong and the file must not be published. Secret ballots
    // (suplicatorios) publish totals with no roll call at all.
    for (const key of votes ? (['yes', 'no', 'abstain', 'absent'] as const) : []) {
      const tallied = [...votes].filter((c) => c === VOTE_CODE[key]).length;
      if (tallied !== totals[key]) {
        throw new Error(
          `${day} voting ${voting.informacion.numeroVotacion}: ${key} tallied ${tallied}, totals say ${totals[key]}`,
        );
      }
    }

    votings.push({
      number: voting.informacion.numeroVotacion,
      heading: clean(voting.informacion.titulo),
      title: clean(voting.informacion.textoExpediente),
      subtitle: clean([voting.informacion.tituloSubGrupo, voting.informacion.textoSubGrupo].filter(Boolean).join(' ')),
      expediente: found[i].expediente,
      totals,
      votes,
      source: found[i].url,
    });
    if (!found[i].expediente) noExpediente++;
    totalVotings++;
  }

  const session: Session = {
    date: day,
    session: raw[0].informacion.sesion,
    legislature,
    deputies,
    votings: votings.sort((a, b) => a.number - b.number),
  };
  await writeFile(`${OUT_DIR}/${day}.json`, JSON.stringify(session, null, 1));
  console.log(`${day}: session ${session.session}, ${votings.length} votings`);
}

const files = (await readdir(OUT_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const sessions = await Promise.all(
  files.map(async (f) => JSON.parse(await readFile(`${OUT_DIR}/${f}`, 'utf8')) as Session),
);

await writeFile(
  'data/v1/index.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      legislature,
      source: INDEX_URL,
      days: sessions.map((s) => ({
        date: s.date,
        session: s.session,
        votings: s.votings.length,
        url: `sessions/${s.date}.json`,
      })),
      // Voting days the Congress announces but never published as data, only as a PNG chart.
      missingData: days.filter((d) => !files.includes(`${d}.json`)),
      totals: {
        days: sessions.length,
        votings: sessions.reduce((n, s) => n + s.votings.length, 0),
        withoutExpediente: sessions.reduce(
          (n, s) => n + s.votings.filter((v) => !v.expediente).length,
          0,
        ),
      },
    },
    null,
    1,
  ),
);

// Without this, finding what was voted on a bill means downloading every session.
const fileName = (expediente: string) => expediente.replace('/', '-') + '.json';
const byExpediente = new Map<string, { date: string; session: number; voting: Session['votings'][number] }[]>();
for (const s of sessions) {
  for (const voting of s.votings) {
    if (!voting.expediente) continue;
    const entries = byExpediente.get(voting.expediente) ?? [];
    entries.push({ date: s.date, session: s.session, voting });
    byExpediente.set(voting.expediente, entries);
  }
}

await mkdir('data/v1/expedientes', { recursive: true });
for (const [expediente, entries] of byExpediente) {
  await writeFile(
    `data/v1/expedientes/${fileName(expediente)}`,
    JSON.stringify(
      {
        expediente,
        legislature,
        votings: entries.map(({ date, session, voting }) => ({
          date,
          session,
          number: voting.number,
          heading: voting.heading,
          title: voting.title,
          subtitle: voting.subtitle,
          totals: voting.totals,
          rollCall: `sessions/${date}.json`,
        })),
      },
      null,
      1,
    ),
  );
}

await writeFile(
  'data/v1/expedientes.json',
  JSON.stringify(
    [...byExpediente]
      .map(([expediente, entries]) => ({
        expediente,
        votings: entries.length,
        firstVote: entries[0].date,
        lastVote: entries.at(-1)!.date,
        title: entries.at(-1)!.voting.title,
        url: `expedientes/${fileName(expediente)}`,
      }))
      .sort((a, b) => b.lastVote.localeCompare(a.lastVote)),
    null,
    1,
  ),
);
console.log(`indexed ${byExpediente.size} expedientes`);

console.log(`fetched ${totalVotings} votings, ${noExpediente} without expediente`);
