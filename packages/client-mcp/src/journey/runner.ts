import { dispatchTool, type ToolResult } from '../mcp-tools.js';
import type { ControlClient } from '../control-client.js';
import type { JourneyPlan, JourneyResult, JourneyState } from './types.js';

/**
 * Run all steps in the plan sequentially against the given ControlClient.
 * Each step's result is threaded forward into the next step's buildInput via
 * JourneyState. Halts on the first tool error and returns a partial result.
 */
export async function runJourney(
  plan: JourneyPlan,
  client: ControlClient
): Promise<JourneyResult> {
  const state: JourneyState = {};
  const completedSteps: JourneyResult['steps'] = [];

  for (const step of plan.steps) {
    const toolResult = await dispatchTool(client, step.toolName, step.buildInput(state));

    if (toolResult.isError) {
      return {
        completed: false,
        steps: completedSteps,
        error: { stepId: step.id, message: toolResult.content[0]?.text ?? 'Tool error' },
      };
    }

    const data = extractData(toolResult);
    state[step.id] = data;

    const viewSpec = step.renderPanel(data);
    const panel: ToolResult = {
      content: [{ type: 'text', text: `Journey step: ${step.id}` }],
      structuredContent: { viewSpec },
    };

    completedSteps.push({ stepId: step.id, toolResult, panel });
  }

  return { completed: true, steps: completedSteps };
}

/** Extract the data payload from a successful ToolResult for state threading. */
function extractData(result: ToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
