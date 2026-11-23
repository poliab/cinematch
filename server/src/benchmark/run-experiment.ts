import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { RecommendationsService } from '../recommendations/recommendations.service';
import { TmdbClientService } from '../tmdb/tmdb-client.service';
import {
  CatalogMovieCandidate,
  extractReleaseYear,
  findBestCatalogMatch,
} from '../recommendations/movie-title-matcher';
import {
  RecommendationStrategy,
  ResolvedItemTelemetry,
} from '../recommendations/dto/recommendation-response.dto';
import { CreateRecommendationDto } from '../recommendations/dto/create-recommendation.dto';

interface CsvQueryRow {
  id: number;
  category: string;
  entryType: 'free_text' | 'quick_scenario';
  scenarioKey?: string;
  query: string;
  requiredGenres: string[];
  excludedGenres: string[];
  minYear?: number;
  maxYear?: number;
  note: string;
}

interface TmdbCacheEntry {
  existsInTmdb: boolean;
  tmdbTitle?: string;
  tmdbOriginalTitle?: string;
  releaseDate?: string | null;
}

interface BenchmarkRecord {
  timestamp: string;
  queryId: number;
  category: string;
  entryType: 'free_text' | 'quick_scenario';
  scenarioKey: string | null;
  queryText: string;
  strategy: RecommendationStrategy;
  model: string;
  repeat: number;
  latencyMs: number;
  rawText: string | null;
  jsonValid: boolean;
  tokenUsage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  } | null;
  promptChars: number | null;
  c3CandidateCount: number | null;
  c3StrictMatchCount: number | null;
  catalogMatchesBeforeFallback: number;
  supplementedByRuleBased: boolean;
  providerUsed: string | null;
  isFallback: boolean;
  parsedItems: Array<
    ResolvedItemTelemetry & {
      tmdbRealTitle?: string | null;
      tmdbRealOriginalTitle?: string | null;
      titleMatchesTmdb?: boolean | null;
    }
  >;
  shownMovies: Array<{
    id: number;
    tmdbId: number;
    title: string;
    titleEn: string | null;
    releaseYear: number | null;
    genres: string[];
  }>;
  error: string | null;
}

interface CliArgs {
  queriesPath: string;
  outPath: string;
  strategies: RecommendationStrategy[];
  models: string[];
  repeats: number;
  baselineRepeats: number;
  limitQueries?: number;
  queryIds?: Set<number>;
  delayMs?: number;
  timeoutMs: number;
  temperature: number;
  thinkingLevel: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  retries: number;
  resume: boolean;
  skipErrors: boolean;
  dryRun: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const defaultQueries = path.resolve(
    process.cwd(),
    '../../cinematch-research/experiment/zapyty.csv',
  );
  const defaultOut = path.resolve(
    process.cwd(),
    '../../cinematch-research/results/raw/experiment.jsonl',
  );

  const map = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      map.set(arg.slice(2, eqIdx), arg.slice(eqIdx + 1));
    } else if (arg === '--no-resume') {
      map.set('resume', false);
    } else if (arg === '--resume' || arg === '--skip-errors' || arg === '--dry-run') {
      map.set(arg.slice(2), true);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      map.set(arg.slice(2), argv[++i]);
    }
  }

  const strategiesRaw = String(map.get('strategies') ?? 'c1,c2,c3,rule_based');
  const strategies = strategiesRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is RecommendationStrategy =>
      ['c1', 'c2', 'c3', 'rule_based'].includes(s),
    );

  const modelsRaw = String(
    map.get('models') ?? 'gemini-3.5-flash-lite,gemma-4-31b-it',
  );
  const models = modelsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const queryIdsRaw = map.get('query-ids');
  const queryIds =
    typeof queryIdsRaw === 'string'
      ? new Set(
          queryIdsRaw
            .split(',')
            .map((n) => Number.parseInt(n.trim(), 10))
            .filter(Number.isFinite),
        )
      : undefined;

  return {
    queriesPath: path.resolve(String(map.get('queries') ?? defaultQueries)),
    outPath: path.resolve(String(map.get('out') ?? defaultOut)),
    strategies,
    models,
    repeats: Number.parseInt(String(map.get('repeats') ?? '3'), 10),
    baselineRepeats: Number.parseInt(
      String(map.get('baseline-repeats') ?? '1'),
      10,
    ),
    limitQueries: map.has('limit-queries')
      ? Number.parseInt(String(map.get('limit-queries')), 10)
      : undefined,
    queryIds,
    delayMs: map.has('delay-ms')
      ? Number.parseInt(String(map.get('delay-ms')), 10)
      : undefined,
    timeoutMs: Number.parseInt(String(map.get('timeout-ms') ?? '60000'), 10),
    temperature: Number.parseFloat(String(map.get('temperature') ?? '0.2')),
    thinkingLevel: String(map.get('thinking-level') ?? 'MINIMAL') as any,
    retries: Number.parseInt(String(map.get('retries') ?? '2'), 10),
    resume: map.get('resume') !== false,
    skipErrors: map.get('skip-errors') === true,
    dryRun: map.get('dry-run') === true,
  };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function loadQueriesCsv(csvPath: string): CsvQueryRow[] {
  const content = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = parseCsvLine(lines[0]);
  const col = (name: string) => headers.indexOf(name);

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const get = (name: string) => (cells[col(name)] ?? '').trim();
    const minY = get('min_year');
    const maxY = get('max_year');
    return {
      id: Number.parseInt(get('id'), 10),
      category: get('category'),
      entryType: (get('entry_type') || 'free_text') as 'free_text' | 'quick_scenario',
      scenarioKey: get('scenario_key') || undefined,
      query: get('query'),
      requiredGenres: get('required_genres') ? get('required_genres').split(';') : [],
      excludedGenres: get('excluded_genres') ? get('excluded_genres').split(';') : [],
      minYear: minY ? Number.parseInt(minY, 10) : undefined,
      maxYear: maxY ? Number.parseInt(maxY, 10) : undefined,
      note: get('note'),
    };
  });
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function isTransientError(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  const msg = String(err?.message ?? '').toLowerCase();
  return (
    status === 429 ||
    status === 503 ||
    status === 502 ||
    status === 504 ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('429') ||
    msg.includes('503')
  );
}

function trialKey(queryId: number, strategy: string, model: string, repeat: number): string {
  return `${queryId}::${strategy}::${model}::${repeat}`;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  let queries = loadQueriesCsv(args.queriesPath);

  if (args.queryIds && args.queryIds.size > 0) {
    queries = queries.filter((q) => args.queryIds!.has(q.id));
  }
  if (args.limitQueries && args.limitQueries > 0) {
    queries = queries.slice(0, args.limitQueries);
  }

  const planned: Array<{
    query: CsvQueryRow;
    strategy: RecommendationStrategy;
    model: string;
    repeat: number;
  }> = [];

  for (const strategy of args.strategies) {
    if (strategy === 'rule_based') {
      for (const query of queries) {
        for (let repeat = 1; repeat <= args.baselineRepeats; repeat++) {
          planned.push({ query, strategy, model: 'rule_based', repeat });
        }
      }
      continue;
    }

    for (const model of args.models) {
      for (const query of queries) {
        for (let repeat = 1; repeat <= args.repeats; repeat++) {
          planned.push({ query, strategy, model, repeat });
        }
      }
    }
  }

  const completedSuccess = new Set<string>();
  const completedAll = new Set<string>();
  if (args.resume && fs.existsSync(args.outPath)) {
    const existingLines = fs
      .readFileSync(args.outPath, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    for (const line of existingLines) {
      try {
        const rec = JSON.parse(line) as BenchmarkRecord;
        const key = trialKey(rec.queryId, rec.strategy, rec.model, rec.repeat);
        completedAll.add(key);
        if (!rec.error) {
          completedSuccess.add(key);
        }
      } catch {
        // Ignore malformed trailing line if interrupted mid-write
      }
    }
  }

  const pending = planned.filter((t) => {
    const key = trialKey(t.query.id, t.strategy, t.model, t.repeat);
    if (completedSuccess.has(key)) return false;
    if (args.skipErrors && completedAll.has(key)) return false;
    return true;
  });

  console.log(
    `[bench] queries=${queries.length} planned=${planned.length} completed=${planned.length - pending.length} pending=${pending.length}`,
  );
  console.log(`[bench] output=${args.outPath}`);

  if (args.dryRun || pending.length === 0) {
    return;
  }

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  const cachePath = path.join(path.dirname(args.outPath), 'tmdb_cache.json');
  const tmdbCache: Record<string, TmdbCacheEntry> = fs.existsSync(cachePath)
    ? JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    : {};

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const prisma = app.get(PrismaService);
    const recommendationsService = app.get(RecommendationsService);
    const tmdbClient = app.get(TmdbClientService);

    const dbMovies = await prisma.movie.findMany({
      select: {
        id: true,
        tmdbId: true,
        title: true,
        titleEn: true,
        releaseDate: true,
        popularity: true,
        voteCount: true,
      },
    });
    const catalogByTmdbId = new Map<number, CatalogMovieCandidate>(
      dbMovies.map((m) => [m.tmdbId, m]),
    );

    const tokenWindowByModel = new Map<string, Array<{ ts: number; tokens: number }>>();
    const lastCallAtByModel = new Map<string, number>();

    for (let idx = 0; idx < pending.length; idx++) {
      const task = pending[idx];
      const isLlm = task.strategy !== 'rule_based';

      if (isLlm) {
        const defaultDelay = task.model.includes('gemma') ? 2500 : 4500;
        const minGap = args.delayMs ?? defaultDelay;
        const lastAt = lastCallAtByModel.get(task.model) ?? 0;
        const elapsedSinceLast = Date.now() - lastAt;
        if (elapsedSinceLast < minGap) {
          await sleep(minGap - elapsedSinceLast);
        }

        // Guard Gemma 4 31B 16K TPM window during heavy C3 prompts
        if (task.model.includes('gemma')) {
          const estTokens = task.strategy === 'c3' ? 2200 : 400;
          const tpmCap = 13500;
          const now = Date.now();
          const win = (tokenWindowByModel.get(task.model) ?? []).filter(
            (e) => now - e.ts < 60000,
          );
          const used = win.reduce((acc, e) => acc + e.tokens, 0);
          if (used + estTokens > tpmCap && win.length > 0) {
            const waitMs = Math.max(0, 60500 - (now - win[0].ts));
            if (waitMs > 0) {
              console.log(`[bench] TPM guard waiting ${waitMs}ms for ${task.model}`);
              await sleep(waitMs);
            }
          }
          tokenWindowByModel.set(task.model, win);
        }
      }

      const dto: CreateRecommendationDto =
        task.query.entryType === 'quick_scenario' && task.query.scenarioKey
          ? { entryType: 'quick_scenario', scenarioKey: task.query.scenarioKey }
          : { entryType: 'free_text', freeTextPrompt: task.query.query };

      let record: BenchmarkRecord | null = null;

      for (let attempt = 0; attempt <= args.retries; attempt++) {
        const t0 = Date.now();
        if (isLlm) {
          lastCallAtByModel.set(task.model, t0);
        }

        try {
          const response = await recommendationsService.getRecommendations(
            dto,
            undefined,
            'uk',
            {
              strategyOverride: task.strategy,
              primaryProviderOverride: 'google',
              enableFallbackOverride: false,
              throwOnFailure: true,
              providerOptions: isLlm
                ? {
                    model: task.model,
                    temperature: args.temperature,
                    thinkingLevel: args.thinkingLevel,
                    timeoutMs: args.timeoutMs,
                  }
                : undefined,
            },
          );
          const latencyMs = Date.now() - t0;

          if (isLlm && task.model.includes('gemma')) {
            const win = tokenWindowByModel.get(task.model) ?? [];
            win.push({
              ts: Date.now(),
              tokens: response.diagnostics?.tokenUsage?.totalTokens ?? (task.strategy === 'c3' ? 2000 : 350),
            });
            tokenWindowByModel.set(task.model, win);
          }

          // Enrich C1 / C2 / C3 items with TMDb existence + title verification for stats
          const enrichedItems: BenchmarkRecord['parsedItems'] = [];
          for (const item of response.diagnostics?.resolvedItems ?? []) {
            if (task.strategy === 'c1' && item.inputTmdbId !== undefined) {
              const cat = catalogByTmdbId.get(item.inputTmdbId);
              if (cat) {
                const matchesTitle = item.inputTitle
                  ? findBestCatalogMatch(item.inputTitle, undefined, [cat]) !== null
                  : null;
                enrichedItems.push({
                  ...item,
                  existsInTmdb: true,
                  tmdbRealTitle: cat.title,
                  tmdbRealOriginalTitle: cat.titleEn ?? null,
                  titleMatchesTmdb: matchesTitle,
                });
              } else {
                const cacheKey = String(item.inputTmdbId);
                let cached = tmdbCache[cacheKey];
                let lookupFailed = false;
                if (!cached) {
                  const res = await tmdbClient.getMovieDetailsOptional(item.inputTmdbId, 'en-US');
                  if (res.failed) {
                    lookupFailed = true;
                  } else {
                    cached = res.found
                      ? {
                          existsInTmdb: true,
                          tmdbTitle: res.data?.title,
                          tmdbOriginalTitle: res.data?.original_title,
                          releaseDate: res.data?.release_date ?? null,
                        }
                      : { existsInTmdb: false };
                    tmdbCache[cacheKey] = cached;
                    fs.writeFileSync(cachePath, JSON.stringify(tmdbCache, null, 2), 'utf-8');
                  }
                  await sleep(120);
                }

                let titleMatchesTmdb: boolean | null = null;
                if (cached?.existsInTmdb && item.inputTitle) {
                  const tmdbCandidate: CatalogMovieCandidate = {
                    id: item.inputTmdbId,
                    tmdbId: item.inputTmdbId,
                    title: cached.tmdbTitle ?? '',
                    titleEn: cached.tmdbOriginalTitle ?? cached.tmdbTitle ?? null,
                    releaseDate: cached.releaseDate ?? null,
                  };
                  titleMatchesTmdb =
                    findBestCatalogMatch(item.inputTitle, undefined, [tmdbCandidate]) !== null;
                } else if (cached && !cached.existsInTmdb) {
                  titleMatchesTmdb = false;
                }

                enrichedItems.push({
                  ...item,
                  existsInTmdb: lookupFailed ? undefined : cached?.existsInTmdb,
                  tmdbLookupFailed: lookupFailed || undefined,
                  tmdbRealTitle: cached?.tmdbTitle ?? null,
                  tmdbRealOriginalTitle: cached?.tmdbOriginalTitle ?? null,
                  titleMatchesTmdb,
                });
              }
            } else {
              enrichedItems.push({
                ...item,
                tmdbRealTitle: item.tmdbLookupTitle ?? null,
                tmdbRealOriginalTitle: item.tmdbLookupTitle ?? null,
                titleMatchesTmdb: item.matchedInCatalog ? true : null,
              });
            }
          }

          record = {
            timestamp: new Date().toISOString(),
            queryId: task.query.id,
            category: task.query.category,
            entryType: task.query.entryType,
            scenarioKey: task.query.scenarioKey ?? null,
            queryText: task.query.query,
            strategy: task.strategy,
            model: task.model,
            repeat: task.repeat,
            latencyMs,
            rawText: response.diagnostics?.rawText ?? null,
            jsonValid: response.diagnostics?.jsonValid ?? false,
            tokenUsage: response.diagnostics?.tokenUsage ?? null,
            promptChars: response.diagnostics?.promptChars ?? null,
            c3CandidateCount: response.diagnostics?.c3CandidateCount ?? null,
            c3StrictMatchCount: response.diagnostics?.c3StrictMatchCount ?? null,
            catalogMatchesBeforeFallback:
              response.diagnostics?.catalogMatchesBeforeFallback ?? response.movies.length,
            supplementedByRuleBased:
              response.diagnostics?.supplementedByRuleBased ?? false,
            providerUsed: response.providerUsed,
            isFallback: response.isFallback,
            parsedItems: enrichedItems,
            shownMovies: response.movies.map((m) => ({
              id: m.id,
              tmdbId: m.tmdbId,
              title: m.title,
              titleEn: catalogByTmdbId.get(m.tmdbId)?.titleEn ?? null,
              releaseYear: extractReleaseYear(m.releaseDate),
              genres: m.genres.map((g) => g.name),
            })),
            error: null,
          };
          break;
        } catch (err: any) {
          const latencyMs = Date.now() - t0;
          const retryable = attempt < args.retries && isTransientError(err);
          if (retryable) {
            const backoffMs = String(err?.message ?? '').includes('429')
              ? 30000
              : 5000 * (attempt + 1);
            console.warn(
              `[bench] transient error on q#${task.query.id} ${task.strategy}/${task.model} r${task.repeat}: ${err?.message}. Retrying in ${backoffMs}ms...`,
            );
            await sleep(backoffMs);
            continue;
          }

          record = {
            timestamp: new Date().toISOString(),
            queryId: task.query.id,
            category: task.query.category,
            entryType: task.query.entryType,
            scenarioKey: task.query.scenarioKey ?? null,
            queryText: task.query.query,
            strategy: task.strategy,
            model: task.model,
            repeat: task.repeat,
            latencyMs,
            rawText: null,
            jsonValid: false,
            tokenUsage: null,
            promptChars: null,
            c3CandidateCount: null,
            c3StrictMatchCount: null,
            catalogMatchesBeforeFallback: 0,
            supplementedByRuleBased: false,
            providerUsed: null,
            isFallback: false,
            parsedItems: [],
            shownMovies: [],
            error: `${err?.response?.status ? `HTTP ${err.response.status}: ` : ''}${err?.message ?? 'unknown error'}`,
          };
        }
      }

      if (record) {
        fs.appendFileSync(args.outPath, JSON.stringify(record) + '\n', 'utf-8');
        console.log(
          `[${idx + 1}/${pending.length}] q#${record.queryId} ${record.strategy} ${record.model} r${record.repeat} -> ${record.error ? `ERR: ${record.error}` : `${record.latencyMs}ms catalog=${record.catalogMatchesBeforeFallback} fallback=${record.supplementedByRuleBased}`}`,
        );
      }
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[bench] fatal error:', err);
  process.exit(1);
});
