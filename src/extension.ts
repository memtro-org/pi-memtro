import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Memtro for Pi.
 *
 * Two registrations and a status command. The provider puts Memtro behind Pi's own model calls, so every session
 * runs with the organisation's memory, routing and spend controls; the MCP server puts Memtro's memory and every
 * connected system in reach as tools, so Pi can go and look something up on purpose. Either is useful alone and
 * the pair is the usual setup.
 *
 * ## Why the model ids end in `:chat`
 *
 * This is the whole reason a package exists rather than a paragraph of JSON to copy.
 *
 * Memtro answers in one of two modes. `chat` is a single reply. `agent` is a multi-step investigation that plans,
 * calls tools across the connected systems and comes back when it has an answer. Which one a plain model id means
 * is the organisation's default, set in Dashboard -> Routing, and for a chat UI `agent` is often the right default.
 *
 * Pi is not a chat UI. It runs an agent loop of its own -- read a file, run a command, decide what is next -- so a
 * default of `agent` puts Memtro's investigation *inside* Pi's loop and every turn becomes an agent running an
 * agent. That is not an error and nothing reports it. It is simply four minutes where there should have been four
 * seconds, which is exactly how it was first found.
 *
 * So every model this registers is suffixed `:chat`, which pins the mode per request and ignores the default.
 * `auto:agent` is registered too, for when the investigation is the point.
 *
 * ## What is a default here and what is a fact
 *
 * Memtro's `/v1/models` reports model ids and nothing else -- no context window, no output limit, no prices. Pi
 * needs all three. So the windows and limits below are defaults chosen for the models Memtro usually routes to,
 * not facts read from the endpoint, and `MEMTRO_CONTEXT_WINDOW` / `MEMTRO_MAX_TOKENS` are there because a wrong
 * guess is better corrected than argued with. Costs are reported as zero on purpose: Memtro meters spend itself,
 * per user and per team, and a second set of numbers in Pi's footer would only ever be the wrong ones.
 */

/** Where Memtro is. Overridable for a self-hosted install. */
const DEFAULT_HOST = "https://platform.memtro.com";
const KEY_VAR = "MEMTRO_API_KEY";

/**
 * Pi resolves `$NAME` itself when it builds the request, so the key reaches the provider without this extension
 * reading it, and without it being written into a config file. The one place we do read it is model discovery,
 * which has to make the call itself; it goes to the configured host and nowhere else.
 */
const KEY_REF = `$${KEY_VAR}`;

const host = (): string => (process.env.MEMTRO_BASE_URL || DEFAULT_HOST).replace(/\/+$/, "");
const apiBase = (): string => `${host()}/v1`;
const mcpUrl = (): string => `${host()}/api/mcp`;

const positive = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Memtro bills per its own usage page; see the note above on why these are zeros rather than a guess. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * Text only unless asked otherwise. Memtro routes to vision and non-vision models alike and the listing does not
 * say which is which, so claiming image input for all of them would hand pictures to models that cannot read them.
 */
const inputs = (): ("text" | "image")[] => (process.env.MEMTRO_IMAGE_INPUT === "1" ? ["text", "image"] : ["text"]);

/**
 * Pi's seven thinking levels onto the two Memtro reads from `reasoning_effort`: low and medium ask for standard
 * reasoning, high and above ask for deep. Mapped explicitly so the top two levels are not silently dropped.
 */
const THINKING = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } as const;

function chatModel(id: string, name: string) {
  return {
    type: "chat" as const,
    id,
    name,
    reasoning: true,
    thinkingLevelMap: THINKING,
    input: inputs(),
    cost: NO_COST,
    contextWindow: positive("MEMTRO_CONTEXT_WINDOW", 200_000),
    maxTokens: positive("MEMTRO_MAX_TOKENS", 32_000),
  };
}

/** What is offered before (or instead of) discovery: the routing ids, which every organisation has. */
function baseModels() {
  return [
    chatModel("auto:chat", "Memtro auto (one reply)"),
    chatModel("auto:agent", "Memtro auto (multi-step agent)"),
    chatModel("memtro:chat", "Memtro default model (one reply)"),
  ];
}

interface ModelsResponse {
  data?: { id?: string }[];
}

/**
 * The organisation's actual ladder, from `/v1/models`: whichever providers it holds keys for, under its own
 * routing lock if one is set. Each arrives as one `:chat` entry, because a list tripled into chat, default and
 * agent variants is a worse model picker than a short one plus the two agent ids added by hand.
 *
 * Failure is quiet and falls back to the routing ids. A model list that could not be fetched is a reason to offer
 * less, not a reason to stop Pi starting.
 */
async function discover(signal?: AbortSignal) {
  const key = process.env[KEY_VAR];
  if (!key) return baseModels();
  try {
    const res = await fetch(`${apiBase()}/models`, { headers: { Authorization: `Bearer ${key}` }, signal });
    if (!res.ok) return baseModels();
    const body = (await res.json()) as ModelsResponse;
    const ids = (body.data ?? []).map((row) => row.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return baseModels();

    const models = [chatModel("auto:chat", "Memtro auto (one reply)"), chatModel("auto:agent", "Memtro auto (multi-step agent)")];
    const taken = new Set(models.map((m) => m.id));
    for (const id of ids) {
      const chatId = id.endsWith(":chat") || id.endsWith(":agent") ? id : `${id}:chat`;
      if (taken.has(chatId)) continue;
      taken.add(chatId);
      models.push(chatModel(chatId, `${id} (one reply)`));
    }
    return models;
  } catch {
    return baseModels();
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("memtro", {
    name: "Memtro",
    baseUrl: apiBase(),
    api: "openai-completions",
    apiKey: KEY_REF,
    models: baseModels(),
    refreshModels: async () => discover(),
  });

  // The tools half. Off with MEMTRO_PI_TOOLS=0 for anybody who wants Memtro as the model and nothing else.
  // `${NAME}` is Pi's own interpolation in a header value, so again the key is not written down here.
  if (process.env.MEMTRO_PI_TOOLS !== "0") {
    pi.registerMcpServer("memtro", {
      url: mcpUrl(),
      headers: { Authorization: `Bearer \${${KEY_VAR}}` },
      description: "Company memory, and the systems this organisation has connected: search what is known, remember a fact, and read the CRM, the tickets, the ledger and the rest as the signed-in user.",
    });
  }

  /**
   * Somewhere to look when it is not working, which for this integration is nearly always one of three things:
   * no key, a key the server will not take, or a host that is not the one you meant.
   */
  pi.registerCommand("memtro", {
    description: "Check the Memtro connection: key, endpoint and the models it offers",
    handler: async (_args, ctx) => {
      const key = process.env[KEY_VAR];
      if (!key) {
        ctx.ui.notify(`No ${KEY_VAR} in the environment. Create a key on ${host()}/dashboard/profile/keys and export it.`, "warning");
        return;
      }
      try {
        const res = await fetch(`${apiBase()}/models`, { headers: { Authorization: `Bearer ${key}` } });
        if (!res.ok) {
          ctx.ui.notify(`${apiBase()}/models answered ${res.status}. A 401 means the key is wrong or withdrawn.`, "error");
          return;
        }
        const body = (await res.json()) as ModelsResponse;
        const count = (body.data ?? []).length;
        const tools = process.env.MEMTRO_PI_TOOLS === "0" ? "tools off" : `tools at ${mcpUrl()}`;
        ctx.ui.notify(`Memtro at ${host()}: ${count} model${count === 1 ? "" : "s"}, ${tools}. Use /model to pick one -- prefer an id ending :chat.`, "info");
      } catch (err) {
        ctx.ui.notify(`Could not reach ${apiBase()}: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
