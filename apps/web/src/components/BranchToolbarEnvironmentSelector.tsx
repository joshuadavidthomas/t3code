import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, ScaleIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useComposerMenuProps } from "./chat/composerEventScope";
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

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  // Absent when there is only one environment to show: the indicator still
  // renders (as a static label) so remote projects are always identifiable.
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  sandboxOptions?: readonly SandboxOption[];
  sandboxTarget?: SandboxTarget | null | undefined;
  onSandboxChange?: ((target: SandboxTarget) => void) | undefined;
}

const sandboxValue = (option: SandboxTarget) =>
  `sandbox:${JSON.stringify([option.ownerEnvironmentId, option.configurationId])}`;
const EMPTY_SANDBOX_OPTIONS: readonly SandboxOption[] = [];

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  sandboxOptions = EMPTY_SANDBOX_OPTIONS,
  sandboxTarget,
  onSandboxChange,
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);
  const activeSandbox = useMemo(
    () =>
      sandboxTarget
        ? (sandboxOptions.find(
            (option) =>
              option.ownerEnvironmentId === sandboxTarget.ownerEnvironmentId &&
              option.configurationId === sandboxTarget.configurationId,
          ) ?? null)
        : null,
    [sandboxOptions, sandboxTarget],
  );

  const environmentItems = useMemo(
    () => [
      ...(onAutoEnvironment
        ? [{ value: "auto", label: autoEnvironmentLabel ?? "Auto balance" }]
        : []),
      ...availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
      ...sandboxOptions.map((option) => ({
        value: sandboxValue(option),
        label: option.label,
      })),
    ],
    [availableEnvironments, autoEnvironmentLabel, onAutoEnvironment, sandboxOptions],
  );

  const selectedValue = sandboxTarget
    ? sandboxValue(sandboxTarget)
    : autoEnvironmentLabel
      ? "auto"
      : environmentId;
  const selectedLabel = sandboxTarget
    ? (activeSandbox?.label ?? "Unavailable")
    : (autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on");
  const tooltipLabel = activeSandbox
    ? `${activeSandbox.label} · ${activeSandbox.providerLabel}`
    : selectedLabel;

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  if (envLocked || (onEnvironmentChange === undefined && onSandboxChange === undefined)) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span />}
          className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
          data-composer-context-control
        >
          {sandboxTarget ? (
            <CloudIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className="size-3 shrink-0"
            />
          )}
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              {selectedLabel}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>{tooltipLabel}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={selectedValue}
      onValueChange={(value) => {
        if (value === "auto") return onAutoEnvironment?.();
        const sandbox = sandboxOptions.find((option) => sandboxValue(option) === value);
        if (sandbox) return onSandboxChange?.(sandbox);
        onEnvironmentChange?.(value as EnvironmentId);
      }}
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              variant="ghost"
              size="xs"
              className="min-w-0 max-w-full"
              aria-label="Run on"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {sandboxTarget ? (
            <CloudIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : autoEnvironmentLabel ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className="size-3 shrink-0"
            />
          )}
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              {sandboxTarget && !activeSandbox ? selectedLabel : <SelectValue />}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>{tooltipLabel}</TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {onAutoEnvironment && (
            <SelectItem
              value="auto"
              onClick={() => {
                if (autoEnvironmentLabel) onAutoEnvironment?.();
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <ScaleIcon className="size-3" aria-hidden="true" />
                {autoEnvironmentLabel ?? "Auto balance"}
              </span>
            </SelectItem>
          )}
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                {env.label}
              </span>
            </SelectItem>
          ))}
          {sandboxOptions.map((option) => (
            <SelectItem key={sandboxValue(option)} value={sandboxValue(option)}>
              <span className="flex w-full items-center justify-between gap-5">
                <span className="inline-flex items-center gap-1.5">
                  <CloudIcon className="size-3" aria-hidden="true" />
                  {option.label}
                </span>
                <span className="text-xs text-muted-foreground">{option.providerLabel}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
