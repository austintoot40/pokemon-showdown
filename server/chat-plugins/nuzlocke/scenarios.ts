/**
 * Nuzlocke Simulator — Scenario Loading
 */

import { FS } from '../../../lib';
import type { LocationDefinition, RawScenario, RouteEncounter, Scenario, Segment, TrainerBattle } from './types';

const SCENARIO_DIR = 'data/nuzlocke-scenarios';

const scenarios = new Map<string, Scenario>();

/**
 * Resolves `requires` fields on items and TMs, moving deferred entries to the
 * first segment where their prerequisite move is available.
 *
 * Items/TMs in the JSON may be either a plain string or a gated entry:
 *   { "id": "HM Strength", "requires": "Surf" }
 *
 * Zone `requires` fields are left in place for the client to use.
 */
function resolveRequires(raw: any): Scenario {
	const segs: any[] = raw.segments ?? [];

	// Pass 1: build move availability index from plain-string TM entries only.
	// Deferred TMs (those with `requires`) are not counted here since they may
	// themselves move to a later segment.
	const moveFirstAvailable = new Map<string, number>();
	for (let i = 0; i < segs.length; i++) {
		for (const tm of segs[i].tmMoves ?? []) {
			if (typeof tm === 'string') {
				const id = toID(tm);
				if (!moveFirstAvailable.has(id)) moveFirstAvailable.set(id, i);
			}
		}
	}

	// Pass 2: resolve deferred items and TMs into per-segment buckets.
	const resolvedItems: string[][] = segs.map(() => []);
	const resolvedTms: string[][] = segs.map(() => []);

	for (let i = 0; i < segs.length; i++) {
		for (const entry of segs[i].items ?? []) {
			if (typeof entry === 'string') {
				resolvedItems[i].push(entry);
			} else {
				const reqIdx = moveFirstAvailable.get(toID(entry.requires));
				const target = reqIdx !== undefined && reqIdx > i ? reqIdx : i;
				resolvedItems[target].push(entry.id);
			}
		}
		for (const entry of segs[i].tmMoves ?? []) {
			if (typeof entry === 'string') {
				resolvedTms[i].push(entry);
			} else {
				const reqIdx = moveFirstAvailable.get(toID(entry.requires));
				const target = reqIdx !== undefined && reqIdx > i ? reqIdx : i;
				resolvedTms[target].push(entry.id);
			}
		}
	}

	for (let i = 0; i < segs.length; i++) {
		segs[i].items = resolvedItems[i];
		segs[i].tmMoves = resolvedTms[i];
	}

	return raw as Scenario;
}

/**
 * Resolves a 3-file scenario (nuzlocke.json + locations.json + battles.json) into
 * the runtime Scenario type. Location zones are split by method into encounters vs
 * gifts. Items/TMs from all locations in each segment are collected and run through
 * the same resolveRequires two-pass algorithm.
 */
function resolveScenario(
	raw: RawScenario,
	locationDefs: LocationDefinition[],
	battleDefs: TrainerBattle[]
): Scenario {
	const locationMap = new Map(locationDefs.map(l => [l.id, l]));
	const battleMap = new Map(battleDefs.map(b => [b.id, b]));

	// Build a synthetic flat structure matching what resolveRequires expects:
	// each "segment" has items/tmMoves arrays aggregated from its locations.
	const syntheticSegs = raw.segments.map(seg => {
		const locs = seg.locations.map(id => locationMap.get(id));
		const items: any[] = [];
		const tmMoves: any[] = [];
		for (const loc of locs) {
			if (!loc) continue;
			items.push(...(loc.items ?? []));
			tmMoves.push(...(loc.tmMoves ?? []));
		}
		return { items, tmMoves };
	});

	// Run the same two-pass resolveRequires logic, but sourced from syntheticSegs.
	const moveFirstAvailable = new Map<string, number>();
	for (let i = 0; i < syntheticSegs.length; i++) {
		for (const tm of syntheticSegs[i].tmMoves) {
			if (typeof tm === 'string') {
				const id = toID(tm);
				if (!moveFirstAvailable.has(id)) moveFirstAvailable.set(id, i);
			}
		}
	}

	const resolvedItems: string[][] = syntheticSegs.map(() => []);
	const resolvedTms: string[][] = syntheticSegs.map(() => []);

	for (let i = 0; i < syntheticSegs.length; i++) {
		for (const entry of syntheticSegs[i].items) {
			if (typeof entry === 'string') {
				resolvedItems[i].push(entry);
			} else {
				const reqIdx = moveFirstAvailable.get(toID(entry.requires));
				const target = reqIdx !== undefined && reqIdx > i ? reqIdx : i;
				resolvedItems[target].push(entry.id);
			}
		}
		for (const entry of syntheticSegs[i].tmMoves) {
			if (typeof entry === 'string') {
				resolvedTms[i].push(entry);
			} else {
				const reqIdx = moveFirstAvailable.get(toID(entry.requires));
				const target = reqIdx !== undefined && reqIdx > i ? reqIdx : i;
				resolvedTms[target].push(entry.id);
			}
		}
	}

	// Build resolved segments.
	const segments: Segment[] = raw.segments.map((seg, i) => {
		const locs = seg.locations.map(id => locationMap.get(id));
		const encounters: RouteEncounter[] = [];
		const gifts: RouteEncounter[] = [];

		for (const loc of locs) {
			if (!loc || !loc.zones?.length) continue;
			const routeName = loc.name ?? loc.id;
			const encounterZones = loc.zones.filter(z => z.method !== 'Gift');
			const giftZones = loc.zones.filter(z => z.method === 'Gift');

			if (encounterZones.length) {
				encounters.push({ route: routeName, zones: encounterZones });
			}
			// Each Gift zone becomes its own RouteEncounter so choice can differ per zone.
			for (const gz of giftZones) {
				gifts.push({ route: routeName, zones: [gz], choice: gz.choice });
			}
		}

		const battles = seg.battles.map(id => battleMap.get(id)).filter(Boolean) as TrainerBattle[];

		return {
			id: seg.id,
			name: seg.name,
			encounters,
			gifts,
			items: resolvedItems[i],
			tmMoves: resolvedTms[i],
			battles,
		};
	});

	return {
		id: raw.id,
		name: raw.name,
		generation: raw.generation,
		description: raw.description ?? '',
		color: raw.color ?? '',
		pokemon: raw.pokemon ?? '',
		verified: false,
		starters: raw.starters,
		segments,
	};
}

export function loadScenarios() {
	scenarios.clear();
	let entries: string[];
	try {
		entries = FS(SCENARIO_DIR).readdirSync();
	} catch {
		return;
	}
	// Collect subfolder names so flat files can be skipped when a subfolder exists.
	const migratedFolders = new Set(
		entries.filter(e => FS(`${SCENARIO_DIR}/${e}`).isDirectorySync())
	);

	for (const entry of entries) {
		const path = `${SCENARIO_DIR}/${entry}`;
		try {
			if (FS(path).isDirectorySync()) {
				// New 3-file format: {game}/nuzlocke.json + locations.json + battles.json
				const nuzlocke: RawScenario = JSON.parse(FS(`${path}/nuzlocke.json`).readSync());
				const locations: LocationDefinition[] = JSON.parse(FS(`${path}/locations.json`).readSync());
				const battles: TrainerBattle[] = JSON.parse(FS(`${path}/battles.json`).readSync());
				const data = resolveScenario(nuzlocke, locations, battles);
				scenarios.set(data.id, data);
			} else if (entry.endsWith('.json')) {
				// Legacy flat format — skip if a subfolder for this game already exists
				const baseName = entry.slice(0, -5);
				if (migratedFolders.has(baseName)) continue;
				const data: Scenario = resolveRequires(JSON.parse(FS(path).readSync()));
				scenarios.set(data.id, data);
			}
		} catch (e) {
			console.error(`[Nuzlocke] Failed to load scenario ${entry}: ${e}`);
		}
	}
}

export function getScenario(id: string): Scenario | null {
	return scenarios.get(id) ?? null;
}

export function listScenarios(): Scenario[] {
	return [...scenarios.values()];
}

// Load on import
loadScenarios();
