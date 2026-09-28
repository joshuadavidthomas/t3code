import {
  SANDBOX_DRIVER_CREDENTIALS,
  withSandboxCredential,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { CopyIcon } from "lucide-react";
import { Fragment, useId, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Per-driver copy for connecting an agent that cannot sign in interactively. */
const CREDENTIAL_SETUP: Readonly<
  Record<
    string,
    {
      readonly action: string;
      readonly dialogTitle: string;
      readonly dialogDescription: string;
      readonly run: string;
      readonly command: string;
      readonly authorize: string;
      readonly paste: string;
      readonly placeholder: string;
    }
  >
> = {
  claudeAgent: {
    action: "Connect subscription",
    dialogTitle: "Connect Claude subscription",
    dialogDescription: "Use your Claude Pro or Max subscription in this account's sandboxes.",
    run: "On a trusted machine with Claude Code installed, run:",
    command: "claude setup-token",
    authorize: "Complete the browser authorization with your Claude Pro or Max account.",
    paste: "Paste the token Claude Code prints.",
    placeholder: "sk-ant-oat…",
  },
};

/**
 * Sits beside Add variable: a guided way to fill the driver's credential
 * variable, since sandboxes have no interactive login. Variables stays the
 * only place the credential lives.
 */
export function SandboxCredentialAction({
  instance,
  onUpdate,
}: {
  instance: ProviderInstanceConfig;
  onUpdate: (next: ProviderInstanceConfig) => void;
}) {
  const inputId = useId();
  const formId = useId();
  const [connecting, setConnecting] = useState(false);
  const [token, setToken] = useState("");
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => toastManager.add({ type: "success", title: "Setup command copied" }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy setup command",
          description: error.message,
        }),
      ),
  });
  const setup = CREDENTIAL_SETUP[instance.driver];
  const variables = SANDBOX_DRIVER_CREDENTIALS[instance.driver]?.variables;
  if (!setup || !variables) return null;
  const alternatives = variables.slice(1);
  const close = () => {
    setConnecting(false);
    setToken("");
  };
  const submit = () => {
    if (!token.trim()) return;
    onUpdate(withSandboxCredential(instance, token));
    close();
  };

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setConnecting(true)}>
        {setup.action}
      </Button>
      <Dialog
        open={connecting}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{setup.dialogTitle}</DialogTitle>
            <DialogDescription>{setup.dialogDescription}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              id={formId}
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <ol role="list" className="space-y-4 text-sm">
                <SetupStep number={1}>
                  <p>{setup.run}</p>
                  <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                      {setup.command}
                    </code>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost-muted"
                            className="shrink-0"
                            onClick={() => copyToClipboard(setup.command, undefined)}
                            aria-label="Copy setup command"
                          >
                            <CopyIcon className="size-3" />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Copy command</TooltipPopup>
                    </Tooltip>
                  </div>
                </SetupStep>
                <SetupStep number={2}>
                  <p>{setup.authorize}</p>
                </SetupStep>
                <SetupStep number={3}>
                  <label htmlFor={inputId} className="block">
                    {setup.paste}
                  </label>
                  <Input
                    id={inputId}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={setup.placeholder}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    autoFocus
                  />
                </SetupStep>
              </ol>
              {alternatives.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  To use an API key instead, set{" "}
                  {alternatives.map((name, index) => (
                    <Fragment key={name}>
                      {index > 0 ? " or " : null}
                      <code>{name}</code>
                    </Fragment>
                  ))}{" "}
                  under Variables.
                </p>
              ) : null}
            </form>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={formId} disabled={!token.trim()}>
              Connect
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** Numbered like the wizard's upcoming steps, so the sequence reads the same across dialogs. */
function SetupStep({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-full bg-card text-sm font-medium text-muted-foreground ring-1 ring-black/10 dark:bg-white/5 dark:ring-white/10"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </li>
  );
}
