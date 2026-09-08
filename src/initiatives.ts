import { mkdir, writeFile } from 'node:fs/promises';
import { fetchJson, fetchText } from './http.ts';

const INDEX_URL = 'https://www.congreso.es/es/opendata/iniciativas';

type Raw = Record<string, string | undefined>;

export type Initiative = {
  expediente: string;
  legislature: string;
  type: string;
  title: string;
  authors: string[];
  presentedAt: string | null;
  qualifiedAt: string | null;
  status: string;
  result: string | null;
  committee: string | null;
  bocg: string[];
  url: string;
};

export type Law = {
  number: string;
  title: string;
  type: string;
  publishedAt: string | null;
  bulletin: string;
  pdf: string;
};

const clean = (v?: string) => (v ?? '').replace(/\s+/g, ' ').trim();

// Text fields pack several values into one string separated by newlines,
// often with the same value repeated twice.
const lines = (v?: string) => [...new Set((v ?? '').split('\n').map((l) => clean(l)).filter(Boolean))];

const toIso = (v?: string) => {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(clean(v));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

const romanize = (n: number) => {
  const table: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [value, symbol] of table) while (n >= value) (out += symbol), (n -= value);
  return out;
};

const legislature = (v?: string) => {
  const n = Number(clean(v).replace('Leg.', ''));
  return Number.isFinite(n) ? romanize(n) : clean(v);
};

const detailUrl = (leg: string, expediente: string) =>
  `https://www.congreso.es/busqueda-de-iniciativas?p_p_id=iniciativas&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view&_iniciativas_mode=mostrarDetalle&_iniciativas_legislatura=${leg}&_iniciativas_id=${expediente}`;

function toInitiative(raw: Raw): Initiative {
  const leg = legislature(raw.LEGISLATURA);
  // NUMEXPEDIENTE carries a trailing sequence ("122/000001/0000") that the rest
  // of the Congress site drops when identifying the file.
  const expediente = clean(raw.NUMEXPEDIENTE).split('/').slice(0, 2).join('/');
  return {
    expediente,
    legislature: leg,
    type: clean(raw.TIPO),
    title: clean(raw.OBJETO),
    authors: lines(raw.AUTOR),
    presentedAt: toIso(raw.FECHAPRESENTACION),
    qualifiedAt: toIso(raw.FECHACALIFICACION),
    status: clean(raw.SITUACIONACTUAL),
    result: clean(raw.RESULTADOTRAMITACION) || null,
    committee: clean(raw.COMISIONCOMPETENTE) || null,
    bocg: lines(raw.ENLACESBOCG).filter((l) => l.startsWith('http')),
    url: detailUrl(leg, expediente),
  };
}

const toLaw = (raw: Raw): Law => ({
  number: clean(raw.NUMERO_LEY),
  title: clean(raw.TITULO_LEY),
  type: clean(raw.TIPO),
  publishedAt: toIso(raw.FECHA_LEY),
  bulletin: clean(raw.NUMERO_BOLETIN),
  pdf: clean(raw.PDF),
});

const html = await fetchText(INDEX_URL);
const datasets = [...html.matchAll(/\/webpublica\/opendata\/iniciativas\/([A-Za-z]+)__\d+\.json/g)].map((m) => ({
  name: m[1],
  url: 'https://www.congreso.es' + m[0],
}));
if (!datasets.length) throw new Error('no initiative datasets linked at ' + INDEX_URL);

const byExpediente = new Map<string, Initiative>();
const laws: Law[] = [];

for (const { name, url } of datasets) {
  const rows = await fetchJson<Raw[]>(url);
  console.log(`${name}: ${rows.length}`);
  for (const row of rows) {
    // Published laws ship in the same section under a different schema and carry
    // no expediente, so they cannot be linked back to the initiative that produced them.
    if (row.NUMERO_LEY) {
      laws.push(toLaw(row));
      continue;
    }
    const initiative = toInitiative(row);
    if (initiative.expediente) byExpediente.set(initiative.expediente, initiative);
  }
}

const initiatives = [...byExpediente.values()].sort((a, b) =>
  (b.presentedAt ?? '').localeCompare(a.presentedAt ?? ''),
);

await mkdir('data/v1', { recursive: true });
await writeFile('data/v1/initiatives.json', JSON.stringify(initiatives, null, 1));
await writeFile('data/v1/laws.json', JSON.stringify(laws, null, 1));

console.log(`initiatives: ${initiatives.length}, laws: ${laws.length}`);
