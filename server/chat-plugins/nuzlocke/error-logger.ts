/**
 * Nuzlocke Simulator — Error Logger
 */

import * as fs from 'fs';
import * as path from 'path';

export interface NuzlockeErrorEntry {
	timestamp: string;
	source: 'server' | 'client';
	error: { message: string; stack?: string };
	gameState?: object;
	scenarioId?: string;
	segmentId?: string;
	context?: Record<string, unknown>;
}

const LOG_PATH = path.join(__dirname, '..', '..', '..', '..', 'logs', 'nuzlocke-error.log');

export function logNuzlockeError(entry: NuzlockeErrorEntry): void {
	try {
		fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
	} catch (e) {
		console.error('[nuzlocke] Failed to write error log:', e);
	}
}
