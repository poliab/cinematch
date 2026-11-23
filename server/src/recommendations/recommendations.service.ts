import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TmdbClientService } from '../tmdb/tmdb-client.service';
import { CreateRecommendationDto } from './dto/create-recommendation.dto';
import {
  RecommendationResponseDto,
  RecommendationMovieCard,
  NormalizedRecommendationResult,
  RecommendationStrategy,
  ResolvedItemTelemetry,
  RecommendedItemHint,
} from './dto/recommendation-response.dto';
import { GoogleAiProviderService } from './providers/google-ai-provider.service';
import { OpenRouterProviderService } from './providers/openrouter-provider.service';
import { RuleBasedRecommenderService } from './providers/rule-based-recommender.service';
import {
  AiProviderRequestOptions,
  RecommendationPromptBuilder,
} from './providers/ai-provider.interface';
import { RecommendationSessionRepository } from './recommendation-session.repository';
import {
  CatalogMovieCandidate,
  findBestCatalogMatch,
} from './movie-title-matcher';

export interface GetRecommendationsRunOptions {
  strategyOverride?: RecommendationStrategy;
  primaryProviderOverride?: 'google' | 'openrouter';
  enableFallbackOverride?: boolean;
  providerOptions?: AiProviderRequestOptions;
}

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly google: GoogleAiProviderService,
    private readonly openRouter: OpenRouterProviderService,
    private readonly ruleBased: RuleBasedRecommenderService,
    private readonly promptBuilder: RecommendationPromptBuilder,
    private readonly sessionRepo: RecommendationSessionRepository,
    @Optional() private readonly tmdbClient?: TmdbClientService,
  ) {}

  async getRecommendations(
    dto: CreateRecommendationDto,
    userId?: number,
    lang = 'uk',
    runOptions?: GetRecommendationsRunOptions,
  ): Promise<RecommendationResponseDto> {
    const userContext = userId ? await this.resolveUserContext(userId) : null;
    const strategy = this.resolveStrategy(runOptions?.strategyOverride ?? dto.strategy);

    const genreName = dto.genreId
      ? (await this.prisma.genre.findUnique({ where: { id: dto.genreId } }))?.name
      : undefined;

    const seedMovieTitle = dto.seedMovieId
      ? (await this.prisma.movie.findUnique({ where: { id: dto.seedMovieId } }))?.title
      : undefined;

    if (strategy === 'rule_based') {
      const ruleResult = await this.ruleBased.getRecommendations({
        genreId: dto.genreId,
        seedMovieId: dto.seedMovieId,
        excludeMovieIds: userContext?.watchedMovieIds,
        moodInput: dto.moodInput,
        scenarioKey: dto.scenarioKey,
        freeTextPrompt: dto.freeTextPrompt,
        refinements: dto.refinements as Record<string, boolean> | undefined,
        limit: 8,
      });
      const movies = await this.resolveMovies(
        ruleResult.movieTmdbIds,
        userContext?.watchedMovieIds ?? [],
        dto.genreId,
        lang,
      );
      return {
        sessionId: null,
        explanation: ruleResult.explanation,
        providerUsed: 'rule_based',
        isFallback: true,
        strategyUsed: 'rule_based',
        movies,
        refinementOptions: this.getRefinementOptions(dto),
        diagnostics: {
          strategyUsed: 'rule_based',
          jsonValid: true,
          catalogMatchesBeforeFallback: movies.length,
          supplementedByRuleBased: false,
          resolvedItems: movies.map((m) => ({
            inputTmdbId: m.tmdbId,
            inputTitle: m.title,
            matchedInCatalog: true,
            catalogTmdbId: m.tmdbId,
            matchTier: 'tmdb_id',
            existsInTmdb: true,
          })),
        },
      };
    }

    const prompt = this.promptBuilder.buildPrompt(
      {
        entryType: dto.entryType,
        scenarioKey: dto.scenarioKey,
        moodInput: dto.moodInput,
        freeTextPrompt: dto.freeTextPrompt,
        genreName,
        seedMovieTitle,
        favoriteGenreNames: userContext?.favoriteGenreNames,
        watchedCount: userContext?.watchedMovieIds.length,
        refinements: dto.refinements as Record<string, boolean> | undefined,
      },
      strategy,
    );

    const primaryProvider =
      runOptions?.primaryProviderOverride ??
      (this.config.get<string>('ai.primaryProvider') as 'google' | 'openrouter' | undefined) ??
      'google';
    const enableFallback =
      runOptions?.enableFallbackOverride ??
      this.config.get<boolean>('ai.enableFallback') ??
      true;

    let sessionId: number | null = null;
    if (userId) {
      try {
        const session = await this.sessionRepo.createSession({
          userId,
          entryType: dto.entryType,
          providerUsed: primaryProvider,
          isFallback: false,
        });
        sessionId = session.id;
      } catch (err: any) {
        this.logger.warn(`Failed to pre-create recommendation session: ${err?.message}`);
      }
    }

    const result = await this.tryProvider(
      primaryProvider,
      prompt,
      enableFallback,
      sessionId ?? undefined,
      runOptions?.providerOptions,
    );

    const watchedIds = userContext?.watchedMovieIds ?? [];
    const { matchedTmdbIds, resolvedItems } = await this.resolveStrategyOutput(
      strategy,
      result,
    );

    let movies = await this.resolveMovies(
      matchedTmdbIds,
      watchedIds,
      dto.genreId,
      lang,
    );

    const catalogMatchesBeforeFallback = movies.length;
    let supplementedByRuleBased = false;
    let finalResult = result;

    if (movies.length < 3) {
      supplementedByRuleBased = true;
      this.logger.log('AI result had too few local matches — supplementing with rule-based');
      const ruleResult = await this.ruleBased.getRecommendations({
        genreId: dto.genreId,
        seedMovieId: dto.seedMovieId,
        excludeMovieIds: watchedIds,
        moodInput: dto.moodInput,
        scenarioKey: dto.scenarioKey,
        freeTextPrompt: dto.freeTextPrompt,
        refinements: dto.refinements as Record<string, boolean> | undefined,
        limit: 8,
      });

      const ruleMovies = await this.resolveMovies(
        ruleResult.movieTmdbIds,
        watchedIds,
        dto.genreId,
        lang,
      );

      const existingIds = new Set(movies.map((m) => m.id));
      const supplementary = ruleMovies.filter((m) => !existingIds.has(m.id));
      movies = [...movies, ...supplementary].slice(0, 8);

      if (!finalResult || catalogMatchesBeforeFallback === 0) {
        finalResult = ruleResult;
      }
    }

    if (userId && finalResult && sessionId) {
      try {
        await this.prisma.recommendationSession.update({
          where: { id: sessionId },
          data: { providerUsed: finalResult.providerUsed, isFallback: finalResult.isFallback },
        });

        const request = await this.sessionRepo.createRequest({
          sessionId,
          scenarioKey: dto.scenarioKey,
          moodInput: dto.moodInput,
          freeTextPrompt: dto.freeTextPrompt,
          genreId: dto.genreId,
          seedMovieId: dto.seedMovieId,
        });

        if (movies.length > 0) {
          await this.sessionRepo.createResults(request.id, movies);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to persist recommendation session: ${err?.message}`);
      }
    }

    const modelUsed =
      runOptions?.providerOptions?.model ??
      (finalResult?.providerUsed === 'google'
        ? this.config.get<string>('ai.google.model')
        : finalResult?.providerUsed === 'openrouter'
          ? this.config.get<string>('ai.openrouter.model')
          : undefined);

    return {
      sessionId,
      explanation: finalResult?.explanation ?? 'Movies selected for you.',
      providerUsed: finalResult?.providerUsed ?? 'rule_based',
      isFallback: finalResult?.isFallback ?? true,
      strategyUsed: strategy,
      movies,
      refinementOptions: this.getRefinementOptions(dto),
      diagnostics: {
        strategyUsed: strategy,
        modelUsed,
        rawText: result?.rawText,
        jsonValid: result?.jsonValid ?? false,
        tokenUsage: result?.tokenUsage,
        catalogMatchesBeforeFallback,
        supplementedByRuleBased,
        resolvedItems,
      },
    };
  }

  private resolveStrategy(requested?: string): RecommendationStrategy {
    const raw = (requested ?? this.config.get<string>('ai.strategy') ?? 'c1').toLowerCase();
    if (raw === 'c2' || raw === 'c3' || raw === 'rule_based') {
      return raw;
    }
    return 'c1';
  }

  private async resolveStrategyOutput(
    strategy: RecommendationStrategy,
    result: NormalizedRecommendationResult,
  ): Promise<{ matchedTmdbIds: number[]; resolvedItems: ResolvedItemTelemetry[] }> {
    if (!result || result.providerUsed === 'rule_based') {
      const ids = this.uniqueNumbers(result?.movieTmdbIds ?? []);
      return {
        matchedTmdbIds: ids,
        resolvedItems: ids.map((tmdbId) => ({
          inputTmdbId: tmdbId,
          matchedInCatalog: true,
          catalogTmdbId: tmdbId,
          matchTier: 'tmdb_id',
        })),
      };
    }

    if (strategy === 'c2') {
      const hints = (result.items ?? []).filter((i) => i.title);
      return this.resolveC2Items(hints);
    }

    // Strategy C1 (and default fallback): resolve numeric tmdbIds against local catalog, keeping title hints for telemetry.
    const rawIds = this.uniqueNumbers(result.movieTmdbIds ?? []);
    const existingMovies = rawIds.length
      ? await this.prisma.movie.findMany({
          where: { tmdbId: { in: rawIds } },
          select: { tmdbId: true },
        })
      : [];
    const existingSet = new Set(existingMovies.map((m) => m.tmdbId));

    const itemHints: RecommendedItemHint[] =
      result.items?.length ? result.items : rawIds.map((tmdbId) => ({ tmdbId }));

    const resolvedItems: ResolvedItemTelemetry[] = itemHints.map((hint) => ({
      inputTmdbId: hint.tmdbId,
      inputTitle: hint.title,
      matchedInCatalog: hint.tmdbId !== undefined && existingSet.has(hint.tmdbId),
      catalogTmdbId:
        hint.tmdbId !== undefined && existingSet.has(hint.tmdbId) ? hint.tmdbId : undefined,
      matchTier: hint.tmdbId !== undefined && existingSet.has(hint.tmdbId) ? 'tmdb_id' : undefined,
    }));

    return { matchedTmdbIds: rawIds, resolvedItems };
  }

  private async resolveC2Items(
    items: RecommendedItemHint[],
  ): Promise<{ matchedTmdbIds: number[]; resolvedItems: ResolvedItemTelemetry[] }> {
    if (!items.length) {
      return { matchedTmdbIds: [], resolvedItems: [] };
    }

    const catalogMovies: CatalogMovieCandidate[] = await this.prisma.movie.findMany({
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
    const catalogByTmdbId = new Map(catalogMovies.map((m) => [m.tmdbId, m]));

    const matchedTmdbIds: number[] = [];
    const seenTmdbIds = new Set<number>();
    const resolvedItems: ResolvedItemTelemetry[] = [];

    for (const item of items) {
      const title = item.title?.trim();
      if (!title) continue;

      const localMatch = findBestCatalogMatch(title, item.year, catalogMovies);
      if (localMatch) {
        const tmdbId = localMatch.candidate.tmdbId;
        if (!seenTmdbIds.has(tmdbId)) {
          seenTmdbIds.add(tmdbId);
          matchedTmdbIds.push(tmdbId);
        }
        resolvedItems.push({
          inputTitle: title,
          inputYear: item.year,
          matchedInCatalog: true,
          catalogTmdbId: tmdbId,
          matchTier: localMatch.tier,
          existsInTmdb: true,
        });
        continue;
      }

      const tmdbCheck = await this.lookupInTmdb(title, item.year);
      if (tmdbCheck.tmdbId !== undefined) {
        const aliasInCatalog = catalogByTmdbId.get(tmdbCheck.tmdbId);
        if (aliasInCatalog) {
          if (!seenTmdbIds.has(aliasInCatalog.tmdbId)) {
            seenTmdbIds.add(aliasInCatalog.tmdbId);
            matchedTmdbIds.push(aliasInCatalog.tmdbId);
          }
          resolvedItems.push({
            inputTitle: title,
            inputYear: item.year,
            matchedInCatalog: true,
            catalogTmdbId: aliasInCatalog.tmdbId,
            matchTier: 'tmdb_alias',
            existsInTmdb: true,
            tmdbLookupId: tmdbCheck.tmdbId,
            tmdbLookupTitle: tmdbCheck.tmdbTitle,
          });
          continue;
        }
      }

      resolvedItems.push({
        inputTitle: title,
        inputYear: item.year,
        matchedInCatalog: false,
        existsInTmdb: tmdbCheck.existsInTmdb,
        tmdbLookupId: tmdbCheck.tmdbId,
        tmdbLookupTitle: tmdbCheck.tmdbTitle,
        tmdbLookupFailed: tmdbCheck.lookupFailed,
      });
    }

    return { matchedTmdbIds, resolvedItems };
  }

  private async lookupInTmdb(
    title: string,
    year?: number,
  ): Promise<{
    existsInTmdb: boolean;
    tmdbId?: number;
    tmdbTitle?: string;
    lookupFailed?: boolean;
  }> {
    if (!this.tmdbClient) {
      return { existsInTmdb: false, lookupFailed: true };
    }

    let search = await this.tmdbClient.searchMovies(title, year, 'en-US');
    if (search.lookupFailed) {
      return { existsInTmdb: false, lookupFailed: true };
    }

    // TMDb `year` query param is exact; retry once without year so ±1 year release shifts match.
    if (search.results.length === 0 && year !== undefined) {
      search = await this.tmdbClient.searchMovies(title, undefined, 'en-US');
      if (search.lookupFailed) {
        return { existsInTmdb: false, lookupFailed: true };
      }
    }

    const tmdbCandidates: CatalogMovieCandidate[] = search.results
      .filter((r) => typeof r?.id === 'number')
      .map((r) => ({
        id: r.id,
        tmdbId: r.id,
        title: r.title ?? '',
        titleEn: r.original_title ?? r.title,
        releaseDate: r.release_date,
        popularity: r.popularity ?? 0,
        voteCount: r.vote_count ?? 0,
      }));

    const best = findBestCatalogMatch(title, year, tmdbCandidates);
    if (!best) {
      return { existsInTmdb: false };
    }

    return {
      existsInTmdb: true,
      tmdbId: best.candidate.tmdbId,
      tmdbTitle: best.candidate.titleEn ?? best.candidate.title,
    };
  }

  private uniqueNumbers(values: number[]): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const v of values) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }

  async getUserHistory(userId: number, lang = 'uk') {
    const sessions = await this.sessionRepo.getUserHistory(userId);
    const isEn = lang.startsWith('en');
    return sessions.map((s) => {
      const mappedRequests = s.requests.map((r) => {
        const mappedResults = r.results.map((res) => {
          if (!res.movie) return res;
          return {
            ...res,
            movie: {
              ...res.movie,
              title: (isEn && res.movie.titleEn) ? res.movie.titleEn : res.movie.title,
              posterPath: (isEn && res.movie.posterPathEn) ? res.movie.posterPathEn : res.movie.posterPath,
            },
          };
        });
        return {
          ...r,
          results: mappedResults,
        };
      });
      return {
        ...s,
        requests: mappedRequests,
      };
    });
  }

  async getSessionDetail(sessionId: number, userId: number, lang = 'uk') {
    const session = await this.sessionRepo.getSessionDetail(sessionId, userId);
    if (!session) return null;
    const isEn = lang.startsWith('en');
    const mappedRequests = session.requests.map((r) => {
      const mappedResults = r.results.map((res) => {
        if (!res.movie) return res;
        return {
          ...res,
          movie: {
            ...res.movie,
            title: (isEn && res.movie.titleEn) ? res.movie.titleEn : res.movie.title,
            overview: (isEn && res.movie.overviewEn) ? res.movie.overviewEn : res.movie.overview,
            posterPath: (isEn && res.movie.posterPathEn) ? res.movie.posterPathEn : res.movie.posterPath,
            backdropPath: (isEn && res.movie.backdropPathEn) ? res.movie.backdropPathEn : res.movie.backdropPath,
          },
        };
      });
      return {
        ...r,
        results: mappedResults,
      };
    });
    return {
      ...session,
      requests: mappedRequests,
    };
  }

  private async tryProvider(
    provider: 'google' | 'openrouter',
    prompt: string,
    enableFallback: boolean,
    sessionId?: number,
    providerOptions?: AiProviderRequestOptions,
  ): Promise<NormalizedRecommendationResult> {
    const primary = provider === 'google' ? this.google : this.openRouter;
    const secondary = provider === 'google' ? this.openRouter : this.google;

    const t0 = Date.now();
    try {
      const result = await primary.getRecommendations(prompt, providerOptions);
      if (sessionId) {
        this.sessionRepo
          .logAiProvider({ sessionId, provider, latencyMs: Date.now() - t0, status: 'success' })
          .catch((e: any) => this.logger.warn(`logAiProvider failed: ${e?.message}`));
      }
      return result;
    } catch (primaryErr: any) {
      this.logger.warn(`Primary provider (${provider}) failed: ${primaryErr?.message}`);
      if (sessionId) {
        this.sessionRepo
          .logAiProvider({ sessionId, provider, latencyMs: Date.now() - t0, status: 'error', errorMessage: primaryErr?.message })
          .catch((e: any) => this.logger.warn(`logAiProvider failed: ${e?.message}`));
      }

      if (enableFallback) {
        const secondaryName = provider === 'google' ? 'openrouter' : 'google';
        this.logger.log(`Trying secondary provider: ${secondaryName}`);
        const t1 = Date.now();
        try {
          const result = await secondary.getRecommendations(prompt);
          if (sessionId) {
            this.sessionRepo
              .logAiProvider({ sessionId, provider: secondaryName, latencyMs: Date.now() - t1, status: 'success' })
              .catch((e: any) => this.logger.warn(`logAiProvider failed: ${e?.message}`));
          }
          return result;
        } catch (secondaryErr: any) {
          this.logger.warn(`Secondary provider failed: ${secondaryErr?.message}`);
          if (sessionId) {
            this.sessionRepo
              .logAiProvider({ sessionId, provider: secondaryName, latencyMs: Date.now() - t1, status: 'error', errorMessage: secondaryErr?.message })
              .catch((e: any) => this.logger.warn(`logAiProvider failed: ${e?.message}`));
          }
        }
      }

      this.logger.log('All AI providers failed — using rule-based fallback');
      return this.ruleBased.getRecommendations({
        scenarioKey: undefined,
        limit: 8,
      });
    }
  }

  private async resolveMovies(
    tmdbIds: number[],
    excludeWatchedIds: number[],
    genreId?: number,
    lang = 'uk',
  ): Promise<RecommendationMovieCard[]> {
    if (!tmdbIds.length) return [];

    const movies = await this.prisma.movie.findMany({
      where: {
        tmdbId: { in: tmdbIds },
        id: excludeWatchedIds.length > 0 ? { notIn: excludeWatchedIds } : undefined,
      },
      include: {
        genres: {
          include: { genre: true },
        },
      },
    });

    const movieMap = new Map(movies.map((m) => [m.tmdbId, m]));
    return tmdbIds
      .map((tmdbId) => movieMap.get(tmdbId))
      .filter(Boolean)
      .map((m) => ({
        id: m!.id,
        tmdbId: m!.tmdbId,
        title: (lang.startsWith('en') && m!.titleEn) ? m!.titleEn : m!.title,
        overview: (lang.startsWith('en') && m!.overviewEn) ? m!.overviewEn : m!.overview,
        posterPath: (lang.startsWith('en') && m!.posterPathEn) ? m!.posterPathEn : m!.posterPath,
        backdropPath: (lang.startsWith('en') && m!.backdropPathEn) ? m!.backdropPathEn : m!.backdropPath,
        voteAverage: m!.voteAverage,
        releaseDate: m!.releaseDate?.toISOString().split('T')[0] ?? null,
        genres: m!.genres.map((mg) => ({ id: mg.genre.id, name: mg.genre.name })),
      })) as RecommendationMovieCard[];
  }

  private async resolveUserContext(userId: number) {
    const [watched, preferences] = await Promise.all([
      this.prisma.watchedMovie.findMany({
        where: { userId },
        select: { movieId: true },
      }),
      this.prisma.userPreference.findMany({
        where: { userId, weight: { gte: 0.5 } },
        include: { genre: true },
        orderBy: { weight: 'desc' },
        take: 5,
      }),
    ]);

    return {
      watchedMovieIds: watched.map((w) => w.movieId),
      favoriteGenreNames: preferences.map((p) => p.genre.name),
    };
  }

  private getRefinementOptions(dto: CreateRecommendationDto): string[] {
    const base = ['lighter', 'darker', 'newer', 'more_serious', 'less_romantic'];
    const applied = Object.entries(dto.refinements ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k);
    return base.filter((r) => !applied.includes(r));
  }
}
