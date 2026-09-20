p = 'src/services/claude.ts'
s = open(p, encoding='utf-8').read()

# One counter per turn, shared by that turn's rounds, in each of the three loops.
pairs = [
    ("{ conversationId, provider: \"ollama\", round, memberId }",
     "{ conversationId, provider: \"ollama\", round, memberId, factsProposed }"),
    ("{ conversationId, provider, round, memberId }",
     "{ conversationId, provider, round, memberId, factsProposed }"),
    ("{ conversationId, provider: \"anthropic\", round, memberId }",
     "{ conversationId, provider: \"anthropic\", round, memberId, factsProposed }"),
]
for old, new in pairs:
    assert old in s, old
    s = s.replace(old, new, 1)

# Declare it where each loop sets up its per-turn state. All three start with
# a `const convo` or `const calls` line; anchor on the usage log instead, which
# every loop has exactly once.
anchors = [
    ("async function* runOllamaAgentic(", "  const usage = newUsage(\"ollama\", model);"),
    ("async function* runOpenAIAgentic(", "  const usage = newUsage(provider, model);"),
]
for fn, anchor in anchors:
    i = s.index(fn)
    j = s.index(anchor, i)
    s = s[:j] + "  // Counted for the whole turn, across its rounds (services/lifeFacts.ts).\n  const factsProposed = { n: 0 };\n" + s[j:]

print("two loops done")
open(p, 'w', encoding='utf-8').write(s)
