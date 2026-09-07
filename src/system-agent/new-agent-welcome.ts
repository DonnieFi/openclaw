import { AGENT_TEMPLATE_ROLES } from "../agents/agent-template-schema.js";
import { loadAgentTemplate } from "../agents/agent-templates.js";
import type { SystemAgentChatEngine } from "./chat-engine.js";

export async function buildNewAgentWelcome(params: {
  engine: Pick<SystemAgentChatEngine, "noteAssistantMessage">;
}): Promise<string> {
  const [coordinator, ...specialists] = await Promise.all([
    loadAgentTemplate(AGENT_TEMPLATE_ROLES[0]),
    ...AGENT_TEMPLATE_ROLES.slice(1).map(loadAgentTemplate),
  ]);
  const welcome = [
    "Let's create an agent. Pick a role or describe your own; I'll propose creation for your approval.",
    ...[coordinator, ...specialists].map(
      ({ manifest }, index) => `${index + 1}. ${manifest.title} — ${manifest.summary}`,
    ),
    `5. A small team (${coordinator.manifest.title.toLowerCase()} plus the three specialists).`,
    "6. Something custom (tell me the name and the kind of work).",
  ].join("\n");
  params.engine.noteAssistantMessage(welcome);
  return welcome;
}
