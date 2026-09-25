// Which AI crawlers a site's robots.txt lets in. Two kinds matter differently: the ones that
// fetch pages to answer a question and cite them (ChatGPT search, Perplexity, Claude search)
// bring visitors, while training crawlers only collect text. Blocking the second kind is a
// reasonable owner choice; blocking the first usually is not, and nobody notices it happened.
// Reads the groups parseRobots() produces; the firewall is not tested, because a crawler's
// user agent can't be faked from here without the firewall treating it as an impostor.
//   node aiready.mjs --selftest

export const AI_BOTS = [
  { ua: "oai-searchbot", name: "OAI-SearchBot", owner: "OpenAI", kind: "answers" },
  { ua: "chatgpt-user", name: "ChatGPT-User", owner: "OpenAI", kind: "answers" },
  { ua: "perplexitybot", name: "PerplexityBot", owner: "Perplexity", kind: "answers" },
  { ua: "perplexity-user", name: "Perplexity-User", owner: "Perplexity", kind: "answers" },
  { ua: "claude-searchbot", name: "Claude-SearchBot", owner: "Anthropic", kind: "answers" },
  { ua: "claude-user", name: "Claude-User", owner: "Anthropic", kind: "answers" },
  { ua: "gptbot", name: "GPTBot", owner: "OpenAI", kind: "training" },
  { ua: "claudebot", name: "ClaudeBot", owner: "Anthropic", kind: "training" },
  { ua: "google-extended", name: "Google-Extended", owner: "Google", kind: "training" },
  { ua: "applebot-extended", name: "Applebot-Extended", owner: "Apple", kind: "training" },
  { ua: "ccbot", name: "CCBot", owner: "Common Crawl", kind: "training" },
  { ua: "meta-externalagent", name: "meta-externalagent", owner: "Meta", kind: "training" },
];

function matches(pattern, path) {
  let re = pattern.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  if (re.endsWith("\\$")) re = re.slice(0, -2) + "$";
  try { return new RegExp("^" + re).test(path); } catch { return path.startsWith(pattern); }
}
// Same precedence as Google: the longest matching rule wins, Allow wins a tie.
function blocks(group, path) {
  const d = (group.disallow || []).filter(p => matches(p, path)).sort((a, b) => b.length - a.length)[0];
  if (!d) return false;
  const a = (group.allow || []).filter(p => matches(p, path)).sort((a, b) => b.length - a.length)[0];
  return !(a && a.length >= d.length);
}

// groups: [{ uas: [lowercase names], disallow: [], allow: [] }] from parseRobots().
// A bot with its own group obeys only that group; otherwise it falls back to "*".
export function aiCrawlerAccess(groups = []) {
  const star = groups.find(g => g.uas.includes("*"));
  return AI_BOTS.map(b => {
    const own = groups.find(g => g.uas.includes(b.ua));
    const g = own || star;
    return { ...b, rule: own ? "own group" : star ? "the * group" : "no rule", allowed: g ? !blocks(g, "/") : true };
  });
}

// ---------- self-test ----------
if (process.argv.includes("--selftest")) {
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}`); } };
  const open = aiCrawlerAccess([{ uas: ["*"], disallow: ["/wp-admin/"], allow: [] }]);
  check("everyone allowed when only /wp-admin/ is blocked", open.every(b => b.allowed));
  const trainingOff = aiCrawlerAccess([{ uas: ["*"], disallow: [], allow: [] }, { uas: ["gptbot", "claudebot"], disallow: ["/"], allow: [] }]);
  check("GPTBot blocked by its own group", trainingOff.find(b => b.name === "GPTBot").allowed === false);
  check("OAI-SearchBot still allowed", trainingOff.find(b => b.name === "OAI-SearchBot").allowed === true);
  const allOff = aiCrawlerAccess([{ uas: ["*"], disallow: ["/"], allow: [] }]);
  check("a blanket Disallow blocks the answer bots too", allOff.filter(b => b.kind === "answers").every(b => !b.allowed));
  const allowBack = aiCrawlerAccess([{ uas: ["*"], disallow: ["/"], allow: [] }, { uas: ["oai-searchbot"], disallow: [], allow: ["/"] }]);
  check("its own group lets a bot back in", allowBack.find(b => b.name === "OAI-SearchBot").allowed === true);
  check("no robots groups means allowed", aiCrawlerAccess([]).every(b => b.allowed));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
