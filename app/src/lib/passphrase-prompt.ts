import type { PassphraseKey } from "../types";
import { signProof, unlockPassphrase } from "./passphrase";
import type { Prove } from "./passkeys";

interface Question {
  id: number;
  check: (text: string) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

let current: Question | null = null;
let asked = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribePrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function promptSnapshot(): Question | null {
  return current;
}

export function cancelPrompt(): void {
  const question = current;
  current = null;
  question?.reject(new Error("The passphrase was cancelled."));
  emit();
}

export function askPassphrase<T>(
  check: (text: string) => Promise<T>,
): Promise<T> {
  if (current) cancelPrompt();
  return new Promise<T>((resolve, reject) => {
    asked += 1;
    current = {
      id: asked,
      check,
      resolve: (value) => resolve(value as T),
      reject,
    };
    emit();
  });
}

export async function answerPrompt(text: string): Promise<void> {
  const question = current;
  if (!question) return;
  const value = await question.check(text);
  if (current !== question) return;
  current = null;
  question.resolve(value);
  emit();
}

export function proverFor(record: PassphraseKey | null): Prove | null {
  if (!record) return null;
  return (purpose, data) =>
    askPassphrase(async (text) =>
      signProof(await unlockPassphrase(text, record), purpose, data),
    );
}
