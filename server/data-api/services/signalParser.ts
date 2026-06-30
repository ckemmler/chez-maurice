/**
 * Signal text parser — uses Claude to parse free-text signal entries
 * into structured signals with details, timestamp, and metadata.
 */

import { getHouseholdConfig } from "../../src/services/claude";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Haiku for lightweight parsing, Sonnet for nutritional estimation
const MODEL_HAIKU = "claude-haiku-4-5-20251001";
const MODEL_SONNET = "claude-sonnet-4-5-20250929";

interface CategorySchema {
  description: string;
  metadataFields: string;
  examples: string;
  model?: string;
}

const CATEGORY_SCHEMAS: Record<string, CategorySchema> = {
  eating: {
    description: "Meal or food intake",
    model: MODEL_SONNET,
    metadataFields: [
      '"meal" (breakfast/lunch/dinner/snack — infer from time if not stated)',
      '"items" (array of food items)',
      '"protein_g" (integer — estimated total protein in grams)',
      '"calories" (integer — estimated total calories)',
    ].join(", "),
    examples: `"Lunch at home, lentil soup" → details: "Lunch: lentil soup", metadata: {meal: "lunch", items: ["lentil soup"], protein_g: 18, calories: 350}
"eggs and toast 10 minutes ago" → details: "Eggs and toast", metadata: {meal: infer from time, items: ["eggs", "toast"], protein_g: 20, calories: 320}, timestamp: 10 minutes before now
"4 chocolate biscuits" → details: "4 chocolate biscuits", metadata: {meal: "snack", items: ["chocolate biscuits"], protein_g: 4, calories: 280}
"skipped breakfast" → details: "Skipped breakfast", metadata: {meal: "breakfast", protein_g: 0, calories: 0}`,
  },
  sports: {
    description: "Physical activity",
    metadataFields:
      '"activity" (required — e.g. running, yoga, cycling), "duration" (required — e.g. "30min", "1h"), optional: "distance", "intensity"',
    examples: `"ran 5k in 28 minutes" → details: "5km run in 28min", metadata: {activity: "running", duration: "28min", distance: "5km"}
"20 min bellicon this morning" → details: "20min bellicon", metadata: {activity: "bellicon", duration: "20min"}, timestamp: this morning ~8:00
"yoga 1h" → details: "1h yoga session", metadata: {activity: "yoga", duration: "1h"}`,
  },
  breathing: {
    description: "Breathwork or pranayama practice",
    metadataFields:
      '"duration" (required — e.g. "15min"), optional: "technique" (e.g. Wim Hof, box breathing, CO2 table)',
    examples: `"15 min wim hof" → details: "15min Wim Hof", metadata: {duration: "15min", technique: "Wim Hof"}
"box breathing 10 minutes before lunch" → details: "10min box breathing", metadata: {duration: "10min", technique: "box breathing"}, timestamp: ~11:50
"CO2 table" → details: "CO2 table session", metadata: {technique: "CO2 table"}`,
  },
  meditation: {
    description: "Meditation or mindfulness practice",
    metadataFields:
      '"duration" (required — e.g. "20min"), optional: "technique" (e.g. vipassana, metta, body scan, zazen)',
    examples: `"20 min vipassana" → details: "20min vipassana meditation", metadata: {duration: "20min", technique: "vipassana"}
"body scan before bed" → details: "Body scan meditation", metadata: {technique: "body scan"}, timestamp: infer evening
"metta 15 minutes" → details: "15min metta meditation", metadata: {duration: "15min", technique: "metta"}`,
  },
};

function buildPrompt(text: string, category: string, now: string): string {
  const schema = CATEGORY_SCHEMAS[category];
  if (!schema) {
    return `Parse this free-text signal entry into a structured signal.
Category: ${category}
Current time: ${now}
Input: "${text}"

Return JSON: {"details": "...", "timestamp": "ISO8601 or null", "metadata": {}, "tags": []}
- "details": clean, descriptive text of the event
- "timestamp": if the user mentions a relative or absolute time, resolve it to ISO 8601 using current time. null if not mentioned (will default to now).
- "metadata": any structured fields you can extract
- "tags": relevant tags (not the category itself)

Return ONLY valid JSON, no markdown.`;
  }

  const nutritionNote =
    category === "eating"
      ? `\n- "protein_g" and "calories": provide your best integer estimates based on typical portion sizes. Be reasonable — a rough estimate is better than none. If the meal is skipped or has no food, use 0.`
      : "";

  return `Parse this free-text signal entry into a structured signal.

Category: ${category} — ${schema.description}
Metadata fields: ${schema.metadataFields}
Current time: ${now}

Examples:
${schema.examples}

Input: "${text}"

Return JSON: {"details": "...", "timestamp": "ISO8601 or null", "metadata": {}, "tags": []}

Rules:
- "details": clean, descriptive summary. Capitalize properly. Include quantities and specifics.
- "timestamp": if the user mentions a relative time ("10 minutes ago", "this morning", "yesterday evening"), resolve it to an ISO 8601 timestamp using the current time. If no time is mentioned, return null (will default to now).
- "metadata": extract structured fields as described above. Use the field names exactly.${nutritionNote}
- "tags": relevant tags for filtering. Do NOT include the category name.
- Keep it concise. Do not invent information not present in the input.

Return ONLY valid JSON, no markdown fences.`;
}

export interface ParsedSignal {
  category: string;
  details: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export async function parseSignalText(
  text: string,
  category: string,
): Promise<ParsedSignal> {
  // Use the household's stored key (same source as Maurice's chat), falling
  // back to the env var so the parser still works if run standalone.
  const apiKey = getHouseholdConfig().apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("No Anthropic API key configured (household api_key or ANTHROPIC_API_KEY)");
  }

  const now = new Date().toISOString();
  const prompt = buildPrompt(text, category, now);
  const model = CATEGORY_SCHEMAS[category]?.model ?? MODEL_HAIKU;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${err}`);
  }

  const result = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  const raw = result.content?.[0]?.text?.trim();
  if (!raw) {
    throw new Error("Empty response from LLM");
  }

  // Strip markdown fences if present despite instructions
  const jsonStr = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");

  let parsed: {
    details?: string;
    timestamp?: string | null;
    metadata?: Record<string, unknown>;
    tags?: string[];
  };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse LLM response as JSON: ${jsonStr}`);
  }

  return {
    category,
    details: parsed.details || text,
    timestamp: parsed.timestamp || undefined,
    metadata: parsed.metadata || undefined,
    tags: parsed.tags || undefined,
  };
}
