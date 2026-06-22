# Zero-Cost Single Source Of Truth (SSOT) Memory — Implementation Guide

A complete, self-contained guide to building an **A+ semantic memory** that serves
as the **single source of truth (SSOT)** for any project or agent, at **$0/month**,
using only a **free Supabase project**.

No external APIs. No generative model. No servers to run. No special hardware. The
entire system is one Supabase project: a Postgres database plus a single Edge
Function. The model that *calls* the memory does any summarizing or reasoning — the
memory's job is to **store knowledge and return the most relevant of it on demand**,
ranked, with provenance, and with measurable retrieval quality.

This works for everyone: if you can create a free Supabase account, you can run it.

---

## 1. What you are building

A semantic memory with the properties that make a knowledge store *A+*:

- **Semantic retrieval** — find knowledge by *meaning*, not just keywords.
- **Hybrid ranking** — vector similarity fused with full-text search.
- **A relevance loop** — results are re-ranked by a transparent score that reflects
  importance, usage, and recency, and improves over time.
- **Provenance** — every item records where it came from and what supersedes it.
- **Measurable quality** — a retrieval eval gate proves the memory still returns the
  right things, so quality never silently degrades.
- **Self-maintenance** — lifecycle decay, expiry, and supersession happen
  automatically, in-database, with no babysitting.
- **Model-agnostic** — the memory has no dependency on any generative model; any
  LLM or agent can use it.

What it deliberately does **not** do: generate prose, summaries, or "syntheses."
That is delegated to the calling model, which is already an LLM and is better placed
to compose an answer from the raw context the memory returns. Removing generation is
what makes the system free, simple, and robust.

---

## 2. Design principles (why it is this simple)

1. **One project, two moving parts.** Everything lives in a single free Supabase
   project: Postgres (storage + retrieval + relevance + maintenance) and one Edge
   Function (embeddings + API). Nothing else exists to break.
2. **Embed in-edge, for free.** Supabase ships a built-in embedding model
   (`gte-small`, 384-dim) that runs *inside* the Edge Function. No embedding API, no
   key, no per-token cost, no data leaving the project.
3. **Relevance is a pure function, computed at query time.** No background job
   recomputes scores — the rank is derived from current row state on every search,
   so there is nothing to schedule and nothing to drift.
4. **Generation is the caller's job.** The memory returns ranked raw context; the
   calling model synthesizes. This removes the only component that would need a
   generative LLM.
5. **Maintenance is deterministic and optional.** Decay, expiry, and supersession
   are pure SQL — a couple of tiny `pg_cron` jobs, or nothing at all for a small
   store.
6. **Quality is measured, not assumed.** A retrieval eval gate is the one practice
   that separates an A+ memory from a folder of notes.

---

## 3. Architecture

```
        any LLM / agent / app  ("the caller")
                  │  HTTPS (remember / recall)
                  ▼
   ┌────────────────── Supabase (free project) ───────────────────┐
   │                                                              │
   │  Edge Function  "memory"                                     │
   │   • embeds text in-edge with gte-small (384d)                │
   │   • remember → embed + insert                                │
   │   • recall   → embed query + call recall() RPC + return bundle│
   │                  │                                            │
   │                  ▼                                            │
   │  Postgres                                                    │
   │   • memories table (content, vector(384), FTS, provenance)   │
   │   • recall() RPC  → hybrid (vector + FTS + RRF) +            │
   │                     inline relevance rerank                  │
   │   • pg_cron (optional, pure SQL): decay · expire             │
   └──────────────────────────────────────────────────────────────┘
```

**Moving parts: two.** A Postgres database and one Edge Function — both inside one
free Supabase project. Zero external services, zero third-party API keys, zero
generative models, zero always-on hardware.

---

## 4. Tech stack (the complete list)

- **Supabase free tier** — Postgres 15, Edge Functions, and the in-edge `gte-small`
  embedding model.
- **Postgres extensions:** `vector` (pgvector) and `pg_trgm`; optionally `pg_cron`
  for maintenance.
- That is the entire stack.

---

## 5. Data model

One table holds everything. `kind` distinguishes notes, facts, decisions,
corrections, and references; `source` carries provenance; `superseded_by` carries
supersession. (You can later split this into a multi-table model if you need richer
provenance, but a single table is the minimal, A+-sufficient form.)

```sql
create extension if not exists vector;
create extension if not exists pg_trgm;

create table if not exists memories (
  id              uuid primary key default gen_random_uuid(),
  content         text not null,
  kind            text not null default 'note',      -- note|fact|decision|correction|reference
  importance      double precision not null default 0.5,  -- lifecycle signal (decays)
  base_importance double precision not null default 0.5,  -- FROZEN at insert (ranking input)
  access_count    integer not null default 0,
  is_active       boolean not null default true,
  superseded_by   uuid references memories(id),
  source          text,                              -- provenance: where it came from
  tags            text[] not null default '{}',
  embedding       vector(384),                       -- gte-small
  fts             tsvector generated always as (to_tsvector('english', content)) stored,
  last_accessed_at timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists memories_vec on memories using hnsw (embedding vector_cosine_ops);
create index if not exists memories_fts on memories using gin (fts);
create index if not exists memories_live on memories (is_active) where is_active;

alter table memories enable row level security;       -- no public policies; service role only
```

**Two importance columns, on purpose.** `base_importance` is frozen at insert and is
the *ranking* input — nothing mutates it, so the relevance score is reproducible.
`importance` is the *lifecycle* signal that decays and drives expiry. Keeping them
separate means decay never silently corrupts ranking.

---

## 6. Embeddings in-edge (gte-small)

The embedding model runs inside the Edge Function via Supabase's built-in session
API — no external call:

```ts
const model = new Supabase.ai.Session('gte-small');
const embedding = await model.run(text, { mean_pool: true, normalize: true });
// → number[384]
```

> **Pick the embedding model once.** Semantic search only works *within a single
> embedding space* — a query embedded with model A cannot be compared against
> vectors embedded with model B. `gte-small` is fixed at 384 dimensions; the schema
> matches it (`vector(384)`). Changing the embedding model later means re-embedding
> every row, so treat it as a one-time decision.

---

## 7. Retrieval — hybrid search with inline relevance

A single RPC does hybrid retrieval (vector + FTS), fuses with Reciprocal Rank Fusion
over a widened candidate pool, normalizes, and blends in the relevance score —
**all computed live, no precomputation**. The Edge Function embeds the query, then
calls this:

```sql
create or replace function recall(
  query_embedding vector(384),
  query_text      text,
  match_limit     int default 8,
  pool            int default 200      -- widened candidate pool before fusion
)
returns table (
  id uuid, content text, kind text, source text,
  base_importance double precision, effective_score double precision,
  rrf_norm double precision, final_score double precision
)
language sql stable
as $$
  with vec as (
    select id, row_number() over (order by embedding <=> query_embedding) as rank
    from memories
    where is_active and superseded_by is null and embedding is not null
    order by embedding <=> query_embedding
    limit pool
  ),
  fts as (
    select id, row_number() over (
             order by ts_rank(fts, websearch_to_tsquery('english', query_text)) desc) as rank
    from memories
    where is_active and superseded_by is null
      and fts @@ websearch_to_tsquery('english', query_text)
    limit pool
  ),
  fused as (
    select coalesce(v.id, f.id) as id,
           coalesce(1.0/(60+v.rank), 0) + coalesce(1.0/(60+f.rank), 0) as rrf
    from vec v full outer join fts f using (id)
  ),
  norm as (
    select id,
           (rrf - min(rrf) over ()) /
             nullif(max(rrf) over () - min(rrf) over (), 0) as rrf_norm
    from fused
  ),
  scored as (
    select m.id, m.content, m.kind, m.source, m.base_importance, n.rrf_norm,
           greatest(0.05, least(1.0,
                 1.0 * m.base_importance
               + 0.15 * ln(1 + m.access_count) / ln(1 + 50)
               - 0.15 * least(extract(days from now()
                         - coalesce(m.last_accessed_at, m.created_at)) / 180.0, 1.0)
           )) as effective_score
    from norm n join memories m on m.id = n.id
  )
  select id, content, kind, source, base_importance, effective_score, rrf_norm,
         1.0 * rrf_norm + 0.15 * effective_score as final_score
  from scored
  order by final_score desc
  limit match_limit;
$$;
```

Every component (`rrf_norm`, `effective_score`, `final_score`) is returned as a
column, so the caller can always see *why* a row ranked where it did. The blend
weights (`w_rrf = 1.0`, `w_eff = 0.15`) are explicit — tune `w_eff` with the eval
(§11), don't guess.

---

## 8. The relevance score

`effective_score` is a **pure, idempotent function of current row state**:

```
effective_score = clamp(0.05, 1.0,
      1.0 · base_importance                                  -- importance (frozen)
    + 0.15 · ln(1 + access_count) / ln(1 + 50)               -- usage, log-damped
    - 0.15 · min(days_since_access / 180, 1.0) )             -- recency decay
```

Because it is computed at query time, two rows with the same state always rank the
same regardless of history — no drift, nothing to recompute, no background job. Usage
(`access_count`) makes genuinely-used knowledge surface higher; recency gently
demotes the long-untouched. Importance dominates, so a high-value item never gets
buried by a transiently popular one.

---

## 9. The API the caller uses

One Edge Function exposes two actions. The caller `remember`s knowledge and `recall`s
it; everything else (embedding, ranking, provenance) is internal.

```ts
// supabase/functions/memory/index.ts
import { createClient } from 'jsr:@supabase/supabase-js@2';

const model = new Supabase.ai.Session('gte-small');
const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req) => {
  // caller auth: a scoped bearer token you set as a function secret
  if (req.headers.get('authorization') !== `Bearer ${Deno.env.get('MEMORY_TOKEN')}`)
    return new Response('unauthorized', { status: 401 });

  const { action, ...a } = await req.json();

  if (action === 'remember') {
    const embedding = await model.run(a.content, { mean_pool: true, normalize: true });
    const { data, error } = await db.from('memories').insert({
      content: a.content, kind: a.kind ?? 'note',
      importance: a.importance ?? 0.5, base_importance: a.importance ?? 0.5,
      source: a.source, tags: a.tags ?? [], embedding,
    }).select('id').single();
    // write-time supersession: a correction can retire the row it replaces
    if (!error && a.supersedes)
      await db.from('memories').update({ superseded_by: data!.id }).eq('id', a.supersedes);
    return Response.json({ id: data?.id, error: error?.message ?? null });
  }

  if (action === 'recall') {
    const embedding = await model.run(a.query, { mean_pool: true, normalize: true });
    const { data, error } = await db.rpc('recall', {
      query_embedding: embedding, query_text: a.query, match_limit: a.limit ?? 8,
    });
    // count genuine reads as usage; system/eval callers pass track:false
    if (!error && a.track !== false && data?.length)
      await db.rpc('bump_access', { ids: data.map((r: { id: string }) => r.id) });
    return Response.json({ results: data ?? [], error: error?.message ?? null });
  }

  return new Response('unknown action', { status: 400 });
});
```

The usage helper keeps tracking honest (system reads opt out with `track:false`):

```sql
create or replace function bump_access(ids uuid[])
returns void language sql as $$
  update memories set access_count = access_count + 1, last_accessed_at = now()
  where id = any(ids);
$$;
```

**How the caller "synthesizes":** it calls `recall`, receives the ranked bundle of
raw memories, and composes its own answer from them — exactly as it would from any
retrieved context. The memory never generates; the model does.

---

## 10. Maintenance (optional, deterministic, no LLM)

Two tiny pure-SQL `pg_cron` jobs keep the store healthy and inside the free-tier size
limit. For a small memory you can skip these entirely; supersession alone (§9)
handles obsolescence.

```sql
-- decay the lifecycle importance of long-unused rows (never touches base_importance)
select cron.schedule('memory-decay', '0 3 * * *', $$
  update memories set importance = importance * 0.95
  where is_active and last_accessed_at < now() - interval '30 days' and importance > 0.1;
$$);

-- expire low-value, never-used, old rows
select cron.schedule('memory-expire', '0 4 * * *', $$
  update memories set is_active = false
  where is_active and importance < 0.1 and access_count = 0
    and created_at < now() - interval '90 days';
$$);
```

There is **no synthesis job, no contradiction-detection job, no score-recompute job**
— supersession is handled at write time, contradictions are resolved by the caller
when it stores a correction, and the relevance score is computed inline at query
time. That is the entire maintenance surface.

---

## 11. Quality — the eval gate (what makes it A+)

This is the one practice you should not skip. Without it you have a free memory and
no idea whether it still retrieves well.

Keep a small fixture file of `{query, expected_ids}` covering the kinds of knowledge
the memory holds. A tiny script calls `recall` for each (with `track:false`),
computes **recall@k** (did the expected items come back in the top *k*?), and fails
if quality regresses.

```jsonc
// eval/fixtures.json
[
  { "query": "deployment rollback procedure", "expected_ids": ["…uuid…"] },
  { "query": "why we chose Postgres over a key-value store", "expected_ids": ["…uuid…"] }
]
```

```ts
// eval/run.ts — recall@k gate
const fx = JSON.parse(await Deno.readTextFile('eval/fixtures.json'));
let pass = 0;
for (const f of fx) {
  const r = await recall(f.query, { limit: 8, track: false });   // calls the Edge Function
  const ids = new Set(r.results.map((x: { id: string }) => x.id));
  if (f.expected_ids.every((id: string) => ids.has(id))) pass++;
}
const recallAtK = pass / fx.length;
console.log(`recall@8 = ${(recallAtK * 100).toFixed(1)}%  (${pass}/${fx.length})`);
if (recallAtK < 0.9) Deno.exit(1);   // gate: fail CI if retrieval degrades
```

Run it locally before changes, or on a **free GitHub Actions** cron. Re-baseline
when you intentionally change ranking. This is what lets you evolve the memory
(tune `w_eff`, add data, change the embedding model) **with confidence rather than
hope**.

---

## 12. Security

- **RLS on, no public policies.** Only the Edge Function (holding the
  `service_role` key as a function secret) reads/writes; clients never touch the
  table directly.
- **Caller auth.** The function checks a scoped `MEMORY_TOKEN` bearer token. Issue
  different tokens per consumer if you want to revoke individually.
- **No secrets in git.** The service-role key and `MEMORY_TOKEN` are Supabase
  function secrets, set via the CLI/dashboard — never committed.
- The memory stores no third-party credentials and makes no outbound calls, so its
  external attack surface is just the one authenticated function.

---

## 13. Operating on the free tier

- **500 MB database.** Ample: a few thousand memories with 384-dim vectors and the
  HNSW index sit in the low tens of MB. Keep `memory-expire` on and prune as needed.
  Watch it: `select pg_size_pretty(pg_database_size(current_database()));`
- **Projects pause after ~7 days of no activity.** Normal use keeps it awake. If the
  memory can sit idle, add a **free** GitHub Actions cron that hits the function (or
  runs `select 1;`) every few days.
- **No managed backups on the free tier.** Run a periodic `pg_dump` (locally or in a
  free CI job) and keep the dumps; test a restore once. This is your recovery path.

---

## 14. Implementation steps

1. **Create** a free Supabase project; note its URL, `anon`, and `service_role` keys.
2. **Enable extensions:** `vector`, `pg_trgm` (and `pg_cron` if you want §10).
3. **Apply the schema** (§5), the `recall()` RPC (§7), and the `bump_access()`
   helper (§9), via the SQL editor or a migration.
4. **Set the function secret** `MEMORY_TOKEN` (a token you generate); the function
   already has `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` available.
5. **Deploy** the `memory` Edge Function (§9):
   `supabase functions deploy memory --no-verify-jwt`.
6. **(Optional) schedule** the two maintenance jobs (§10) and a keepalive ping.
7. **Point your caller** at the function: it `remember`s knowledge and `recall`s it,
   composing answers from the returned bundle.
8. **Seed the eval** (§11) and wire it into CI or a local pre-change check.

---

## 15. A+ definition of done

- [ ] One free Supabase project; `vector` + `pg_trgm` enabled.
- [ ] `memories` table with `vector(384)`, generated FTS, RLS on (no public policies).
- [ ] `recall()` RPC: hybrid vector + FTS + RRF over a widened pool, with inline
      `effective_score` rerank; components returned as columns.
- [ ] `memory` Edge Function: gte-small in-edge embedding; `remember` + `recall`;
      token-authenticated; usage tracked with a system-read opt-out.
- [ ] Write-time supersession; relevance computed live (no recompute job); **no
      synthesis** (delegated to the caller).
- [ ] Optional pure-SQL decay/expire jobs; size monitored under 500 MB.
- [ ] Retrieval eval (recall@k) runs on a schedule/CI and gates ranking changes.
- [ ] Backups via periodic `pg_dump`; a tested restore.
- [ ] No secrets in git; service-role key only in function secrets.

---

*This is the minimal A+ memory SSOT: hybrid semantic retrieval, a transparent
relevance loop, provenance, deterministic self-maintenance, and a measured quality
gate — delivered by a single free Supabase project with two moving parts, no
generative model, and no recurring cost. The model that calls it brings the
intelligence; the memory brings the right knowledge, ranked, every time.*
</content>
