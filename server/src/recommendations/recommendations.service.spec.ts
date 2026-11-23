import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RecommendationsService } from './recommendations.service';
import { GoogleAiProviderService } from './providers/google-ai-provider.service';
import { OpenRouterProviderService } from './providers/openrouter-provider.service';
import { RuleBasedRecommenderService } from './providers/rule-based-recommender.service';
import { RecommendationPromptBuilder } from './providers/ai-provider.interface';
import { RecommendationSessionRepository } from './recommendation-session.repository';
import { PrismaService } from '../prisma/prisma.service';
import { TmdbClientService } from '../tmdb/tmdb-client.service';

const aiResult = {
  movieTmdbIds: [550],
  items: [{ tmdbId: 550, title: 'Fight Club' }],
  explanation: 'Great pick',
  providerUsed: 'google' as const,
  isFallback: false,
  jsonValid: true,
};

const ruleResult = {
  movieTmdbIds: [123],
  explanation: 'Rule-based',
  providerUsed: 'rule_based' as const,
  isFallback: true,
};

describe('RecommendationsService', () => {
  let service: RecommendationsService;
  let google: jest.Mocked<GoogleAiProviderService>;
  let openRouter: jest.Mocked<OpenRouterProviderService>;
  let ruleBased: jest.Mocked<RuleBasedRecommenderService>;
  let promptBuilder: jest.Mocked<RecommendationPromptBuilder>;
  let prisma: {
    genre: { findUnique: jest.Mock };
    movie: { findUnique: jest.Mock; findMany: jest.Mock };
    watchedMovie: { findMany: jest.Mock };
    userPreference: { findMany: jest.Mock };
    recommendationSession: { update: jest.Mock };
  };
  let tmdbClient: jest.Mocked<TmdbClientService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationsService,
        {
          provide: GoogleAiProviderService,
          useValue: { getRecommendations: jest.fn() },
        },
        {
          provide: OpenRouterProviderService,
          useValue: { getRecommendations: jest.fn() },
        },
        {
          provide: RuleBasedRecommenderService,
          useValue: { getRecommendations: jest.fn() },
        },
        {
          provide: RecommendationPromptBuilder,
          useValue: { buildPrompt: jest.fn().mockReturnValue('test prompt') },
        },
        {
          provide: RecommendationSessionRepository,
          useValue: {
            logAiProvider: jest.fn().mockResolvedValue({}),
            createSession: jest.fn(),
            createRequest: jest.fn(),
            createResults: jest.fn(),
            getUserHistory: jest.fn(),
            getSessionDetail: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            genre: { findUnique: jest.fn() },
            movie: { findUnique: jest.fn(), findMany: jest.fn() },
            watchedMovie: { findMany: jest.fn() },
            userPreference: { findMany: jest.fn() },
            recommendationSession: { update: jest.fn() },
          },
        },
        {
          provide: TmdbClientService,
          useValue: { searchMovies: jest.fn().mockResolvedValue({ results: [] }) },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'ai.primaryProvider') return 'google';
              if (key === 'ai.enableFallback') return true;
              if (key === 'ai.strategy') return 'c1';
              if (key === 'ai.google.model') return 'gemini-3.5-flash-lite';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<RecommendationsService>(RecommendationsService);
    google = module.get(GoogleAiProviderService);
    openRouter = module.get(OpenRouterProviderService);
    ruleBased = module.get(RuleBasedRecommenderService);
    promptBuilder = module.get(RecommendationPromptBuilder);
    prisma = module.get(PrismaService);
    tmdbClient = module.get(TmdbClientService);
  });

  describe('tryProvider()', () => {
    const callTryProvider = (
      svc: RecommendationsService,
      provider: 'google' | 'openrouter',
      enableFallback: boolean,
    ) => (svc as any).tryProvider(provider, 'test prompt', enableFallback);

    it('Case 1: primary provider succeeds → returns AI result', async () => {
      google.getRecommendations.mockResolvedValue(aiResult as any);

      const result = await callTryProvider(service, 'google', true);

      expect(result).toEqual(aiResult);
      expect(google.getRecommendations).toHaveBeenCalledTimes(1);
      expect(openRouter.getRecommendations).not.toHaveBeenCalled();
    });

    it('Case 2: primary fails, secondary succeeds → falls back to secondary', async () => {
      const secondaryResult = { ...aiResult, providerUsed: 'openrouter' };
      google.getRecommendations.mockRejectedValue(new Error('Google down'));
      openRouter.getRecommendations.mockResolvedValue(secondaryResult as any);

      const result = await callTryProvider(service, 'google', true);

      expect(result).toEqual(secondaryResult);
      expect(google.getRecommendations).toHaveBeenCalledTimes(1);
      expect(openRouter.getRecommendations).toHaveBeenCalledTimes(1);
      expect(ruleBased.getRecommendations).not.toHaveBeenCalled();
    });

    it('Case 3: both providers fail → falls back to rule-based', async () => {
      google.getRecommendations.mockRejectedValue(new Error('Google down'));
      openRouter.getRecommendations.mockRejectedValue(new Error('OpenRouter down'));
      ruleBased.getRecommendations.mockResolvedValue(ruleResult as any);

      const result = await callTryProvider(service, 'google', true);

      expect(result).toEqual(ruleResult);
      expect(ruleBased.getRecommendations).toHaveBeenCalledTimes(1);
    });

    it('Case 4: fallback disabled, primary fails → goes straight to rule-based', async () => {
      google.getRecommendations.mockRejectedValue(new Error('Google down'));
      ruleBased.getRecommendations.mockResolvedValue(ruleResult as any);

      const result = await callTryProvider(service, 'google', false);

      expect(result).toEqual(ruleResult);
      expect(openRouter.getRecommendations).not.toHaveBeenCalled();
      expect(ruleBased.getRecommendations).toHaveBeenCalledTimes(1);
    });
  });

  describe('Strategies C1 and C2', () => {
    const makeDbMovie = (id: number, tmdbId: number, titleEn: string, year: number) => ({
      id,
      tmdbId,
      title: titleEn,
      titleEn,
      overview: null,
      overviewEn: null,
      posterPath: '/p.jpg',
      posterPathEn: '/p.jpg',
      backdropPath: null,
      backdropPathEn: null,
      voteAverage: 8.1,
      voteCount: 5000,
      popularity: 30,
      releaseDate: new Date(`${year}-05-01T00:00:00Z`),
      genres: [],
    });

    it('C2 matches catalog movies by title/year and checks TMDb for missing items without showing them', async () => {
      const m1 = makeDbMovie(1, 157336, 'Interstellar', 2014);
      const m2 = makeDbMovie(2, 603, 'The Matrix', 1999);
      const m3 = makeDbMovie(3, 27205, 'Inception', 2010);

      google.getRecommendations.mockResolvedValue({
        movieTmdbIds: [],
        items: [
          { title: 'Interstellar', year: 2014 },
          { title: 'Matrix', year: 1999 },
          { title: 'Inception', year: 2011 },
          { title: 'Obscure Real TMDb Film', year: 2022 },
          { title: 'Completely Made Up Movie', year: 2023 },
        ],
        explanation: 'Selected sci-fi films.',
        providerUsed: 'google',
        isFallback: false,
        jsonValid: true,
      });

      prisma.movie.findMany
        // 1st call: load catalog candidates for C2 matching
        .mockResolvedValueOnce([m1, m2, m3])
        // 2nd call: resolveMovies for matched IDs [157336, 603, 27205]
        .mockResolvedValueOnce([m1, m2, m3]);

      tmdbClient.searchMovies
        .mockResolvedValueOnce({
          results: [
            {
              id: 999001,
              title: 'Obscure Real TMDb Film',
              original_title: 'Obscure Real TMDb Film',
              release_date: '2022-06-10',
              vote_count: 200,
              popularity: 5,
            },
          ],
        })
        .mockResolvedValueOnce({ results: [] });

      const res = await service.getRecommendations(
        { entryType: 'free_text', freeTextPrompt: 'sci-fi', strategy: 'c2' },
        undefined,
        'uk',
      );

      expect(promptBuilder.buildPrompt).toHaveBeenCalledWith(expect.any(Object), 'c2');
      expect(res.strategyUsed).toBe('c2');
      expect(res.movies.map((m) => m.tmdbId)).toEqual([157336, 603, 27205]);
      expect(ruleBased.getRecommendations).not.toHaveBeenCalled();
      expect(res.diagnostics?.resolvedItems).toEqual([
        expect.objectContaining({
          inputTitle: 'Interstellar',
          matchedInCatalog: true,
          catalogTmdbId: 157336,
          existsInTmdb: true,
        }),
        expect.objectContaining({
          inputTitle: 'Matrix',
          matchedInCatalog: true,
          catalogTmdbId: 603,
          matchTier: 'article_stripped',
          existsInTmdb: true,
        }),
        expect.objectContaining({
          inputTitle: 'Inception',
          matchedInCatalog: true,
          catalogTmdbId: 27205,
          existsInTmdb: true,
        }),
        expect.objectContaining({
          inputTitle: 'Obscure Real TMDb Film',
          matchedInCatalog: false,
          existsInTmdb: true,
          tmdbLookupId: 999001,
        }),
        expect.objectContaining({
          inputTitle: 'Completely Made Up Movie',
          matchedInCatalog: false,
          existsInTmdb: false,
        }),
      ]);
    });

    it('C1 preserves predicted title hints in diagnostics while resolving tmdbIds as before', async () => {
      const m1 = makeDbMovie(1, 155, 'The Dark Knight', 2008);
      const m2 = makeDbMovie(2, 603, 'The Matrix', 1999);
      const m3 = makeDbMovie(3, 27205, 'Inception', 2010);

      google.getRecommendations.mockResolvedValue({
        movieTmdbIds: [155, 603, 27205],
        items: [
          { tmdbId: 155, title: 'Interstellar' }, // swapped movie ID vs title!
          { tmdbId: 603, title: 'The Matrix' },
          { tmdbId: 27205, title: 'Inception' },
        ],
        explanation: 'Selected films.',
        providerUsed: 'google',
        isFallback: false,
        jsonValid: true,
      });

      prisma.movie.findMany
        .mockResolvedValueOnce([{ tmdbId: 155 }, { tmdbId: 603 }, { tmdbId: 27205 }])
        .mockResolvedValueOnce([m1, m2, m3]);

      const res = await service.getRecommendations(
        { entryType: 'free_text', freeTextPrompt: 'sci-fi' },
        undefined,
        'uk',
      );

      expect(res.strategyUsed).toBe('c1');
      expect(res.movies.map((m) => m.tmdbId)).toEqual([155, 603, 27205]);
      expect(res.diagnostics?.resolvedItems[0]).toEqual({
        inputTmdbId: 155,
        inputTitle: 'Interstellar',
        matchedInCatalog: true,
        catalogTmdbId: 155,
        matchTier: 'tmdb_id',
      });
    });
  });
});
