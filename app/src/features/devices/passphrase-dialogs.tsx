import { useState, useSyncExternalStore, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  answerPrompt,
  cancelPrompt,
  promptSnapshot,
  subscribePrompt,
} from "@/lib/passphrase-prompt";
import { cn } from "@/lib/utils";

import { failure } from "./parts";

export function PassphrasePrompt() {
  const question = useSyncExternalStore(
    subscribePrompt,
    promptSnapshot,
    promptSnapshot,
  );
  return (
    <Dialog
      open={question !== null}
      onOpenChange={(next) => !next && cancelPrompt()}
    >
      {question && <Prompt key={question.id} />}
    </Dialog>
  );
}

function Prompt() {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [working, setWorking] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (text === "") return;
    setWorking(true);
    setError(null);
    try {
      await answerPrompt(text);
    } catch (caught) {
      setError(failure(caught));
      setAttempt((value) => value + 1);
    } finally {
      setWorking(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-sm">
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <DialogHeader>
          <DialogTitle>Enter your passphrase</DialogTitle>
          <DialogDescription>
            This passkey did not prove a fingerprint, so your servers ask for
            the passphrase as well.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="passphrase-ask">Passphrase</Label>
          <Input
            key={attempt}
            id="passphrase-ask"
            type="password"
            autoComplete="off"
            autoFocus
            value={text}
            aria-invalid={error !== null}
            aria-describedby={error ? "passphrase-ask-error" : undefined}
            className={cn(attempt > 0 && "motion-safe:animate-[shake_300ms]")}
            onChange={(event) => setText(event.target.value)}
          />
          {error && (
            <p
              id="passphrase-ask-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {error} Nothing was sent.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={cancelPrompt}>
            Cancel
          </Button>
          <Button type="submit" disabled={working || text === ""}>
            {working ? "Checking…" : "Continue"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
