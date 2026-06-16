import type { Battle } from '../battle';
import { NuzlockeAI } from './base';
import { SmartAI } from './smart';

export { NuzlockeAI };

export function createNuzlockeAI(difficulty: string, battle: Battle): NuzlockeAI {
	if (difficulty === 'smart') return new SmartAI(battle);
	return new NuzlockeAI(battle);
}
