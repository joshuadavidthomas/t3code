import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

/** A sandbox account on the selected environment, offered as a new workspace. */
export interface SandboxOption {
  ownerEnvironmentId: EnvironmentId;
  configurationId: string;
  label: string;
  providerLabel: string;
}

export interface SandboxTarget {
  ownerEnvironmentId: EnvironmentId;
  configurationId: string;
}

export const sandboxSelectValue = (option: SandboxTarget) =>
  `sandbox:${JSON.stringify([option.ownerEnvironmentId, option.configurationId])}`;

/** Parallels "New worktree"; names the account only when there are several to tell apart. */
export const resolveSandboxWorkspaceLabel = (
  option: SandboxOption,
  options: readonly SandboxOption[],
) => (options.length > 1 ? `New sandbox · ${option.label}` : "New sandbox");
const EMPTY_SANDBOX_OPTIONS: readonly SandboxOption[] = [];

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
  sandboxOptions?: readonly SandboxOption[];
  sandboxTarget?: SandboxTarget | null | undefined;
  onSandboxChange?: ((target: SandboxTarget) => void) | undefined;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch = null,
  onUsePreviousWorktree,
  sandboxOptions = EMPTY_SANDBOX_OPTIONS,
  sandboxTarget = null,
  onSandboxChange,
}: BranchToolbarEnvModeSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const envModeItems = useMemo(
    () => [
      { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
      ...(showPreviousWorktree && previousWorktreeLabel
        ? [{ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel }]
        : []),
      ...sandboxOptions.map((option) => ({
        value: sandboxSelectValue(option),
        label: resolveSandboxWorkspaceLabel(option, sandboxOptions),
      })),
    ],
    [activeWorktreePath, previousWorktreeLabel, sandboxOptions, showPreviousWorktree],
  );
  const activeSandbox = sandboxTarget
    ? (sandboxOptions.find(
        (option) => sandboxSelectValue(option) === sandboxSelectValue(sandboxTarget),
      ) ?? null)
    : null;
  const sandboxLabel = activeSandbox?.label ?? "Unavailable";

  if (envLocked || forceNewWorktree) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span />}
          className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
          data-composer-context-control
        >
          {activeWorktreePath ? (
            <FolderGitIcon className="size-3 shrink-0" />
          ) : effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3 shrink-0" />
          ) : (
            <FolderIcon className="size-3 shrink-0" />
          )}
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              {resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          {forceNewWorktree
            ? "Each model starts in its own worktree."
            : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={sandboxTarget ? sandboxSelectValue(sandboxTarget) : effectiveEnvMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
          onUsePreviousWorktree?.();
          return;
        }
        const sandbox = sandboxOptions.find((option) => sandboxSelectValue(option) === value);
        if (sandbox) {
          onSandboxChange?.(sandbox);
          return;
        }
        onEnvModeChange(value as EnvMode);
      }}
      items={envModeItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              variant="ghost"
              size="xs"
              className="min-w-0 shrink"
              aria-label="Workspace"
              data-composer-shortcut="composer.workspace"
              data-composer-context-control
            />
          }
        >
          {sandboxTarget ? (
            <CloudIcon className="size-3" aria-hidden="true" />
          ) : effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3" />
          ) : activeWorktreePath ? (
            <FolderGitIcon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
          )}
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              {sandboxTarget && !activeSandbox ? sandboxLabel : <SelectValue />}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          {activeSandbox
            ? `${activeSandbox.label} · ${activeSandbox.providerLabel}`
            : sandboxTarget
              ? sandboxLabel
              : effectiveEnvMode === "worktree"
                ? resolveEnvModeLabel("worktree")
                : resolveCurrentWorkspaceLabel(activeWorktreePath)}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        className={showPreviousWorktree ? "w-[min(21rem,calc(100vw-2rem))]" : undefined}
        {...composerFloatingLayerProps}
      >
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          <SelectItem value="local">
            <span className="inline-flex items-center gap-1.5">
              {activeWorktreePath ? (
                <FolderGitIcon className="size-3" />
              ) : (
                <FolderIcon className="size-3" />
              )}
              {resolveCurrentWorkspaceLabel(activeWorktreePath)}
            </span>
          </SelectItem>
          <SelectItem value="worktree">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveEnvModeLabel("worktree")}
            </span>
          </SelectItem>
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
            </SelectItem>
          ) : null}
          {sandboxOptions.map((option) => (
            <SelectItem key={sandboxSelectValue(option)} value={sandboxSelectValue(option)}>
              <span className="flex w-full items-center justify-between gap-5">
                <span className="inline-flex items-center gap-1.5">
                  <CloudIcon className="size-3" aria-hidden="true" />
                  New sandbox
                </span>
                <span className="text-xs text-muted-foreground">{option.label}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
