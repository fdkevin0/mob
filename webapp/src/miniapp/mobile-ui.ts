/** One visible live region, outside forms and document flow. */
export function notify(message: string): void {
	document.getElementById('miniapp-notification')?.remove();
	const toast = document.createElement('div');
	toast.id = 'miniapp-notification';
	toast.className = 'pointer-events-auto mx-auto w-fit max-w-full rounded-xl border border-separator bg-surface px-4 py-3 text-center text-foreground shadow-lg wrap-anywhere';
	toast.setAttribute('role', 'status');
	toast.setAttribute('aria-label', message);
	(document.getElementById('miniapp-notifications') ?? document.body).append(toast);
	toast.textContent = message;
	setTimeout(() => toast.remove(), 3000);
}
