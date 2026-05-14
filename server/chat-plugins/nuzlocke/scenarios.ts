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
function buildRequiresIndexes(segs: any[]) {
	// Battle index: first segment containing each battle ID.
	// Battle-gated items defer to the segment AFTER the battle (battles fire mid-segment,
	// not at resolveSegmentStart, so the item must wait until the following segment).
	const battleFirstAvailable = new Map<string, number>();
	for (let i = 0; i < segs.length; i++) {
		for (const battle of segs[i].battles ?? []) {
			const id = toID(typeof battle === 'string' ? battle : battle.id);
			if (!battleFirstAvailable.has(id)) battleFirstAvailable.set(id, i + 1);
		}
	}

	// Move index: first segment where each TM/HM becomes available.
	// Deferred TMs are indexed at their resolved landing segment (computed here using
	// battleFirstAvailable), so that items gated behind them (e.g. Good Rod requires Surf,
	// Surf requires Norman) are correctly deferred.
	const moveFirstAvailable = new Map<string, number>();
	for (let i = 0; i < segs.length; i++) {
		for (const tm of segs[i].tmMoves ?? []) {
			if (typeof tm === 'string') {
				const id = toID(tm);
				if (!moveFirstAvailable.has(id)) moveFirstAvailable.set(id, i);
			} else {
				// Deferred TM: resolve its actual landing segment now.
				const type = tm.requires?.type;
				const reqName = toID(tm.requires?.name ?? '');
				let resolvedIdx = i;
				if (type === 'battle') {
					const reqIdx = battleFirstAvailable.get(reqName);
					if (reqIdx !== undefined && reqIdx > i) resolvedIdx = Math.min(reqIdx, segs.length - 1);
				}
				// move-requires-move not present in current data; if needed, add a second pass.
				const id = toID(tm.name);
				if (!moveFirstAvailable.has(id)) moveFirstAvailable.set(id, resolvedIdx);
			}
		}
	}

	return { moveFirstAvailable, battleFirstAvailable };
}

function resolveTarget(
	entry: any,
	i: number,
	maxIdx: number,
	moveFirstAvailable: Map<string, number>,
	battleFirstAvailable: Map<string, number>
): number {
	const type = entry.requires?.type;
	const name = toID(entry.requires?.name ?? '');
	const reqIdx = type === 'battle'
		? battleFirstAvailable.get(name)
		: moveFirstAvailable.get(name);
	return reqIdx !== undefined && reqIdx > i ? Math.min(reqIdx, maxIdx) : i;
}

function resolveRequires(raw: any): Scenario {
	const segs: any[] = raw.segments ?? [];
	const { moveFirstAvailable, battleFirstAvailable } = buildRequiresIndexes(segs);

	// Resolve deferred items and TMs into per-segment buckets.
	const resolvedItems: string[][] = segs.map(() => []);
	const resolvedTms: string[][] = segs.map(() => []);

	for (let i = 0; i < segs.length; i++) {
		for (const entry of segs[i].items ?? []) {
			if (typeof entry === 'string') {
				resolvedItems[i].push(entry);
			} else {
				const target = resolveTarget(entry, i, segs.length - 1, moveFirstAvailable, battleFirstAvailable);
				resolvedItems[target].push(entry.name);
			}
		}
		for (const entry of segs[i].tmMoves ?? []) {
			if (typeof entry === 'string') {
				resolvedTms[i].push(entry);
			} else {
				const target = resolveTarget(entry, i, segs.length - 1, moveFirstAvailable, battleFirstAvailable);
				resolvedTms[target].push(entry.name);
			}
		}
	}

	for (let i = 0; i < segs.length; i++) {
		segs[i].items = resolvedItems[i];
		segs[i].tmMoves = resolvedTms[i];
	}

	raw.tmRouteMap = {};
	raw.itemRouteMap = {};
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

	// Aggregate items/tmMoves from each segment's locations into synthetic flat segments,
	// then resolve deferred entries using the shared helpers.
	const syntheticSegs = raw.segments.map(seg => {
		const locs = seg.locations.map(id => locationMap.get(id));
		const items: any[] = [];
		const tmMoves: any[] = [];
		for (const loc of locs) {
			if (!loc) continue;
			items.push(...(loc.items ?? []));
			tmMoves.push(...(loc.tmMoves ?? []));
		}
		return { items, tmMoves, battles: seg.battles };
	});

	const { moveFirstAvailable, battleFirstAvailable } = buildRequiresIndexes(syntheticSegs);

	const resolvedItems: string[][] = syntheticSegs.map(() => []);
	const resolvedTms: string[][] = syntheticSegs.map(() => []);

	for (let i = 0; i < syntheticSegs.length; i++) {
		for (const entry of syntheticSegs[i].items) {
			if (typeof entry === 'string') {
				resolvedItems[i].push(entry);
			} else {
				const target = resolveTarget(entry, i, syntheticSegs.length - 1, moveFirstAvailable, battleFirstAvailable);
				resolvedItems[target].push(entry.name);
			}
		}
		for (const entry of syntheticSegs[i].tmMoves) {
			if (typeof entry === 'string') {
				resolvedTms[i].push(entry);
			} else {
				const target = resolveTarget(entry, i, syntheticSegs.length - 1, moveFirstAvailable, battleFirstAvailable);
				resolvedTms[target].push(entry.name);
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

			if (encounterZones.length > 0) {
				// Gift zones are merged into the encounter route as additional zones shown in the detail panel.
				encounters.push({ route: routeName, zones: [...giftZones, ...encounterZones] });
			} else {
				// Pure gift/trade location — each Gift zone becomes its own RouteEncounter.
				// Choice is inferred: multiple Pokemon options means the player selects; single auto-resolves.
				for (const gz of giftZones) {
					gifts.push({ route: routeName, zones: [gz], choice: gz.pokemon.length > 1 });
				}
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

	// Build moveId → location name map from original location data (before deferred resolution,
	// so the route shown is always where the TM was physically found, not where it was deferred to).
	const tmRouteMap: Record<string, string> = {};
	for (const loc of locationDefs) {
		const routeName = loc.name ?? loc.id;
		for (const entry of loc.tmMoves ?? []) {
			const moveName = typeof entry === 'string' ? entry : entry.name;
			const id = toID(moveName);
			if (!tmRouteMap[id]) tmRouteMap[id] = routeName;
		}
	}

	const itemRouteMap: Record<string, string> = {};
	for (const loc of locationDefs) {
		const routeName = loc.name ?? loc.id;
		for (const entry of loc.items ?? []) {
			const itemName = typeof entry === 'string' ? entry : entry.name;
			const id = toID(itemName);
			if (!itemRouteMap[id]) itemRouteMap[id] = routeName;
		}
	}

	return {
		id: raw.id,
		name: raw.name,
		generation: raw.generation,
		description: raw.description ?? '',
		color: raw.color ?? '',
		pokemon: raw.pokemon ?? '',
		starters: raw.starters,
		segments,
		tmRouteMap,
		itemRouteMap,
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
				if (!nuzlocke.verified) continue;
				const locations: LocationDefinition[] = JSON.parse(FS(`${path}/locations.json`).readSync());
				const battles: TrainerBattle[] = JSON.parse(FS(`${path}/battles.json`).readSync());
				const data = resolveScenario(nuzlocke, locations, battles);
				scenarios.set(data.id, data);
			} else if (entry.endsWith('.json')) {
				// Legacy flat format — skip if a subfolder for this game already exists
				const baseName = entry.slice(0, -5);
				if (migratedFolders.has(baseName)) continue;
				const raw = JSON.parse(FS(path).readSync());
				if (!raw.verified) continue;
				const data: Scenario = resolveRequires(raw);
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
