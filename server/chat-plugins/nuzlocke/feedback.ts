import * as https from 'https';

interface BugReportPayload {
	message: string;
	username: string;
	screen?: string;
	recentCommands?: string[];
	userAgent?: string;
	gameState?: object;
}

export function postBugReportToDiscord(payload: BugReportPayload): void {
	const webhookUrl = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
	if (!webhookUrl) return;

	const reportJson = JSON.stringify({
		timestamp: new Date().toISOString(),
		reporter: payload.username,
		screen: payload.screen ?? 'unknown',
		message: payload.message,
		recentCommands: payload.recentCommands ?? [],
		userAgent: payload.userAgent ?? '',
		gameState: payload.gameState ?? null,
	}, null, 2);

	const messageJson = JSON.stringify({
		content: `**Bug report from ${payload.username}**\n> ${payload.message.slice(0, 200)}${payload.message.length > 200 ? '…' : ''}`,
	});

	const boundary = `----FormBoundary${Date.now().toString(16)}`;
	const CRLF = '\r\n';

	const parts: Buffer[] = [
		Buffer.from(
			`--${boundary}${CRLF}` +
			`Content-Disposition: form-data; name="payload_json"${CRLF}` +
			`Content-Type: application/json${CRLF}${CRLF}` +
			messageJson + CRLF
		),
		Buffer.from(
			`--${boundary}${CRLF}` +
			`Content-Disposition: form-data; name="files[0]"; filename="bug-report.json"${CRLF}` +
			`Content-Type: application/json${CRLF}${CRLF}` +
			reportJson + CRLF
		),
		Buffer.from(`--${boundary}--${CRLF}`),
	];

	const body = Buffer.concat(parts);

	let url: URL;
	try {
		url = new URL(webhookUrl);
	} catch {
		return;
	}

	const req = https.request({
		hostname: url.hostname,
		path: url.pathname + url.search,
		method: 'POST',
		headers: {
			'Content-Type': `multipart/form-data; boundary=${boundary}`,
			'Content-Length': body.length,
		},
	});
	req.on('error', () => {});
	req.write(body);
	req.end();
}
