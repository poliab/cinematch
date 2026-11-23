import {
  RecommendationTokenUsage,
  RecommendedItemHint,
} from '../dto/recommendation-response.dto';

export interface ParsedAiPayload {
  items: RecommendedItemHint[];
  movieTmdbIds: number[];
  explanation?: string;
  jsonValid: boolean;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function parseYear(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1888 && value <= 2100) {
    return value;
  }
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{4})/);
    if (match) {
      const year = Number.parseInt(match[1], 10);
      if (year >= 1888 && year <= 2100) return year;
    }
  }
  return undefined;
}

export function stripJsonCodeFences(rawText: string): string {
  return rawText.replace(/```json?/gi, '').replace(/```/g, '').trim();
}

export function parseAiRecommendationJson(rawText: string): ParsedAiPayload {
  if (!rawText || !rawText.trim()) {
    return { items: [], movieTmdbIds: [], jsonValid: false };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stripJsonCodeFences(rawText));
  } catch {
    return { items: [], movieTmdbIds: [], jsonValid: false };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { items: [], movieTmdbIds: [], jsonValid: false };
  }

  const explanation =
    typeof parsed.explanation === 'string' && parsed.explanation.trim()
      ? parsed.explanation.trim()
      : undefined;

  const items: RecommendedItemHint[] = [];
  const movieTmdbIds: number[] = [];

  if (Array.isArray(parsed.items)) {
    for (const rawItem of parsed.items) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      const tmdbId = parsePositiveInt(rawItem.tmdbId ?? rawItem.id);
      const title =
        typeof rawItem.title === 'string' && rawItem.title.trim()
          ? rawItem.title.trim()
          : undefined;
      const year = parseYear(rawItem.year);

      if (tmdbId !== undefined || title !== undefined) {
        items.push({ tmdbId, title, year });
        if (tmdbId !== undefined) {
          movieTmdbIds.push(tmdbId);
        }
      }
    }
    return {
      items,
      movieTmdbIds,
      explanation,
      jsonValid: items.length > 0,
    };
  }

  // Fallback compatibility with legacy C1 shape: { tmdbIds: number[], explanation }
  if (Array.isArray(parsed.tmdbIds)) {
    for (const rawId of parsed.tmdbIds) {
      const tmdbId = parsePositiveInt(rawId);
      if (tmdbId !== undefined) {
        movieTmdbIds.push(tmdbId);
        items.push({ tmdbId });
      }
    }
    return {
      items,
      movieTmdbIds,
      explanation,
      jsonValid: movieTmdbIds.length > 0,
    };
  }

  return { items: [], movieTmdbIds: [], explanation, jsonValid: false };
}

export function normalizeGoogleTokenUsage(usageMetadata: any): RecommendationTokenUsage | undefined {
  if (!usageMetadata || typeof usageMetadata !== 'object') return undefined;
  return {
    promptTokens: typeof usageMetadata.promptTokenCount === 'number' ? usageMetadata.promptTokenCount : undefined,
    completionTokens:
      typeof usageMetadata.candidatesTokenCount === 'number'
        ? usageMetadata.candidatesTokenCount
        : undefined,
    totalTokens: typeof usageMetadata.totalTokenCount === 'number' ? usageMetadata.totalTokenCount : undefined,
  };
}

export function normalizeOpenAiTokenUsage(usage: any): RecommendationTokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  return {
    promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
  };
}
