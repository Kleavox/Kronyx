import { describe, expect, it } from "vitest";

import {
  answerPrompt,
  askPassphrase,
  cancelPrompt,
  promptSnapshot,
} from "./passphrase-prompt";

describe("passphrase prompt", () => {
  it("keeps asking until the check passes, then resolves once", async () => {
    const answer = askPassphrase(async (text) => {
      if (text !== "right one") throw new Error("The passphrase is wrong.");
      return text.length;
    });
    expect(promptSnapshot()).not.toBeNull();
    await expect(answerPrompt("wrong one")).rejects.toThrow(
      "The passphrase is wrong.",
    );
    expect(promptSnapshot()).not.toBeNull();
    await answerPrompt("right one");
    await expect(answer).resolves.toBe(9);
    expect(promptSnapshot()).toBeNull();
  });

  it("rejects when cancelled and sends nothing", async () => {
    let checked = false;
    const answer = askPassphrase(async () => {
      checked = true;
    });
    cancelPrompt();
    await expect(answer).rejects.toThrow("The passphrase was cancelled.");
    expect(checked).toBe(false);
    expect(promptSnapshot()).toBeNull();
  });

  it("cancels an older question when a new one starts", async () => {
    const first = askPassphrase(async () => 1);
    const second = askPassphrase(async () => 2);
    await expect(first).rejects.toThrow("The passphrase was cancelled.");
    await answerPrompt("anything long");
    await expect(second).resolves.toBe(2);
  });
});
