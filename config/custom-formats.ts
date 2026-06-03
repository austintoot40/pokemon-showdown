// Note: This is the list of formats
// The rules that formats use are stored in data/rulesets.ts

function nuzlockeOnBattleStart(this: any) {
	// Reveal both teams so the player sees the opponent's full moveset from turn 1.
	this.showOpenTeamSheets();
}

export const Formats: import('../sim/dex-formats').FormatList = [
	{
		section: "Nuzlocke Formats",
		column: 4,
	},
	{
		name: "[Gen 1] Nuzlocke Battle",
		mod: 'gen1',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 1] Nuzlocke Doubles Battle",
		mod: 'gen1',
		gameType: 'doubles',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 2] Nuzlocke Battle",
		mod: 'gen2',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 2] Nuzlocke Doubles Battle",
		mod: 'gen2',
		gameType: 'doubles',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 3] Nuzlocke Battle",
		mod: 'gen3',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 3] Nuzlocke Doubles Battle",
		mod: 'gen3',
		gameType: 'doubles',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 4] Nuzlocke Battle",
		mod: 'gen4',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 4] Nuzlocke Doubles Battle",
		mod: 'gen4',
		gameType: 'doubles',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 5] Nuzlocke Battle",
		mod: 'gen5',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 5] Nuzlocke Doubles Battle",
		mod: 'gen5',
		gameType: 'doubles',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 6] Nuzlocke Battle",
		mod: 'gen6',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 6] Nuzlocke Doubles Battle",
		mod: 'gen6',
		gameType: 'doubles',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 7] Nuzlocke Battle",
		mod: 'gen7',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 7] Nuzlocke Doubles Battle",
		mod: 'gen7',
		gameType: 'doubles',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 8] Nuzlocke Battle",
		mod: 'gen8',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 8] Nuzlocke Doubles Battle",
		mod: 'gen8',
		gameType: 'doubles',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 9] Nuzlocke Battle",
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 9] Nuzlocke Doubles Battle",
		gameType: 'doubles',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 9] Modernized Nuzlocke Battle",
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod', 'Terastal Clause'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
	{
		name: "[Gen 9] Modernized Nuzlocke Doubles Battle",
		gameType: 'doubles',
		challengeShow: false,
		searchShow: false,
		ruleset: ['HP Percentage Mod', 'Cancel Mod', 'Terastal Clause'],
		onValidateTeam() {
			return [`This format cannot be used directly.`];
		},
		onBattleStart: nuzlockeOnBattleStart,
	},
];
