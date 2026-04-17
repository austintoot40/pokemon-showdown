/**
 * Nuzlocke Simulator — Error Logger
 *
 * Centralized error logging. LocalFileLogger is the default implementation;
 * swap it for a remote logger by replacing the singleton below.
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

interface ErrorLogger {
	log(entry: NuzlockeErrorEntry): void;
}

class LocalFileLogger implements ErrorLogger {
	constructor(private logPath: string) {}

	log(entry: NuzlockeErrorEntry): void {
		fs.writeFileSync(this.logPath, JSON.stringify(entry, null, 2), 'utf8');
	}
}

const LOG_PATH = path.join(__dirname, '..', '..', '..', 'nuzlocke-error.log');

const errorLogger: ErrorLogger = new LocalFileLogger(LOG_PATH);

export function logNuzlockeError(entry: NuzlockeErrorEntry): void {
	try {
		errorLogger.log(entry);
	} catch (e) {
		console.error('[nuzlocke] Failed to write error log:', e);
	}
}
