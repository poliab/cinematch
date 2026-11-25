import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { RecommendationsService } from '../recommendations/recommendations.service';
import { GoogleAiProviderService } from '../recommendations/providers/google-ai-provider.service';
import { OpenRouterProviderService } from '../recommendations/providers/openrouter-provider.service';
import { CreateRecommendationDto } from '../recommendations/dto/create-recommendation.dto';
import { AiProviderRequestOptions } from '../recommendations/providers/ai-provider.interface';

export type FaultType = 'none' | 'timeout' | 'http_429' | 'http_500' | 'bad_json';
export type CascadeMode = 'no_fallback' | 'full_cascade';

interface CsvQueryRow {
  id: number;
  category: string;
  entryType: 'free_text' | 'quick_scenario';
  scenarioKey?: string;
  query: string;
}

export interface CascadeRecord {
  timestamp: string;
  scenario: string;
  mode: CascadeMode;
  primaryFaultRate: number;
  secondaryFaultRate: number;
  timeoutMs: number;
  queryId: number;
  category: string;
  injectedPrimaryFault: FaultType;
  injectedSecondaryFault: FaultType;
  providerUsed: string | null;
  isFallback: boolean;
  fromLlm: boolean;
  moviesCount: number;
  successMin3: boolean;
  jsonValid: boolean;
  latencyMs: number;
  error: string | null;
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

function loadQueries(csvPath: string): CsvQueryRow[] {
  const content = fs.readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = parseCsvLine(lines[0]);
  const col = (name: string) => headers.indexOf(name);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const get = (name: string) => (cells[col(name)] ?? '').trim();
    return {
      id: Number.parseInt(get('id'), 10),
      category: get('category'),
      entryType: (get('entry_type') || 'free_text') as 'free_text' | 'quick_scenario',
      scenarioKey: get('scenario_key') || undefined,
      query: get('query'),
    };
  });
}

function selectStratifiedQueries(queries: CsvQueryRow[], targetCount: number): CsvQueryRow[] {
  if (targetCount >= queries.length) return queries;
  const byCat = new Map<string, CsvQueryRow[]>();
  for (const q of queries) {
    const arr = byCat.get(q.category) ?? [];
    arr.push(q);
    byCat.set(q.category, arr);
  }
  const picked: CsvQueryRow[] = [];
  let idx = 0;
  while (picked.length < targetCount) {
    let addedInRound = false;
    for (const arr of byCat.values()) {
      if (idx < arr.length && picked.length < targetCount) {
        picked.push(arr[idx]);
        addedInRound = true;
      }
    }
    if (!addedInRound) break;
    idx++;
  }
  return picked.sort((a, b) => a.id - b.id);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAULT_TYPES: FaultType[] = ['timeout', 'http_429', 'http_500', 'bad_json'];

export function pickFault(rate: number, key: string, faultIndex: number): FaultType {
  if (rate <= 0) return 'none';
  if (rate < 1) {
    const rnd = mulberry32(hashSeed(key))();
    if (rnd >= rate) return 'none';
  }
  return FAULT_TYPES[faultIndex % FAULT_TYPES.length];
}

function makeFaultError(fault: FaultType, timeoutMs: number): Error {
  const err: any =
    fault === 'timeout'
      ? new Error(`timeout of ${timeoutMs}ms exceeded`)
      : fault === 'http_429'
        ? new Error('Request failed with status code 429')
        : new Error('Request failed with status code 500');
  if (fault === 'http_429') err.response = { status: 429 };
  if (fault === 'http_500') err.response = { status: 500 };
  if (fault === 'timeout') err.code = 'ECONNABORTED';
  return err;
}

interface CliArgs {
  queriesPath: string;
  outPath: string;
  limitQueries: number;
  scenarios?: Set<string>;
  delayMs: number;
  secondaryDelayMs: number;
  dryRun: boolean;
  resume: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      map.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (arg === '--dry-run' || arg === '--no-resume') {
      map.set(arg === '--no-resume' ? 'resume' : 'dry-run', arg === '--dry-run');
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      map.set(arg.slice(2), argv[++i]);
    }
  }
  const scenariosRaw = map.get('scenarios');
  const scenarios =
    typeof scenariosRaw === 'string' && scenariosRaw.trim()
      ? new Set(scenariosRaw.split(',').map((s) => s.trim()).filter(Boolean))
      : undefined;
  return {
    queriesPath: path.resolve(
      String(map.get('queries') ?? '../../cinematch-research/experiment/zapyty.csv'),
    ),
    outPath: path.resolve(
      String(map.get('out') ?? '../../cinematch-research/results/raw/cascade.jsonl'),
    ),
    limitQueries: Number.parseInt(String(map.get('limit-queries') ?? '30'), 10),
    scenarios,
    delayMs: Number.parseInt(String(map.get('delay-ms') ?? '4300'), 10),
    secondaryDelayMs: Number.parseInt(String(map.get('secondary-delay-ms') ?? '2000'), 10),
    dryRun: map.get('dry-run') === true,
    resume: map.get('resume') !== false,
  };
}

interface ScenarioConfig {
  name: string;
  mode: CascadeMode;
  primaryFaultRate: number;
  secondaryFaultRate: number;
  timeoutMs: number;
  queryCount?: number;
}

const SCENARIOS: ScenarioConfig[] = [
  { name: 'no_fallback_0pct', mode: 'no_fallback', primaryFaultRate: 0.0, secondaryFaultRate: 1.0, timeoutMs: 10000 },
  { name: 'no_fallback_20pct', mode: 'no_fallback', primaryFaultRate: 0.2, secondaryFaultRate: 1.0, timeoutMs: 10000 },
  { name: 'no_fallback_50pct', mode: 'no_fallback', primaryFaultRate: 0.5, secondaryFaultRate: 1.0, timeoutMs: 10000 },
  { name: 'no_fallback_100pct', mode: 'no_fallback', primaryFaultRate: 1.0, secondaryFaultRate: 1.0, timeoutMs: 10000 },
  { name: 'cascade_0pct', mode: 'full_cascade', primaryFaultRate: 0.0, secondaryFaultRate: 0.0, timeoutMs: 10000 },
  { name: 'cascade_20pct', mode: 'full_cascade', primaryFaultRate: 0.2, secondaryFaultRate: 0.0, timeoutMs: 10000 },
  { name: 'cascade_50pct', mode: 'full_cascade', primaryFaultRate: 0.5, secondaryFaultRate: 0.0, timeoutMs: 10000 },
  { name: 'cascade_100pct', mode: 'full_cascade', primaryFaultRate: 1.0, secondaryFaultRate: 0.0, timeoutMs: 10000 },
  { name: 'cascade_both_down', mode: 'full_cascade', primaryFaultRate: 1.0, secondaryFaultRate: 1.0, timeoutMs: 10000 },
  { name: 'cascade_50pct_t4000', mode: 'full_cascade', primaryFaultRate: 0.5, secondaryFaultRate: 0.0, timeoutMs: 4000, queryCount: 12 },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allQueries = loadQueries(args.queriesPath);
  const selectedScenarios = args.scenarios
    ? SCENARIOS.filter((s) => args.scenarios!.has(s.name))
    : SCENARIOS;

  const completedKeys = new Set<string>();
  if (args.resume && fs.existsSync(args.outPath)) {
    for (const line of fs.readFileSync(args.outPath, 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as CascadeRecord;
        completedKeys.add(`${rec.scenario}::${rec.queryId}`);
      } catch {
        // Ignore truncated trailing line
      }
    }
  }

  let plannedCount = 0;
  let estGoogleCalls = 0;
  let estOpenRouterCalls = 0;
  const pending: Array<{ scenario: ScenarioConfig; query: CsvQueryRow; idxInScenario: number }> = [];
  for (const scenario of selectedScenarios) {
    const qSlice = selectStratifiedQueries(allQueries, Math.min(args.limitQueries, scenario.queryCount ?? args.limitQueries));
    qSlice.forEach((query, idxInScenario) => {
      plannedCount++;
      if (!completedKeys.has(`${scenario.name}::${query.id}`)) {
        pending.push({ scenario, query, idxInScenario });
        const pf = pickFault(scenario.primaryFaultRate, `${scenario.primaryFaultRate}::${query.id}`, idxInScenario);
        const sf = pickFault(scenario.secondaryFaultRate, `sec::${scenario.secondaryFaultRate}::${query.id}`, idxInScenario);
        if (pf === 'none') estGoogleCalls++;
        else if (scenario.mode === 'full_cascade' && pf !== 'bad_json' && sf === 'none') estOpenRouterCalls++;
      }
    });
  }

  console.log(
    `[cascade] scenarios=${selectedScenarios.length} planned=${plannedCount} completed=${plannedCount - pending.length} pending=${pending.length} (estGoogle=${estGoogleCalls}, estOpenRouter=${estOpenRouterCalls})`,
  );
  console.log(`[cascade] output=${args.outPath}`);
  if (args.dryRun || pending.length === 0) return;

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const recommendationsService = app.get(RecommendationsService);
    const googleProvider = app.get(GoogleAiProviderService);
    const openRouterProvider = app.get(OpenRouterProviderService);

    const origGoogleGet = googleProvider.getRecommendations.bind(googleProvider);
    const origOpenRouterGet = openRouterProvider.getRecommendations.bind(openRouterProvider);

    let activePrimaryFault: FaultType = 'none';
    let activeSecondaryFault: FaultType = 'none';
    let activeTimeoutMs = 10000;

    (googleProvider as any).getRecommendations = async (
      prompt: string,
      options?: AiProviderRequestOptions,
    ) => {
      if (activePrimaryFault !== 'none') {
        if (activePrimaryFault === 'timeout') {
          await sleep(activeTimeoutMs);
          throw makeFaultError('timeout', activeTimeoutMs);
        }
        if (activePrimaryFault === 'bad_json') {
          await sleep(60);
          return {
            movieTmdbIds: [],
            items: [],
            explanation: '',
            providerUsed: 'google',
            isFallback: false,
            rawText: '{ "items": [broken',
            jsonValid: false,
          };
        }
        await sleep(50);
        throw makeFaultError(activePrimaryFault, activeTimeoutMs);
      }
      return origGoogleGet(prompt, { ...options, timeoutMs: activeTimeoutMs });
    };

    (openRouterProvider as any).getRecommendations = async (
      prompt: string,
      options?: AiProviderRequestOptions,
    ) => {
      if (activeSecondaryFault !== 'none') {
        if (activeSecondaryFault === 'timeout') {
          await sleep(activeTimeoutMs);
          throw makeFaultError('timeout', activeTimeoutMs);
        }
        if (activeSecondaryFault === 'bad_json') {
          await sleep(60);
          return {
            movieTmdbIds: [],
            items: [],
            explanation: '',
            providerUsed: 'openrouter',
            isFallback: false,
            rawText: '{ "items": [broken',
            jsonValid: false,
          };
        }
        await sleep(50);
        throw makeFaultError(activeSecondaryFault, activeTimeoutMs);
      }
      return origOpenRouterGet(prompt, { ...options, timeoutMs: activeTimeoutMs });
    };

    let lastGoogleRealCallAt = 0;
    let lastOpenRouterRealCallAt = 0;

    for (let i = 0; i < pending.length; i++) {
      const { scenario, query, idxInScenario } = pending[i];
      activePrimaryFault = pickFault(
        scenario.primaryFaultRate,
        `${scenario.primaryFaultRate}::${query.id}`,
        idxInScenario,
      );
      activeSecondaryFault = pickFault(
        scenario.secondaryFaultRate,
        `sec::${scenario.secondaryFaultRate}::${query.id}`,
        idxInScenario,
      );
      activeTimeoutMs = scenario.timeoutMs;

      // Apply RPM rate-limit sleeps BEFORE t0 so measured latencyMs excludes benchmark pacing.
      if (activePrimaryFault === 'none') {
        const gap = Date.now() - lastGoogleRealCallAt;
        if (gap < args.delayMs) {
          await sleep(args.delayMs - gap);
        }
        lastGoogleRealCallAt = Date.now();
      } else if (scenario.mode === 'full_cascade' && activeSecondaryFault === 'none') {
        const gap = Date.now() - lastOpenRouterRealCallAt;
        if (gap < args.secondaryDelayMs) {
          await sleep(args.secondaryDelayMs - gap);
        }
        lastOpenRouterRealCallAt = Date.now();
      }

      const dto: CreateRecommendationDto =
        query.entryType === 'quick_scenario' && query.scenarioKey
          ? { entryType: 'quick_scenario', scenarioKey: query.scenarioKey }
          : { entryType: 'free_text', freeTextPrompt: query.query };

      const t0 = Date.now();
      let record: CascadeRecord;

      try {
        const isNoFallback = scenario.mode === 'no_fallback';
        const res = await recommendationsService.getRecommendations(dto, undefined, 'uk', {
          strategyOverride: 'c3',
          primaryProviderOverride: 'google',
          enableFallbackOverride: !isNoFallback,
          throwOnFailure: isNoFallback,
          providerOptions: {
            model: 'gemini-3.5-flash-lite',
            temperature: 0.2,
            thinkingLevel: 'MINIMAL',
            timeoutMs: scenario.timeoutMs,
          },
        });
        const latencyMs = Date.now() - t0;

        // Under no_fallback, bad_json does not throw from provider but yields 0 local matches
        // before RuleBased rescue inside RecommendationsService.getRecommendations.
        const effectiveMoviesCount = isNoFallback
          ? res.diagnostics?.catalogMatchesBeforeFallback ?? 0
          : res.movies.length;
        const effectiveFromLlm = isNoFallback
          ? Boolean(res.diagnostics?.jsonValid) && effectiveMoviesCount >= 3
          : (res.providerUsed === 'google' || res.providerUsed === 'openrouter') &&
            !res.diagnostics?.supplementedByRuleBased;

        record = {
          timestamp: new Date().toISOString(),
          scenario: scenario.name,
          mode: scenario.mode,
          primaryFaultRate: scenario.primaryFaultRate,
          secondaryFaultRate: scenario.secondaryFaultRate,
          timeoutMs: scenario.timeoutMs,
          queryId: query.id,
          category: query.category,
          injectedPrimaryFault: activePrimaryFault,
          injectedSecondaryFault: activeSecondaryFault,
          providerUsed: res.providerUsed,
          isFallback: res.isFallback,
          fromLlm: effectiveFromLlm,
          moviesCount: effectiveMoviesCount,
          successMin3: effectiveMoviesCount >= 3,
          jsonValid: Boolean(res.diagnostics?.jsonValid),
          latencyMs,
          error: null,
        };
      } catch (err: any) {
        const latencyMs = Date.now() - t0;
        record = {
          timestamp: new Date().toISOString(),
          scenario: scenario.name,
          mode: scenario.mode,
          primaryFaultRate: scenario.primaryFaultRate,
          secondaryFaultRate: scenario.secondaryFaultRate,
          timeoutMs: scenario.timeoutMs,
          queryId: query.id,
          category: query.category,
          injectedPrimaryFault: activePrimaryFault,
          injectedSecondaryFault: activeSecondaryFault,
          providerUsed: null,
          isFallback: false,
          fromLlm: false,
          moviesCount: 0,
          successMin3: false,
          jsonValid: false,
          latencyMs,
          error: `${err?.response?.status ? `HTTP ${err.response.status}: ` : ''}${err?.message ?? 'unknown error'}`,
        };
      }

      fs.appendFileSync(args.outPath, JSON.stringify(record) + '\n', 'utf-8');
      console.log(
        `[${i + 1}/${pending.length}] ${record.scenario} q#${record.queryId} pFault=${record.injectedPrimaryFault} -> prov=${record.providerUsed ?? 'ERR'} movies=${record.moviesCount} llm=${record.fromLlm} ${record.latencyMs}ms`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[cascade] fatal error:', err);
  process.exit(1);
});
