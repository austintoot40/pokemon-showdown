import type { Battle } from '../battle';
import { NuzlockeAI } from './base';
import { BasicAI } from './basic';
import { SmartAI } from './smart';

export { NuzlockeAI };

export function createNuzlockeAI(difficulty: string, battle: Battle): NuzlockeAI {
	switch (difficulty) {
	case 'smart': return new SmartAI(battle);
	case 'basic':
	default: return new BasicAI(battle);
	}
}
