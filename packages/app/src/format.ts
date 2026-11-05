// The shared formatters, under the names the web app uses; @mob/client re-exports them for every client.
export {
	formatDuration as duration,
	formatMoney as money,
	formatSeconds as seconds,
	formatSpeed as rate,
	formatTokens as tokens,
	modelName,
	replySpeed as speed,
} from '@mob/client';
