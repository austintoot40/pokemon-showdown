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

const DB_GAMES = 0;
const GAME_KEY = (userId: string) => `game:${userId}`;
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

let client: Redis | null = null;

function getRedis(): Redis {
	if (!client) {
		const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
		client = new Redis(url, { db: DB_GAMES });
		client.on('error', err => {
			console.error('[nuzlocke] Redis error:', err.message);
		});
	}
	return client;
}

export async function pingRedis(): Promise<void> {
	try {
		await getRedis().ping();
		console.log('[nuzlocke] Redis connected');
	} catch (err) {
		console.warn('[nuzlocke] Redis unavailable — game state will not persist across restarts:', err);
	}
}

export async function saveGameToRedis(game: NuzlockeGame): Promise<void> {
	try {
		await getRedis().set(GAME_KEY(game.user), JSON.stringify(game), 'EX', TTL_SECONDS);
	} catch (err) {
		console.error('[nuzlocke] saveGameToRedis failed for', game.user, ':', err);
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
