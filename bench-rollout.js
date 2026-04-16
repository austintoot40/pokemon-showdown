/**
 * MCTS rollout speed benchmark.
 *
 * Measures:
 *   1. Full rollout time (battle from start to finish, random play)
 *   2. State serialization + deserialization time (mid-battle snapshot)
 *   3. Estimated MCTS budget at real-time constraints
 *
 * Usage: node bench-rollout.js [numRollouts]
 */

'use strict';

const BattleStreams = require('./dist/sim/battle-stream');
const { RandomPlayerAI } = require('./dist/sim/tools/random-player-ai');
const { State } = require('./dist/sim/state');

const NUM_ROLLOUTS = parseInt(process.argv[2] ?? '100', 10);
const FORMAT = 'gen3randombattle'; // auto-generates teams, no packing needed

// ─── helpers ────────────────────────────────────────────────────────────────

function makeSeed(n) {
	return [n, n + 1, n + 2, n + 3];
}

/** Run one complete battle (both sides random) and return elapsed ms + turn count. */
async function rollout(seed) {
	const battleStream = new BattleStreams.BattleStream();
	const streams = BattleStreams.getPlayerStreams(battleStream);

	const spec = { formatid: FORMAT, seed: makeSeed(seed) };
	const p1spec = { name: 'Rollout P1', seed: makeSeed(seed + 10) };
	const p2spec = { name: 'Rollout P2', seed: makeSeed(seed + 20) };

	const p1 = new RandomPlayerAI(streams.p1, { seed: makeSeed(seed + 30) });
	const p2 = new RandomPlayerAI(streams.p2, { seed: makeSeed(seed + 40) });

	void p1.start();
	void p2.start();
	void streams.omniscient.write(
		`>start ${JSON.stringify(spec)}\n` +
		`>player p1 ${JSON.stringify(p1spec)}\n` +
		`>player p2 ${JSON.stringify(p2spec)}`
	);

	let turns = 0;
	const t0 = performance.now();
	for await (const chunk of streams.omniscient) {
		// Count turns from the battle log
		for (const line of chunk.split('\n')) {
			if (line.startsWith('|turn|')) turns++;
		}
	}
	return { ms: performance.now() - t0, turns };
}

/** Measure state serialize + deserialize time on a mid-battle snapshot. */
async function benchSerialization(seed) {
	const battleStream = new BattleStreams.BattleStream();
	const streams = BattleStreams.getPlayerStreams(battleStream);

	const spec = { formatid: FORMAT, seed: makeSeed(seed) };
	const p1spec = { name: 'Serial P1', seed: makeSeed(seed + 10) };
	const p2spec = { name: 'Serial P2', seed: makeSeed(seed + 20) };

	const p1 = new RandomPlayerAI(streams.p1, { seed: makeSeed(seed + 30) });
	const p2 = new RandomPlayerAI(streams.p2, { seed: makeSeed(seed + 40) });
	void p1.start();
	void p2.start();
	void streams.omniscient.write(
		`>start ${JSON.stringify(spec)}\n` +
		`>player p1 ${JSON.stringify(p1spec)}\n` +
		`>player p2 ${JSON.stringify(p2spec)}`
	);

	// Let the battle run to completion; snapshot state at turn 5
	let turns = 0;
	let serialized = null;
	let serMs = 0;
	for await (const chunk of streams.omniscient) {
		for (const line of chunk.split('\n')) {
			if (line.startsWith('|turn|')) turns++;
		}
		if (turns >= 5 && !serialized && battleStream.battle) {
			const t0 = performance.now();
			const snap = State.serializeBattle(battleStream.battle);
			serialized = JSON.stringify(snap);
			JSON.parse(serialized); // measure full round-trip
			serMs = performance.now() - t0;
		}
	}

	return { serMs, stateBytes: serialized ? Buffer.byteLength(serialized) : 0 };
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
	console.log(`Benchmarking ${NUM_ROLLOUTS} rollouts (${FORMAT})...\n`);

	// Warm up (first run includes module init overhead)
	await rollout(0);

	// Full rollout timing
	const times = [];
	const turnCounts = [];
	for (let i = 1; i <= NUM_ROLLOUTS; i++) {
		const { ms, turns } = await rollout(i * 100);
		times.push(ms);
		turnCounts.push(turns);
	}

	const totalMs = times.reduce((a, b) => a + b, 0);
	const avgMs = totalMs / times.length;
	const minMs = Math.min(...times);
	const maxMs = Math.max(...times);
	const avgTurns = turnCounts.reduce((a, b) => a + b, 0) / turnCounts.length;
	const msPerTurn = avgMs / avgTurns;

	console.log('── Rollout timing ──────────────────────────────');
	console.log(`  Rollouts:        ${NUM_ROLLOUTS}`);
	console.log(`  Avg ms/rollout:  ${avgMs.toFixed(2)}`);
	console.log(`  Min ms/rollout:  ${minMs.toFixed(2)}`);
	console.log(`  Max ms/rollout:  ${maxMs.toFixed(2)}`);
	console.log(`  Avg turns/game:  ${avgTurns.toFixed(1)}`);
	console.log(`  Avg ms/turn:     ${msPerTurn.toFixed(2)}`);
	console.log();

	// Serialization timing (3 samples, averaged)
	const serResults = await Promise.all([1, 2, 3].map(i => benchSerialization(i * 999)));
	const avgSerMs = serResults.reduce((a, b) => a + b.serMs, 0) / serResults.length;
	const avgBytes = serResults.reduce((a, b) => a + b.stateBytes, 0) / serResults.length;

	console.log('── State serialization (round-trip) ────────────');
	console.log(`  Avg serialize+deserialize: ${avgSerMs.toFixed(2)} ms`);
	console.log(`  Avg state size:            ${(avgBytes / 1024).toFixed(1)} KB`);
	console.log();

	// MCTS budget estimates
	console.log('── MCTS budget estimates ───────────────────────');
	for (const budget of [500, 1000, 2000, 5000]) {
		const rollouts = Math.floor(budget / avgMs);
		console.log(`  ${budget}ms budget → ~${rollouts} rollouts`);
	}
	const serOverheadPerRollout = avgSerMs; // each MCTS node restores state
	const rolloutPlusRestore = avgMs + serOverheadPerRollout;
	console.log();
	console.log(`  (With state restore overhead: ${rolloutPlusRestore.toFixed(1)} ms/rollout)`);
	for (const budget of [500, 1000, 2000, 5000]) {
		const rollouts = Math.floor(budget / rolloutPlusRestore);
		console.log(`  ${budget}ms budget → ~${rollouts} rollouts (with restore)`);
	}
}

main().catch(err => { console.error(err); process.exit(1); });
