/**
 * Nuzlocke Simulator — Entry point
 */

'use strict';

import { loadUserGame, nuzlockeGames, pushNuzlockeStatus, pushNuzlockeState, navigateToNuzlocke, pingRedis } from './game';

void pingRedis();

export const loginfilter: Chat.LoginFilter = user => {
	if (!user.named) return;
	const cached = nuzlockeGames.get(user.id) ?? null;
	if (cached) {
		pushNuzlockeStatus(user.id, cached);
		navigateToNuzlocke(user.id);
		setImmediate(() => pushNuzlockeState(user.id, cached));
		return;
	}
	void loadUserGame(user.id).then(game => {
		pushNuzlockeStatus(user.id, game);
		if (game) {
			navigateToNuzlocke(user.id);
			setImmediate(() => pushNuzlockeState(user.id, game));
		}
	});
};

export { nuzlockePages as pages } from './pages';
export { nuzlockeCommands as commands } from './commands';
export { battleHandlers as handlers } from './battle';
