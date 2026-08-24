import { browser, expect, $, $$ } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import {
	openPluginSettings,
	switchTab,
	closeSettings,
	settingInput,
	settingDesc,
	settingWarning,
	waitForInputError,
	waitForDescContains,
} from "../settings-helpers";

describe("Settings: validation and warnings", function () {
	before(async function () {
		await obsidianPage.resetVault();
	});

	describe("General tab", function () {
		it("shows restart labels on restart-needing settings", async function () {
			await openPluginSettings();
			await switchTab("General");

			const descriptions = $$(".setting-item-description");
			const texts: string[] = [];
			for (const d of await descriptions.getElements()) {
				texts.push(await d.getText());
			}
			const restartTexts = texts.filter((t) => t.includes("Requires container restart"));
			expect(restartTexts.length).toBeGreaterThanOrEqual(3);
		});

		it("auto-start and auto-stop do NOT have restart labels", async function () {
			const descriptions = $$(".setting-item-description");
			const texts: string[] = [];
			for (const d of await descriptions.getElements()) {
				texts.push(await d.getText());
			}

			const autoStartDesc = texts.find((t) => t.includes("Start the container when"));
			expect(autoStartDesc).toBeDefined();
			expect(autoStartDesc).not.toContain("Requires container restart");
		});

		// QA plan 1.6 (UI half): the write-dir field rejects paths that escape the
		// vault (leading "/" or ".." segments) by flagging sandbox-input-error,
		// and clears the flag for a valid relative folder. Mirrors the numeric
		// validation pattern below. The stored-escape half (seed bad data.json,
		// reload, assert error state) lives in persistence-reload.e2e.ts.
		it("write directory rejects escaping paths", async function () {
			const writeDirInput = settingInput("Vault write directory");
			await writeDirInput.waitForExist({ timeout: 3000 });

			await writeDirInput.setValue("../escape");
			await waitForInputError("Vault write directory", true);

			await writeDirInput.setValue("/root/forbidden");
			await waitForInputError("Vault write directory", true);

			await writeDirInput.setValue("agent-workspace");
			await waitForInputError("Vault write directory", false);
		});
	});

	describe("Terminal tab", function () {
		it("port field shows restart label", async function () {
			await openPluginSettings();
			await switchTab("Terminal");

			const portDesc = $(".setting-item-description*=host port mapped");
			await expect(portDesc).toExist();
			expect(await portDesc.getText()).toContain("Requires container restart");
		});

		it("font size validates range 8-32", async function () {
			const fontSizeInput = settingInput("Font size");
			await fontSizeInput.waitForExist({ timeout: 3000 });

			await fontSizeInput.setValue("50");
			await waitForInputError("Font size", true);

			await fontSizeInput.setValue("14");
			await waitForInputError("Font size", false);
		});

		it("scrollback validates range 100-100000", async function () {
			const scrollInput = settingInput("Scrollback");
			await scrollInput.waitForExist({ timeout: 3000 });

			await scrollInput.setValue("50");
			await waitForInputError("Scrollback", true);

			await scrollInput.setValue("10000");
			await waitForInputError("Scrollback", false);
		});

		it("bind address 0.0.0.0 shows security warning", async function () {
			const bindInput = settingInput("Bind address");
			await bindInput.waitForExist({ timeout: 3000 });
			await bindInput.setValue("0.0.0.0");

			// Settings re-renders on bind address change, so the element is stale.
			// waitForDescContains re-queries the description each poll.
			await waitForDescContains("Bind address", "exposes ttyd", true);

			await settingInput("Bind address").setValue("127.0.0.1");
			await waitForDescContains("Bind address", "exposes ttyd", false);
		});

		// QA plan 1.4 (visual half, 🎨): the warning isn't just text — it renders
		// an amber (#ffc107) 3px solid left-border. A computed-style assertion
		// closes the "is it amber, is it a left-border" gap deterministically,
		// without pixel-baseline visual-regression infrastructure.
		it("bind address warning renders the amber left-border", async function () {
			await settingInput("Bind address").setValue("0.0.0.0");
			await waitForDescContains("Bind address", "exposes ttyd", true);

			const warning = settingWarning("Bind address");
			await warning.waitForExist({ timeout: 3000 });

			const color = await warning.getCSSProperty("border-left-color");
			// #ffc107 → rgb(255, 193, 7); wdio normalises to an rgb(a) string.
			expect(color.value?.replace(/\s/g, "")).toContain("255,193,7");

			const width = await warning.getCSSProperty("border-left-width");
			expect(width.parsed?.value).toBe(3);

			const style = await warning.getCSSProperty("border-left-style");
			expect(style.value).toBe("solid");

			await settingInput("Bind address").setValue("127.0.0.1");
			await waitForDescContains("Bind address", "exposes ttyd", false);
		});

		it("theme and font have no restart labels", async function () {
			const themeDesc = settingDesc("Terminal theme");
			await expect(themeDesc).toExist();
			expect(await themeDesc.getText()).not.toContain("Requires container restart");
		});
	});

	describe("MCP tab", function () {
		it("default tier values: vault writes scoped, escalations off", async function () {
			await openPluginSettings();
			await switchTab("MCP");

			const values = await browser.executeObsidian(({ app }) => {
				const plugins = (
					app as unknown as {
						plugins: {
							plugins: Record<
								string,
								{
									settings: {
										mcpVaultWrites: "scoped" | "reviewed" | "full";
										mcpTierNavigate: boolean;
										mcpTierManage: boolean;
									};
								}
							>;
						};
					}
				).plugins.plugins;
				const s = plugins["agent-sandbox"]?.settings;
				return s
					? {
							vaultWrites: s.mcpVaultWrites,
							navigate: s.mcpTierNavigate,
							manage: s.mcpTierManage,
						}
					: null;
			});

			expect(values).not.toBeNull();
			expect(values!.vaultWrites).toBe("scoped");
			expect(values!.navigate).toBe(false);
			expect(values!.manage).toBe(false);
		});

		it("token regenerate produces a new value", async function () {
			const readToken = () =>
				browser.executeObsidian(({ app }) => {
					const plugins = (
						app as unknown as {
							plugins: {
								plugins: Record<string, { settings: { mcpToken: string } }>;
							};
						}
					).plugins.plugins;
					return plugins["agent-sandbox"]?.settings?.mcpToken ?? "";
				});

			const tokenBefore = await readToken();

			const regenButton = $("button=Regenerate");
			await regenButton.waitForExist({ timeout: 3000 });
			await regenButton.click();

			let tokenAfter = "";
			await browser.waitUntil(
				async () => {
					tokenAfter = await readToken();
					return tokenAfter !== "" && tokenAfter !== tokenBefore;
				},
				{ timeout: 3000, timeoutMsg: "MCP token never changed after Regenerate" },
			);

			expect(tokenAfter).toMatch(/^[a-f0-9]{32}$/);
		});

		it("port validation rejects invalid values", async function () {
			const portInput = settingInput("MCP port");
			await portInput.waitForExist({ timeout: 3000 });

			await portInput.setValue("abc");
			await waitForInputError("MCP port", true);

			await portInput.setValue("28080");
			await waitForInputError("MCP port", false);
		});

		// QA plan 1.4 (MCP half): the MCP bind-address field shows a distinct
		// network-exposure warning at 0.0.0.0 and hides it on revert. Mirrors the
		// ttyd Bind address test above; the warning div lives inside descEl so
		// getText() includes it only while visible.
		it("bind address 0.0.0.0 shows security warning", async function () {
			const bindInput = settingInput("MCP bind address");
			await bindInput.waitForExist({ timeout: 3000 });
			await bindInput.setValue("0.0.0.0");
			await waitForDescContains("MCP bind address", "exposes MCP", true);

			await settingInput("MCP bind address").setValue("127.0.0.1");
			await waitForDescContains("MCP bind address", "exposes MCP", false);
		});
	});

	after(async function () {
		await closeSettings();
	});
});

// Note on tests that are NOT here:
// - "settings persist across reload" and "plugin survives disable/enable":
//   the current CI Obsidian installs the plugin on disk, so these now live in
//   harness-probe.e2e.ts (reloadObsidian() persistence + disable/enable
//   no-debris) rather than being blocked by the old out-of-tree harness.
//   A genuine OS-level quit/relaunch stays manual (Obsidian's own
//   saveData/loadData responsibility).
