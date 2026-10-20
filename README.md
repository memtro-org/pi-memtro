# Memtro for Pi

Your company's memory as [Pi](https://pi.dev)'s model, and its connected systems as Pi's tools. One install does both.

```bash
export MEMTRO_API_KEY=sk-memtro-...
pi install git:github.com/memtro-org/pi-memtro
pi --model auto:chat
```

That is the whole setup. The package registers a `memtro` model provider and a `memtro` MCP server, so Pi sessions run with your organisation's memory and routing behind them *and* can search that memory and your connected systems on purpose.

Everything it does can be done by hand instead — see the [manual setup](https://www.memtro.com/docs/guide-pi/) if you would rather own the config.

## Get a key

Create a personal API key on [Dashboard → Profile → API keys](https://platform.memtro.com/dashboard/profile/keys) and export it as `MEMTRO_API_KEY`. The key acts as you: your memory, your connections, your permissions. Pi resolves it from the environment when it builds each request, so it is never written into a config file.

## Models, and why they end in `:chat`

This is the reason the package exists rather than a paragraph of JSON to copy.

Memtro answers in one of two modes. `chat` is a single reply. `agent` is a multi-step investigation that plans, calls tools across your connected systems, and comes back when it has an answer. A plain model id means whichever your organisation set as its default in Dashboard → Routing, and for a chat UI `agent` is often the right default.

Pi is not a chat UI. It runs an agent loop of its own, so a default of `agent` puts Memtro's investigation *inside* Pi's loop and every turn becomes an agent running an agent. Nothing reports this. It is simply four minutes where there should have been four seconds.

So every model this registers is suffixed `:chat`, which pins the mode per request and ignores the default:

| Model | What it does |
|---|---|
| `auto:chat` | Memtro picks the model; one reply. The one you want. |
| `auto:agent` | Memtro picks the model and runs the full investigation. For when that is the point. |
| `memtro:chat` | Your organisation's default model; one reply. |
| `<provider>/<model>:chat` | A specific model, discovered from your account. |

The list after `auto:*` is discovered from `/v1/models`, so it is whatever your organisation actually holds keys for, under its routing lock if one is set. Run `/model` in a session to pick one; it re-reads the catalogue.

## Tools

The package also registers Memtro's MCP server, so `memtro_search`, `memtro_remember`, `memtro_why` and a tool per capability of every connection you have access to are available in the session. They arrive named `mcp__memtro__*`. Use `/mcp` to inspect them.

Set `MEMTRO_PI_TOOLS=0` if you want Memtro as the model and nothing else.

## Check it

```
/memtro
```

Reports the host, whether the key works, how many models it offers and where the tools are. It is the first thing to run when something is not working, because it is nearly always one of three things: no key, a key the server will not take, or a host that is not the one you meant.

## Settings

| Variable | Default | What it is for |
|---|---|---|
| `MEMTRO_API_KEY` | — | Required. Your Memtro key. |
| `MEMTRO_BASE_URL` | `https://platform.memtro.com` | A self-hosted Memtro. |
| `MEMTRO_PI_TOOLS` | on | `0` registers the model provider only. |
| `MEMTRO_CONTEXT_WINDOW` | `200000` | See below. |
| `MEMTRO_MAX_TOKENS` | `32000` | See below. |
| `MEMTRO_IMAGE_INPUT` | off | `1` declares image input on every Memtro model. |

### What is a default here and what is a fact

Memtro's `/v1/models` reports model ids and nothing else — no context window, no output limit, no prices — and Pi needs all three. So the window and output limit are defaults chosen for the models Memtro usually routes to, not facts read from the endpoint. If yours are different, set them.

Costs are reported to Pi as zero on purpose. Memtro meters spend itself, per user and per team, on its usage page; a second set of numbers in Pi's footer would only ever be the wrong ones.

Image input is off by default because the listing does not say which models are vision models, and claiming it for all of them would hand pictures to models that cannot read them.

## Trust

A Pi extension runs inside the Pi process with your permissions, so install it from somewhere you trust — including this one. What this package does: registers a provider and an MCP server, and reads `MEMTRO_API_KEY` to fetch your model list from the host you configured. It makes no other network call, writes no files, and starts no processes. It is about 150 lines; read [`src/extension.ts`](src/extension.ts).

## Licence

MIT.
