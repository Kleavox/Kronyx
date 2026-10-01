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
import { buildChange, passphraseChange } from "@/lib/devices";
import {
  createPassphrase,
  passphraseProblem,
  passphraseStrength,
} from "@/lib/passphrase";
import {
  answerPrompt,
  cancelPrompt,
  promptSnapshot,
  subscribePrompt,
} from "@/lib/passphrase-prompt";
import { cn } from "@/lib/utils";

import { SHEET } from "./approval-dialog";
import { failure } from "./parts";
import type { Fleet } from "./use-fleet";

const STRENGTH_TONE = {
  "": "",
  Weak: "text-destructive",
  Good: "text-warning",
  Strong: "text-success",
} as const;

export function PassphraseForm({
  fleet,
  open,
  onClose,
  onReview,
}: {
  fleet: Fleet;
  open: boolean;
  onClose: () => void;
  onReview: (text: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {open && <Form fleet={fleet} onClose={onClose} onReview={onReview} />}
    </Dialog>
  );
}

function Form({
  fleet,
  onClose,
  onReview,
}: {
  fleet: Fleet;
  onClose: () => void;
  onReview: (text: string) => void;
}) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [tried, setTried] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = passphraseProblem(first);
  const mismatch = second !== "" && first !== second;
  const strength = passphraseStrength(first);
  const changing = fleet.view.passphrase !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem || first !== second) return;
    setWorking(true);
    setError(null);
    try {
      const { record } = await createPassphrase(first);
      onReview(buildChange(fleet.view, passphraseChange(fleet.view, record)));
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setWorking(false);
    }
  };

  return (
    <DialogContent className={SHEET}>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <DialogHeader>
          <DialogTitle>
            {changing ? "Change passphrase" : "Set passphrase"}
          </DialogTitle>
          <DialogDescription>
            Servers ask for it on devices that cannot prove a fingerprint, so a
            device left unlocked cannot act alone. Two core devices approve it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="passphrase-new">
            {changing ? "New passphrase" : "Passphrase"}
          </Label>
          <Input
            id="passphrase-new"
            type="password"
            autoComplete="new-password"
            value={first}
            aria-invalid={tried && problem !== null}
            aria-describedby="passphrase-hint"
            onChange={(event) => setFirst(event.target.value)}
          />
          <p id="passphrase-hint" className="text-xs text-muted-foreground">
            {tried && problem ? (
              <span className="text-destructive">{problem}</span>
            ) : (
              "At least 12 characters. A few unrelated words work well."
            )}
            {strength && (
              <span className={cn("ml-2 font-medium", STRENGTH_TONE[strength])}>
                Strength: {strength}
              </span>
            )}
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="passphrase-repeat">Repeat passphrase</Label>
          <Input
            id="passphrase-repeat"
            type="password"
            autoComplete="new-password"
            value={second}
            aria-invalid={mismatch}
            aria-describedby="passphrase-repeat-hint"
            onChange={(event) => setSecond(event.target.value)}
          />
          <p
            id="passphrase-repeat-hint"
            className={cn(
              "text-xs",
              mismatch ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {mismatch
              ? "The two passphrases differ."
              : "Do not save it in a password manager on the laptop it protects."}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={working}>
            {working ? "Deriving the key…" : "Review change"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

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
