import type { ViewSpec } from '@toon-protocol/views';
import type { ToolResult } from '../mcp-tools.js';

/** Accumulated per-step results keyed by step id. */
export type JourneyState = Record<string, unknown>;

/** One step in a journey: a tool call with a ViewSpec renderer. */
export interface JourneyStep {
  /** Unique identifier for this step within the plan. */
  id: string;
  /** MCP tool name to call (e.g. `toon_status`, `toon_publish_unsigned`). */
  toolName: string;
  /** Build the tool input from accumulated prior-step state. */
  buildInput: (state: JourneyState) => Record<string, unknown>;
  /** Render the step's result data as a ViewSpec panel. */
  renderPanel: (data: unknown, state: JourneyState) => ViewSpec;
}

/** Ordered sequence of steps with plan metadata. */
export interface JourneyPlan {
  id: string;
  title: string;
  steps: JourneyStep[];
}

/** Result for one executed step. */
export interface JourneyStepResult {
  stepId: string;
  /** Raw ToolResult from the tool call. */
  toolResult: ToolResult;
  /** ToolResult carrying the step's ViewSpec panel as structuredContent. */
  panel: ToolResult;
}

/** Final result of a runJourney call. */
export interface JourneyResult {
  /** True when all steps completed without error. */
  completed: boolean;
  /** Results for every step that ran (may be partial on error). */
  steps: JourneyStepResult[];
  /** Present when the run halted due to a tool error. */
  error?: { stepId: string; message: string };
}
