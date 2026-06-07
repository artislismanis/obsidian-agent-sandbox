import { browser, $ } from "@wdio/globals";

// Shared helpers for the settings e2e specs (settings.e2e.ts, settings-inventory.e2e.ts).

export async function openPluginSettings(): Promise<void> {
	await browser.executeObsidianCommand("app:open-settings");
	const tab = $(".vertical-tab-nav-item*=Agent Sandbox");
	await tab.waitForExist({ timeout: 5000 });
	await tab.click();
}

export async function switchTab(label: string): Promise<void> {
	const tab = $(`.sandbox-settings-tab=${label}`);
	await tab.waitForExist({ timeout: 3000 });
	await tab.click();
}

export async function closeSettings(): Promise<void> {
	await browser.keys("Escape");
	await browser.pause(300);
}

// WebDriverIO's `=text` shorthand doesn't work nested inside `:has()`,
// and native CSS `:has()` has no text-match syntax. Use XPath to select
// a .setting-item by the exact text of its .setting-item-name child.
export function settingItemXPath(name: string): string {
	return (
		`//*[contains(concat(' ', normalize-space(@class), ' '), ' setting-item ')]` +
		`[.//*[contains(concat(' ', normalize-space(@class), ' '), ' setting-item-name ')]` +
		`[normalize-space(.)='${name}']]`
	);
}

export function settingInput(name: string) {
	return $(`${settingItemXPath(name)}//input[@type='text']`);
}

export function settingDesc(name: string) {
	return $(
		`${settingItemXPath(name)}//*[contains(concat(' ', normalize-space(@class), ' '), ' setting-item-description ')]`,
	);
}

export function settingWarning(name: string) {
	return $(
		`${settingItemXPath(name)}//*[contains(concat(' ', normalize-space(@class), ' '), ' sandbox-settings-field-warning ')]`,
	);
}

// Validators toggle the `sandbox-input-error` class asynchronously after an
// input event, so a fixed sleep races the toggle. Wait on the observable
// post-condition instead. Re-queries by name each poll so it survives the
// section re-render that bind-address changes trigger (stale handles).
export async function waitForInputError(
	name: string,
	shouldHaveError: boolean,
	timeout = 3000,
): Promise<void> {
	await browser.waitUntil(
		async () => {
			const cls = (await settingInput(name).getAttribute("class")) ?? "";
			return cls.includes("sandbox-input-error") === shouldHaveError;
		},
		{
			timeout,
			timeoutMsg: `'${name}' input never ${shouldHaveError ? "showed" : "cleared"} sandbox-input-error`,
		},
	);
}

// Bind-address warnings render into the description element and appear/clear
// asynchronously. Wait on the description text rather than sleeping.
export async function waitForDescContains(
	name: string,
	substring: string,
	present: boolean,
	timeout = 3000,
): Promise<void> {
	await browser.waitUntil(
		async () => {
			const text = (await settingDesc(name).getText()) ?? "";
			return text.includes(substring) === present;
		},
		{
			timeout,
			timeoutMsg: `'${name}' description never ${present ? "showed" : "cleared"} "${substring}"`,
		},
	);
}
