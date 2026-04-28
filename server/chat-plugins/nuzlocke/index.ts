/**
 * Nuzlocke Simulator — Entry point
 */

'use strict';

import { loadUserGame, nuzlockeGames, pushNuzlockeStatus, pushNuzlockeState, navigateToNuzlocke, pingRedis, loadBeatenScenariosForUser } from './game';

void pingRedis();

export const loginfilter: Chat.LoginFilter = user => {
	if (!user.named) {
		pushNuzlockeStatus(user.id, null);
		return;
	}
	void (async () => {
		await loadBeatenScenariosForUser(user.id);
		const game = nuzlockeGames.get(user.id) ?? await loadUserGame(user.id);
		pushNuzlockeStatus(user.id, game);
		if (game) {
			navigateToNuzlocke(user.id);
			setImmediate(() => pushNuzlockeState(user.id, game));
		}
	})();
};

export { nuzlockePages as pages } from './pages';
export { nuzlockeCommands as commands } from './commands';
export { battleHandlers as handlers } from './battle';
