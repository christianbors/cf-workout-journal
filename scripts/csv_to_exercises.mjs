#!/usr/bin/env node
// Convert a workout-plan CSV into the structured JSON format used by exercises.json.
//
// Usage:
//     node scripts/csv_to_exercises.mjs <input.csv> <output.json> [lang]
//
// The output records match the schema of the upstream exercises.json dataset:
//
//     {
//       id: '0001',
//       name: 'Cossack Squat',
//       category: 'warm-up',
//       body_part: 'Full body',
//       equipment: 'Dumbbells',
//       instructions: { en: '...' },
//       instruction_steps: { en: ['...', '...'] },
//       muscle_group: 'Upper Chest',
//       secondary_muscles: ['Shoulders'],
//       target: 'Upper Chest',
//       image: '', gif_url: '', media_id: '',
//       created_at: '...', attribution: ''
//     }
//
// Arguments:
//     input.csv   required  CSV file (comma-separated, with a header row)
//     output.json required  path of the JSON file to write
//     lang        optional  language code for the instructions (default: en)

import { parseArgs as utilParseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_LANG = 'en';
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

const USAGE = 'usage: node scripts/csv_to_exercises.mjs <input.csv> <output.json> [lang]';

function fail(message) {
	console.error(message);
	process.exit(1);
}

function parseArgs(argv) {
	const { positionals } = utilParseArgs({
		allowPositionals: true,
		args: argv,
	});
	if (positionals.length < 2 || positionals.length > 3) {
		fail(USAGE);
	}
	const [source, dest, lang = DEFAULT_LANG] = positionals;
	if (!LANG_RE.test(lang)) {
		fail(`error: invalid language code '${lang}' (expected e.g. 'en', 'de', 'pt-BR')`);
	}
	return { source, dest, lang };
}

/** 'Upper Chest, Shoulders' -> ['Upper Chest', 'Shoulders'] */
function splitMuscles(raw) {
	if (!raw) return [];
	return raw.split(',').map((part) => part.trim()).filter(Boolean);
}

/** Split an instruction paragraph into sentence-like steps. */
function splitSteps(text) {
	text = text.trim();
	if (!text) return [];
	// Split after sentence terminators, keeping the punctuation, and merge
	// fragments that are too short (e.g. abbreviations like "e.g.").
	const parts = text.split(/(?<=[.!?])\s+/);
	const steps = [];
	let buf = '';
	for (const part of parts) {
		buf = buf ? `${buf} ${part}` : part;
		if (buf.length >= 15) { // heuristic: complete sentences are longer
			steps.push(buf);
			buf = '';
		}
	}
	if (buf) steps.push(buf);
	return steps;
}

function clean(value) {
	return (value ?? '').trim();
}

function convertRow(row, index, lang) {
	const name = clean(row.exercise_name);
	if (!name) return null;

	const muscles = splitMuscles(row.muscle_groups_activated);
	const instructionsText = clean(row.instructions);

	return {
		id: String(2000 + index + 1).padStart(4, '0'),
		name,
		category: clean(row.type_of_activity).toLowerCase(),
		body_part: clean(row.body_part),
		equipment: clean(row.type_of_equipment),
		instructions: instructionsText ? { [lang]: instructionsText } : {},
		instruction_steps: instructionsText ? { [lang]: splitSteps(instructionsText) } : {},
		muscle_group: muscles[0] ?? '',
		secondary_muscles: muscles,
		target: muscles[0] ?? '',
		image: '',
		gif_url: '',
		media_id: '',
		created_at: new Date().toISOString(),
		attribution: '',
	};
}

/** Minimal CSV parser supporting quoted fields, embedded commas/newlines, and escaped quotes. */
function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;
	let i = 0;

	const endField = () => {
		row.push(field);
		field = '';
	};
	const endRow = () => {
		// Skip completely empty trailing lines.
		if (row.length > 1 || field !== '' || row[0] !== '') {
			endField();
			rows.push(row);
		}
		row = [];
	};

	while (i < text.length) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			i++;
		} else if (ch === ',') {
			endField();
			i++;
		} else if (ch === '\r') {
			i++;
		} else if (ch === '\n') {
			endRow();
			i++;
		} else {
			field += ch;
			i++;
		}
	}
	if (field !== '' || row.length > 0) endRow();
	return rows;
}

function csvToObjects(text) {
	const rows = parseCsv(text);
	if (rows.length === 0) fail('error: CSV is empty');
	const headers = rows[0];
	return rows.slice(1).map((cells) => {
		const obj = {};
		headers.forEach((header, idx) => {
			obj[header] = cells[idx] ?? '';
		});
		return obj;
	});
}

function main() {
	const { source, dest, lang } = parseArgs(process.argv.slice(2));

	let text;
	try {
		// Strip UTF-8 BOM before parsing.
		text = readFileSync(source, 'utf8').replace(/^\uFEFF/, '');
	} catch {
		fail(`error: input file not found: ${source}`);
	}

	const records = [];
	const skipped = [];
	const rows = csvToObjects(text);

	const required = ['exercise_name', 'instructions', 'muscle_groups_activated', 'type_of_equipment', 'session_name'];
	const missing = required.filter((col) => !(col in rows[0]));
	if (missing.length > 0) {
		fail(`error: CSV is missing required columns: ${missing.sort().join(', ')}`);
	}

	for (const row of rows) {
		const record = convertRow(row, records.length, lang);
		if (record === null) {
			skipped.push(records.length + 1);
			continue;
		}
		records.push(record);
	}

	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, JSON.stringify(records, null, 2) + '\n', 'utf8');

	console.log(`converted ${records.length} exercises -> ${dest} (lang: ${lang})`);
	if (skipped.length > 0) {
		console.log(`skipped ${skipped.length} row(s) without exercise_name: ${skipped.join(', ')}`);
	}
}

main();
