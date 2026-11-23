export type RecommendationStrategy = 'c1' | 'c2' | 'c3' | 'rule_based';

export interface RecommendedItemHint {
  tmdbId?: number;
  title?: string;
  year?: number;
}

export interface RecommendationTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface RecommendationMovieCard {
  id: number;
  tmdbId: number;
  title: string;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  voteAverage: number;
  releaseDate: string | null;
  genres: { id: number; name: string }[];
  explanation?: string;
}

export interface NormalizedRecommendationResult {
  movieTmdbIds: number[];
  items?: RecommendedItemHint[];
  explanation: string;
  providerUsed: 'google' | 'openrouter' | 'rule_based';
  isFallback: boolean;
  rawText?: string;
  jsonValid?: boolean;
  tokenUsage?: RecommendationTokenUsage;
}

export interface ResolvedItemTelemetry {
  inputTitle?: string;
  inputYear?: number;
  inputTmdbId?: number;
  matchedInCatalog: boolean;
  catalogTmdbId?: number;
  matchTier?: 'exact' | 'article_stripped' | 'subtitle' | 'tmdb_alias' | 'tmdb_id';
  existsInTmdb?: boolean;
  tmdbLookupId?: number;
  tmdbLookupTitle?: string;
  tmdbLookupFailed?: boolean;
}

export interface RecommendationDiagnostics {
  strategyUsed: RecommendationStrategy;
  modelUsed?: string;
  rawText?: string;
  jsonValid: boolean;
  tokenUsage?: RecommendationTokenUsage;
  catalogMatchesBeforeFallback: number;
  supplementedByRuleBased: boolean;
  resolvedItems: ResolvedItemTelemetry[];
}

export class RecommendationResponseDto {
  sessionId: number | null;
  explanation: string;
  providerUsed: 'google' | 'openrouter' | 'rule_based';
  isFallback: boolean;
  strategyUsed?: RecommendationStrategy;
  movies: RecommendationMovieCard[];
  refinementOptions: string[];
  diagnostics?: RecommendationDiagnostics;
}
