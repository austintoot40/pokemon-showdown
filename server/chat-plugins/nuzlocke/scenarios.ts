/**
 * Nuzlocke Simulator — Scenario Loading
 */

import { FS } from '../../../lib';
import type { Scenario } from './types';

const SCENARIO_DIR = 'data/nuzlocke-scenarios';

const scenarios = new Map<string, Scenario>();

export function loadScenarios() {
	scenarios.clear();
	let files: string[];
	try {
		files = FS(SCENARIO_DIR).readdirSync();
	} catch {
		return;
	}
	for (const file of files) {
		if (!file.endsWith('.json')) continue;
		try {
			const raw = FS(`${SCENARIO_DIR}/${file}`).readSync();
			const data: Scenario = JSON.parse(raw);
			scenarios.set(data.id, data);
		} catch (e) {
			console.error(`[Nuzlocke] Failed to load scenario ${file}: ${e}`);
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
