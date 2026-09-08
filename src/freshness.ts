import { readFile } from 'node:fs/promises';

// The summer break runs from late July to mid September, the longest legitimate silence.
const MAX_SILENT_DAYS = 60;

const index = JSON.parse(await readFile('data/v1/index.json', 'utf8')) as {
  days: { date: string }[];
};

const last = index.days.at(-1)?.date;
if (!last) throw new Error('data/v1/index.json lists no voting days');

const silentDays = Math.floor((Date.now() - Date.parse(last)) / 86_400_000);
// Ordinary sessions run September-December and February-June (art. 73 CE);
// outside them a long silence is expected, inside it means the scraper broke.
const month = new Date().getMonth() + 1;
const inSession = (month >= 9 && month <= 12) || (month >= 2 && month <= 6);

console.log(`last voting day ${last} (${silentDays} days ago), in session: ${inSession}`);
if (inSession && silentDays > MAX_SILENT_DAYS) {
  console.error(`no new votings in ${silentDays} days: the scraper is probably broken`);
  process.exit(1);
}
