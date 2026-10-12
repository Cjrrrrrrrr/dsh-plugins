# dsh-scholar

Academic search tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Adds **four model-facing tools** for literature work. Every source is a public, free
API — no key required to start.

| Tool | What it does |
|---|---|
| `paper_search` | Cross-source paper search returning title, authors, year, venue, citation count, DOI, **open-access PDF link** and abstract |
| `paper_get` | Single paper by **DOI / arXiv id / PMID** via exact endpoints (not fuzzy search); falls back to **Unpaywall** for a legal free full text when the paper is not obviously open |
| `paper_citations` | Citation graph: `cited_by` (who cites it — follow-up work) or `cites` (what it cites — foundational work) |
| `book_search` | Books and book chapters |

## Sources

| Source | Scope | Notes |
|---|---|---|
| **OpenAlex** | 250M+ works, all disciplines | Richest metadata, carries open-access links and abstracts |
| **arXiv** | Physics, maths, CS, AI preprints | Fastest to update |
| **Crossref** | Authoritative DOI registry | Publisher-side metadata; used for exact DOI lookups |
| **Semantic Scholar** | Semantic search + citation graph | Rate-limits hard without a key (HTTP 429 in testing) |
| **PubMed** | Biomedicine | Official NLM E-utilities, includes abstracts |

Chinese-language literature: CNKI / Wanfang / VIP have **no public API**. Chinese
journals that OpenAlex or Crossref index (under their English metadata) are reachable.

## Install

```sh
dsh plugin add github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-scholar
```

Requires DSH 0.1.0-rc.1 or newer.

## Configure

Add a `config` block to the plugin's row in your profile patch:

```yaml
- id: scholar
  name: '@local/dsh-scholar'
  config:
    mailto: you@example.com      # your email, see below
    semanticScholarApiKey: ''    # optional; fixes 429s
    maxAbstractChars: 500        # cap on the abstract injected into context
```

### `mailto` — read this before using `paper_get` on a paywalled paper

OpenAlex and Crossref join their "polite pool" when you identify yourself, and
**Unpaywall requires a real address**: a placeholder one is rejected with
`HTTP 422: Please use your own email address`.

The built-in default is a GitHub `noreply` address, which Unpaywall also rejects.
So:

- The other three tools work with no configuration at all.
- For open-access resolution, **set `mailto` to your own email**. When it is missing
  or rejected, `paper_get` returns an explicit error telling you to set it — it does
  not silently skip the lookup.

## Known limitations

| Limitation | What happens | Workaround |
|---|---|---|
| Unpaywall needs a real email | Placeholder addresses get HTTP 422 | Set `mailto` to your own address |
| Semantic Scholar rate limits | HTTP 429 without a key (also seen returning in 1.0s) | Request a key and set `semanticScholarApiKey` |
| arXiv is occasionally slow | Requests can take 30s+ under load | Timeout is 60s with one automatic retry |
| Open Library is not used | It was unreachable in testing | Book search goes through OpenAlex (`filter=type:book|book-chapter`), which needs no key |

Non-English queries work better translated to English first.

## Implementation notes

1. **IPv4 is forced.** On Windows with IPv6, Node's `fetch` to `export.arxiv.org:443`
   fails with `Connect Timeout Error` while curl (IPv4) succeeds, so the network layer
   uses `node:https` with `family: 4`, its own timeout, redirect following and
   cancellation.
2. **DOIs use exact endpoints** — `api.crossref.org/works/{doi}` and
   `api.openalex.org/works/https://doi.org/{doi}`. A `?query=` search matched the wrong
   paper for a well-known DOI in testing.
3. **Response streams carry an `error` handler**; without one, a mid-transfer reset
   surfaces as an uncaught exception in the host.
4. **Cross-source de-duplication** normalises by DOI and by title, so one paper
   appearing in both OpenAlex and Crossref is not reported twice.
5. **One failing source never fails the call** — the error is reported back to the
   model so it can retry elsewhere.

## Layout

```
lib/sources.js   data layer: pure functions, one per source, testable without the host
lib/index.js     host half: registers the four tools
cordis.patch.yml the bundle row
```

## License

MIT
