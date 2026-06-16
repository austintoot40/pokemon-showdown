/**
 * Nuzlocke Simulator — Redis persistence
 *
 * Write-through cache layer for active game state.
 * If Redis is unavailable, all operations no-op and the in-memory Map
 * continues to work normally.
 *
 * DB layout:
 *   db 0 — active game state (this file)
 *   (future db indexes for other datasets go here)
 */

import Redis from 'ioredis';
import type { NuzlockeGame } from './game';
import { logNuzlockeError } from './error-logger';

const DB_GAMES = 0;
const GAME_KEY = (userId: string) => `game:${userId}`;
const BEATS_KEY = (userId: string) => `beaten:${userId}`;
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

let client: Redis | null = null;

function getRedis(): Redis {
	if (!client) {
		const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
		client = new Redis(url, { db: DB_GAMES });
		client.on('error', err => {
			logNuzlockeError({
				timestamp: new Date().toISOString(),
				source: 'server',
				error: { message: err.message, stack: err.stack },
				context: { command: 'redis.on(error)' },
			});
		});
	}
	return client;
}

export async function pingRedis(): Promise<void> {
	try {
		await getRedis().ping();
		console.log('[nuzlocke] Redis connected');
	} catch (err: any) {
		logNuzlockeError({
			timestamp: new Date().toISOString(),
			source: 'server',
			error: { message: err?.message ?? String(err), stack: err?.stack },
			context: { command: 'pingRedis' },
		});
	}
}

export async function saveGameToRedis(game: NuzlockeGame): Promise<void> {
	try {
		await getRedis().set(GAME_KEY(game.user), JSON.stringify(game), 'EX', TTL_SECONDS);
	} catch (err: any) {
		logNuzlockeError({
			timestamp: new Date().toISOString(),
			source: 'server',
			error: { message: err?.message ?? String(err), stack: err?.stack },
			context: { command: 'saveGameToRedis', userId: game.user },
		});
	}
}

export async function deleteGameFromRedis(userId: string): Promise<void> {
	try {
		await getRedis().del(GAME_KEY(userId));
	} catch {}
}

export async function loadGameFromRedis(userId: string): Promise<string | null> {
	try {
		return await getRedis().get(GAME_KEY(userId));
	} catch {
		return null;
	}
}

export async function migrateBeatenScenariosToSets(): Promise<void> {
	let cursor = '0';
	let migrated = 0;
	do {
		const [next, keys] = await getRedis().scan(cursor, 'MATCH', 'beaten:*', 'COUNT', 100);
		cursor = next;
		for (const key of keys) {
			if (await getRedis().type(key) !== 'string') continue;
			const raw = await getRedis().get(key);
			const ids: string[] = raw ? JSON.parse(raw) : [];
			await getRedis().del(key);
			if (ids.length) await getRedis().sadd(key, ...ids);
			migrated++;
		}
	} while (cursor !== '0');
	if (migrated > 0) console.log(`[nuzlocke] Migrated ${migrated} beaten: key(s) to Redis Sets`);
}

export async function saveBeatenScenario(userId: string, scenarioId: string): Promise<void> {
	try {
		await getRedis().sadd(BEATS_KEY(userId), scenarioId);
	} catch {}
}

export async function loadBeatenScenarios(userId: string): Promise<string[]> {
	try {
		return await getRedis().smembers(BEATS_KEY(userId));
	} catch {
		return [];
	}
}

const TOTAL_RUNS_KEY = 'runs:total';

export async function incrementTotalRuns(): Promise<number> {
	try {
		return await getRedis().incr(TOTAL_RUNS_KEY);
	} catch {
		return 0;
	}
}

export async function getTotalRuns(): Promise<number> {
	try {
		const val = await getRedis().get(TOTAL_RUNS_KEY);
		return val ? parseInt(val, 10) : 0;
	} catch {
		return 0;
	}
}
