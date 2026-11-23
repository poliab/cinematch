export interface CatalogMovieCandidate {
  id: number;
  tmdbId: number;
  title: string;
  titleEn?: string | null;
  releaseDate?: Date | string | null;
  popularity?: number;
  voteCount?: number;
}

export interface TitleMatchResult<T extends CatalogMovieCandidate = CatalogMovieCandidate> {
  candidate: T;
  tier: 'exact' | 'article_stripped' | 'subtitle';
  yearDiff: number | null;
}

const LEADING_ARTICLE_RE = /^(?:the|a|an)\s+/i;

export function normalizeMovieTitle(
  raw: string,
  options?: { stripArticles?: boolean },
): string {
  // Fold Latin diacritics (e.g. "Amélie" -> "Amelie") without decomposing Cyrillic letters like "й"/"ї".
  let text = raw
    .normalize('NFKC')
    .replace(/[A-Za-z\u00C0-\u024F]/g, (ch) =>
      ch.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
    )
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (options?.stripArticles) {
    text = text.replace(LEADING_ARTICLE_RE, '').trim();
  }
  return text;
}

export function extractMainTitle(raw: string): string | null {
  const trimmed = raw.trim();
  const splitMatch = trimmed.match(/^(.+?)(?:\s*:\s*|\s+[-–—]\s+|\s*\()/);
  if (!splitMatch) return null;
  const base = splitMatch[1].trim();
  return base.length >= 3 ? base : null;
}

export function extractReleaseYear(releaseDate?: Date | string | null): number | null {
  if (!releaseDate) return null;
  if (releaseDate instanceof Date) {
    return Number.isNaN(releaseDate.getTime()) ? null : releaseDate.getUTCFullYear();
  }
  const match = String(releaseDate).trim().match(/^(\d{4})/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  return year >= 1888 && year <= 2100 ? year : null;
}

function getTitleVariants(title?: string | null): {
  exact: string;
  noArticle: string;
  mainNoArticle: string | null;
} | null {
  if (!title || !title.trim()) return null;
  const exact = normalizeMovieTitle(title);
  if (!exact) return null;
  const noArticle = normalizeMovieTitle(title, { stripArticles: true });
  const mainRaw = extractMainTitle(title);
  const mainNoArticle = mainRaw ? normalizeMovieTitle(mainRaw, { stripArticles: true }) : null;
  return {
    exact,
    noArticle,
    mainNoArticle: mainNoArticle && mainNoArticle.length >= 3 ? mainNoArticle : null,
  };
}

function scoreTitleMatch(
  queryTitle: string,
  candidateTitle?: string | null,
): 'exact' | 'article_stripped' | 'subtitle' | null {
  const q = getTitleVariants(queryTitle);
  const c = getTitleVariants(candidateTitle);
  if (!q || !c) return null;

  if (q.exact === c.exact) return 'exact';
  if (q.noArticle === c.noArticle) return 'article_stripped';

  if (
    (q.mainNoArticle && q.mainNoArticle === c.noArticle) ||
    (c.mainNoArticle && c.mainNoArticle === q.noArticle) ||
    (q.mainNoArticle && c.mainNoArticle && q.mainNoArticle === c.mainNoArticle)
  ) {
    return 'subtitle';
  }
  return null;
}

const TIER_RANK: Record<TitleMatchResult['tier'], number> = {
  exact: 3,
  article_stripped: 2,
  subtitle: 1,
};

/**
 * Matches a movie title (plus optional release year) against catalog candidates.
 * Rejects candidates whose known release year differs by more than 1 year so distinct
 * remakes or sequels with similar titles are not confused.
 */
export function findBestCatalogMatch<T extends CatalogMovieCandidate>(
  queryTitle: string,
  queryYear: number | undefined,
  candidates: T[],
): TitleMatchResult<T> | null {
  if (!queryTitle || !queryTitle.trim() || candidates.length === 0) {
    return null;
  }

  let best: TitleMatchResult<T> | null = null;
  let bestScore: [number, number, number, number] = [-1, -1, -1, -1];

  for (const candidate of candidates) {
    const tierEn = scoreTitleMatch(queryTitle, candidate.titleEn);
    const tierUk = scoreTitleMatch(queryTitle, candidate.title);

    let tier: TitleMatchResult['tier'] | null = null;
    if (tierEn && tierUk) {
      tier = TIER_RANK[tierEn] >= TIER_RANK[tierUk] ? tierEn : tierUk;
    } else {
      tier = tierEn ?? tierUk;
    }

    if (!tier) continue;

    const candYear = extractReleaseYear(candidate.releaseDate);
    const yearDiff =
      queryYear !== undefined && candYear !== null ? Math.abs(queryYear - candYear) : null;

    if (yearDiff !== null && yearDiff > 1) {
      continue;
    }

    const yearScore = yearDiff === 0 ? 3 : yearDiff === 1 ? 2 : 1;
    const score: [number, number, number, number] = [
      TIER_RANK[tier],
      yearScore,
      candidate.voteCount ?? 0,
      candidate.popularity ?? 0,
    ];

    const isBetter =
      score[0] > bestScore[0] ||
      (score[0] === bestScore[0] &&
        (score[1] > bestScore[1] ||
          (score[1] === bestScore[1] &&
            (score[2] > bestScore[2] ||
              (score[2] === bestScore[2] && score[3] > bestScore[3])))));

    if (isBetter) {
      best = { candidate, tier, yearDiff };
      bestScore = score;
    }
  }

  return best;
}
