import type { Battle } from '../battle';
import { NuzlockeAI } from './base';
import { GameAccurateAI } from './game-accurate';
import { SmartAI } from './smart';
import { CompetitiveAI } from './competitive';

export { NuzlockeAI };

export function createNuzlockeAI(difficulty: string, battle: Battle): NuzlockeAI {
	switch (difficulty) {
	case 'smart': return new SmartAI(battle);
	case 'competitive': return new CompetitiveAI(battle);
	default: return new GameAccurateAI(battle);
	}
}
