import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Memtro for Pi.
 *
 * One provider and one MCP server per Memtro account, and a status command. The provider puts Memtro behind Pi's
 * own model calls, so every session runs with that organisation's memory, routing and spend controls; the MCP
 * server puts its memory and connected systems in reach as tools. Either is useful alone and the pair is the
 * usual setup.
 *
 * ## Why the model ids end in `:chat`
 *
 * This is the whole reason a package exists rather than a paragraph of JSON to copy.
 *
 * Memtro answers in one of two modes. `chat` is a single reply. `agent` is a multi-step investigation that plans,
 * calls tools across the connected systems and comes back when it has an answer. Which one a plain model id means
 * is the organisation's default, and for a chat UI `agent` is often the right default.
 *
 * Pi is not a chat UI. It runs an agent loop of its own, so a default of `agent` puts Memtro's investigation
 * *inside* Pi's loop and every turn becomes an agent running an agent. That is not an error and nothing reports
 * it. It is four minutes where there should have been four seconds, and a session that grows by thousands of
 * tokens of progress narration every turn until Pi compacts it, and compacts it again.
 *
 * So every model this registers is suffixed `:chat`, and `auto:agent` is registered beside it for when the
 * investigation is the point. Memtro now also defaults a tool-carrying caller to chat mode server-side, which
 * covers the same ground for clients that cannot say; this keeps saying it, because being explicit costs nothing.
 *
 * ## More than one account
 *
 * A consultant with two clients, a company with a sandbox beside production, a self-hosted Memtro next to the
 * hosted one: the shape is the same each time, and the thing that must not be shared between them is the key.
 *
 * Accounts are declared in `<agent-dir>/memtro.json` and each names an *environment variable* rather than
 * carrying a key, so nothing secret is written to a file that ends up in a backup or a dotfiles repository. Pi
 * resolves `$NAME` itself when it builds a request, so the key reaches the provider without this extension ever
 * holding it; the one place it is read here is model discovery, which has to make the call itself and sends it to
 * the host that account configured and nowhere else.
 *
 *   {
 *     "accounts": [
 *       { "id": "acme",   "name": "Memtro (Acme)",   "keyEnv": "MEMTRO_API_KEY" },
 *       { "id": "client", "name": "Memtro (Client)", "keyEnv": "CLIENT_MEMTRO_KEY",
 *         "baseUrl": "https://memtro.client.internal", "limit": { "context": 128000 } }
 *     ]
 *   }
 *
 * The first account registers as `memtro`, the rest as `memtro-<id>`. That is deliberate rather than tidy: an
 * existing single-account setup names `memtro/auto:chat` in its config and on its command line, and adding a
 * second account should not quietly rename the first one's models out from under it.
 *
 * With no file, there is one implicit account from `MEMTRO_API_KEY` — which is exactly what this did before.
 *
 * ## What is a default here and what is a fact
 *
 * Memtro's `/v1/models` reports model ids and nothing else: no context window, no output limit, no prices. Pi
 * needs all three. So the windows and limits below are defaults chosen for the models Memtro usually routes to,
 * not facts read from the endpoint — `MEMTRO_CONTEXT_WINDOW` and `MEMTRO_MAX_TOKENS` move them globally, and an
 * account's own `limit` overrides them where one ladder differs from another. Costs are reported as zero on
 * purpose: Memtro meters spend itself, per user and per team, and a second set of numbers in Pi's footer would
 * only ever be the wrong ones.
 */

const DEFAULT_HOST = "https://platform.memtro.com";
const DEFAULT_KEY_VAR = "MEMTRO_API_KEY";
const CONFIG_FILE = "memtro.json";

/** Where Pi keeps user-level configuration, which is where an account list belongs. */
const agentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

const trimHost = (url: string): string => url.replace(/\/+$/, "");

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

/** One Memtro account, resolved. `provider` is what Pi addresses its models by. */
interface Account {
  /** As written in the config, or "" for the implicit single account. Used in messages and in the provider id. */
  id: string;
  provider: string;
  label: string;
  host: string;
  keyEnv: string;
  contextWindow: number;
  maxTokens: number;
  tools: boolean;
}

interface AccountFile {
  accounts?: {
    id?: unknown;
    name?: unknown;
    keyEnv?: unknown;
    baseUrl?: unknown;
    tools?: unknown;
    limit?: { context?: unknown; output?: unknown };
  }[];
}

/**
 * Pi's own rule for MCP server names: letters, digits, `_` and `-`, and two names differing only in `_` versus
 * `-` count as the same server. Applied to account ids as well as the servers built from them, so a config that
 * would be rejected half-way through registration is rejected before any of it happens.
 */
const normaliseId = (id: string): string => id.replace(/-/g, "_").toLowerCase();
const validId = (id: string): boolean => /^[A-Za-z0-9_-]{1,40}$/.test(id);

/** The implicit account: what this extension did before there was a config file, and still does without one. */
function envAccount(): Account {
  return {
    id: "",
    provider: "memtro",
    label: "Memtro",
    host: trimHost(process.env.MEMTRO_BASE_URL || DEFAULT_HOST),
    keyEnv: DEFAULT_KEY_VAR,
    contextWindow: positive("MEMTRO_CONTEXT_WINDOW", 200_000),
    maxTokens: positive("MEMTRO_MAX_TOKENS", 32_000),
    tools: process.env.MEMTRO_PI_TOOLS !== "0",
  };
}

/**
 * The accounts to register.
 *
 * A broken config falls back to the single environment account rather than throwing. An extension that refuses to
 * load takes Pi's whole startup with it, and "my coding agent will not start" is a worse outcome than "my second
 * Memtro account is missing" — so the reason is said out loud and the usable half carries on.
 */
export function readAccounts(dir = agentDir()): { accounts: Account[]; problems: string[] } {
  const path = join(dir, CONFIG_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { accounts: [envAccount()], problems: [] };
  }

  const problems: string[] = [];
  let parsed: AccountFile;
  try {
    parsed = JSON.parse(raw) as AccountFile;
  } catch (err) {
    return { accounts: [envAccount()], problems: [`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); using ${DEFAULT_KEY_VAR} alone`] };
  }

  const listed = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  if (listed.length === 0) return { accounts: [envAccount()], problems: [`${path} lists no accounts; using ${DEFAULT_KEY_VAR} alone`] };

  const accounts: Account[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of listed.entries()) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!validId(id)) {
      problems.push(`account ${index + 1} has no usable id (letters, digits, - and _ only); skipped`);
      continue;
    }
    if (seen.has(normaliseId(id))) {
      // Pi treats `my-account` and `my_account` as one server and rejects the second, so two accounts that differ
      // only there would silently lose their tools. Said here instead, where it can name both.
      problems.push(`account "${id}" collides with one already listed (names differing only in - and _ are the same to Pi); skipped`);
      continue;
    }
    seen.add(normaliseId(id));
    const keyEnv = typeof entry.keyEnv === "string" && entry.keyEnv.trim() ? entry.keyEnv.trim() : DEFAULT_KEY_VAR;
    const limit = entry.limit ?? {};
    accounts.push({
      id,
      // The first account keeps the bare `memtro` so an existing setup's model ids go on meaning what they meant.
      provider: accounts.length === 0 ? "memtro" : `memtro-${id}`,
      label: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `Memtro (${id})`,
      host: trimHost(typeof entry.baseUrl === "string" && entry.baseUrl.trim() ? entry.baseUrl.trim() : process.env.MEMTRO_BASE_URL || DEFAULT_HOST),
      keyEnv,
      contextWindow: typeof limit.context === "number" && limit.context > 0 ? limit.context : positive("MEMTRO_CONTEXT_WINDOW", 200_000),
      maxTokens: typeof limit.output === "number" && limit.output > 0 ? limit.output : positive("MEMTRO_MAX_TOKENS", 32_000),
      tools: entry.tools === false ? false : process.env.MEMTRO_PI_TOOLS !== "0",
    });
  }

  if (accounts.length === 0) return { accounts: [envAccount()], problems: [...problems, `no usable account in ${path}; using ${DEFAULT_KEY_VAR} alone`] };
  return { accounts, problems };
}

const apiBase = (a: Account): string => `${a.host}/v1`;
const mcpUrl = (a: Account): string => `${a.host}/api/mcp`;

function chatModel(a: Account, id: string, name: string) {
  return {
    type: "chat" as const,
    id,
    name,
    reasoning: true,
    thinkingLevelMap: THINKING,
    input: inputs(),
    cost: NO_COST,
    contextWindow: a.contextWindow,
    maxTokens: a.maxTokens,
  };
}

/** What is offered before (or instead of) discovery: the routing ids, which every organisation has. */
function baseModels(a: Account) {
  return [
    chatModel(a, "auto:chat", `${a.label} auto (one reply)`),
    chatModel(a, "auto:agent", `${a.label} auto (multi-step agent)`),
    chatModel(a, "memtro:chat", `${a.label} default model (one reply)`),
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
async function discover(a: Account, signal?: AbortSignal) {
  const key = process.env[a.keyEnv];
  if (!key) return baseModels(a);
  try {
    const res = await fetch(`${apiBase(a)}/models`, { headers: { Authorization: `Bearer ${key}` }, signal });
    if (!res.ok) return baseModels(a);
    const body = (await res.json()) as ModelsResponse;
    const ids = (body.data ?? []).map((row) => row.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return baseModels(a);

    const models = [chatModel(a, "auto:chat", `${a.label} auto (one reply)`), chatModel(a, "auto:agent", `${a.label} auto (multi-step agent)`)];
    const taken = new Set(models.map((m) => m.id));
    for (const id of ids) {
      const chatId = id.endsWith(":chat") || id.endsWith(":agent") ? id : `${id}:chat`;
      if (taken.has(chatId)) continue;
      taken.add(chatId);
      models.push(chatModel(a, chatId, `${id} (one reply)`));
    }
    return models;
  } catch {
    return baseModels(a);
  }
}

/** One line of status per account, for `/memtro`. */
async function statusOf(a: Account): Promise<string> {
  const where = `${a.provider} → ${a.host}`;
  const key = process.env[a.keyEnv];
  if (!key) return `${where}: no ${a.keyEnv} in the environment`;
  try {
    const res = await fetch(`${apiBase(a)}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return `${where}: /v1/models answered ${res.status}${res.status === 401 ? " (the key is wrong or withdrawn)" : ""}`;
    const body = (await res.json()) as ModelsResponse;
    const count = (body.data ?? []).length;
    return `${where}: ${count} model${count === 1 ? "" : "s"}, ${a.tools ? "tools on" : "tools off"} (${a.keyEnv})`;
  } catch (err) {
    return `${where}: unreachable (${err instanceof Error ? err.message : String(err)})`;
  }
}

export default function (pi: ExtensionAPI) {
  const { accounts, problems } = readAccounts();

  for (const account of accounts) {
    pi.registerProvider(account.provider, {
      name: account.label,
      baseUrl: apiBase(account),
      api: "openai-completions",
      // Pi's own interpolation: the key is named here, never read here.
      apiKey: `$${account.keyEnv}`,
      models: baseModels(account),
      refreshModels: async () => discover(account),
    });

    if (account.tools) {
      pi.registerMcpServer(account.provider, {
        url: mcpUrl(account),
        headers: { Authorization: `Bearer \${${account.keyEnv}}` },
        description: `${account.label}: company memory, and the systems this organisation has connected. Search what is known, remember a fact, and read the CRM, the tickets, the ledger and the rest as the signed-in user.`,
      });
    }
  }

  /**
   * Somewhere to look when it is not working, which for this integration is nearly always one of three things:
   * no key, a key the server will not take, or a host that is not the one you meant. With more than one account
   * it is a fourth: the right key against the wrong account, which reads as a 401 on one line and nothing on the
   * others, so every account gets a line whether it is healthy or not.
   */
  pi.registerCommand("memtro", {
    description: "Check every Memtro account: key, endpoint and the models it offers",
    handler: async (_args, ctx) => {
      const lines = await Promise.all(accounts.map(statusOf));
      const body = [...problems.map((p) => `config: ${p}`), ...lines].join("\n");
      const bad = problems.length > 0 || lines.some((l) => !/: \d+ model/.test(l));
      ctx.ui.notify(`${body}\n\nUse /model to pick one — prefer an id ending :chat.`, bad ? "warning" : "info");
    },
  });
}
